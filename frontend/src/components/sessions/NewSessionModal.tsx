// ── 新建会话（prompt-first 派活）/ 派生子会话 ──
// parent 非空 = 派生模式：同一张表单（目录默认父 cwd 可改、三选一、命名约定 prompt 全同款），
// 仅提交路由不同（fork / fork-worktree，meta 记父子关系）。两处不再各维护一份表单。
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { DirPicker, pushRecentDir, recentDirs } from './DirPicker'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { sessionLabel } from './session-label'
import { shellQuote as shq } from '../../shell-quote'
import { AutoComplete, Button, Checkbox, Input, Modal, Radio, Segmented, Select, Space, Tag, Tooltip, App as AntApp } from 'antd'
import { BranchIcon } from '../git/parts'

// 由 prompt 首句推会话名：派活时用户只写了要干什么，名字不该再问一遍。
// worktree 分支默认名：会话名 slug（小写、非字母数字转 -）
// prompt 派生任务名：取首行、去引号标点、截 24 字、空白转 -；中文原样保留（tmux 会话名支持中文）。
export function taskNameFromPrompt(p: string): string {
  const first = (p.trim().split(/\n/)[0] || '').replace(/["'`«»""'']/g, '').trim()
  // 优先在首个标点处断句（够长时），再截 24 字、去尾部标点、空白转 -
  const seg = first.split(/[，。,.!！？?;；:：]/)[0]
  const base = seg.length >= 4 ? seg : first
  return base.slice(0, 24).trim().replace(/[，。,.!！？?;；:：\s]+$/g, '').replace(/\s+/g, '-')
}

export function NewSessionModal({ open, parent, onClose, onDone, initialDir }: { open: boolean; parent?: string | null; onClose: () => void; onDone: (name: string) => void; initialDir?: string }) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [dir, setDir] = useState('')
  const [pick, setPick] = useState(false)
  const [agent, setAgent] = useState<'none' | 'claude' | 'codex'>('claude')
  // 工作区三选一（W1 交互修订）：主仓库 / 新建隔离 worktree / 进入已有 worktree
  // 工作区两选一（22 设计 D4）：新建 worktree / 已有 worktree；非 git 目录才退回「就在这个目录」
  const [wtMode, setWtMode] = useState<'repo' | 'new' | 'existing'>('new')
  const [existingWts, setExistingWts] = useState<any[]>([])
  const [wtPath, setWtPath] = useState('')
  const [autoReview, setAutoReview] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [creating, setCreating] = useState(false)
  // worktree 展开态（W1）：只选「基于」。分支不提前指定——后端按会话名占位，
  // Agent 开工后按任务 git branch -m 语义化（交互修订 4：先建会话再建 worktree）。
  // base 选中值：本地分支存裸名；远端分支存 remote:<remote>:<branch> 编码
  // （冒号在 git ref 名里非法，编码无歧义），提交前拆回 {base, remote}
  const [base, setBase] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<{ remote: string; name: string }[]>([])
  const [defBranch, setDefBranch] = useState('')
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs] = usePreferences()
  useEffect(() => {
    if (!open) return
    setPrompt(''); setName(''); setNameTouched(false); setDir(initialDir || ''); setAgent('claude'); setWtMode('new'); setAutoReview(false); setIsGitRepo(false)
    setBase(''); setBranches([]); setRemoteBranches([]); setDefBranch(''); setExistingWts([]); setWtPath('')
    // 派生模式：目录默认父会话 cwd（可改成任意目录，与新建一致）
    if (parent) {
      let cancelled = false
      api('GET', `/sessions/${encodeURIComponent(parent)}/cwd`)
        .then((r) => { if (!cancelled) setDir(r?.data?.dir || '') }).catch(() => {})
      return () => { cancelled = true }
    }
  }, [open, parent, initialDir])
  useEffect(() => {
    const d = dir.trim()
    if (!d) { setIsGitRepo(false); return }
    let cancelled = false
    api('GET', `/git/is-repo?path=${encodeURIComponent(d)}`).then((r) => {
      if (!cancelled) setIsGitRepo(!!r?.data?.repo)
    }).catch(() => { if (!cancelled) setIsGitRepo(false) })
    return () => { cancelled = true }
  }, [dir])
  // 目录是 git 仓库时拉已有 worktree（三选一的「已有」选项 + 计数）
  useEffect(() => {
    if (!isGitRepo || !dir.trim()) { setExistingWts([]); setWtPath(''); setWtMode('repo'); return }
    let cancelled = false
    api('GET', `/git/worktrees?dir=${encodeURIComponent(dir.trim())}`).then((r) => {
      if (cancelled) return
      const wts = (Array.isArray(r?.data) ? r.data : []).filter((w: any) => !w.isMain && !w.prunable)
      setExistingWts(wts)
      setWtPath((prev) => (prev && wts.some((w: any) => w.path === prev) ? prev : (wts[0]?.path || '')))
    }).catch(() => { if (!cancelled) setExistingWts([]) })
    return () => { cancelled = true }
  }, [isGitRepo, dir])
  // 选「新建 worktree」时拉本地+远端分支做「基于」候选
  useEffect(() => {
    if (wtMode !== 'new' || !isGitRepo || !dir.trim()) return
    let cancelled = false
    api('GET', `/git/branches?dir=${encodeURIComponent(dir.trim())}`).then((r) => {
      if (cancelled) return
      const bs: string[] = r?.data?.branches || []
      const def: string = r?.data?.default || ''
      const rs: { remote: string; name: string }[] = r?.data?.remotes || []
      setBranches(bs); setDefBranch(def); setRemoteBranches(rs)
      setBase((prev) => (prev && (bs.includes(prev) || rs.some((x) => `remote:${x.remote}:${x.name}` === prev)) ? prev : def))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [wtMode, isGitRepo, dir])
  const ok = async () => {
    // prompt-first：名字可全派生；prompt 与名字都空才拦
    let finalName = name.trim()
    if (!finalName) {
      if (!prompt.trim()) return message.error(t('session.promptOrNameRequired'))
      finalName = taskNameFromPrompt(prompt).slice(0, 16).replace(/[-，。,.\s]+$/g, '')
    }
    if (!finalName) {
      const d = new Date()
      finalName = 'task-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
    }
    try {
      setCreating(true)
      let sessionDir = dir.trim()
      let actual: string
      if (wtMode === 'new' && isGitRepo && sessionDir) {
        // 组合 API（先会话后 worktree）：分支不传——后端按会话名占位，Agent 开工后语义化；
        // 派生模式走 fork-worktree（同编排 + meta 记父子）
        let baseReq: { base?: string; remote?: string } = base ? { base } : {}
        if (base.startsWith('remote:')) {
          const rest = base.slice('remote:'.length)
          const sep = rest.indexOf(':')
          baseReq = { base: rest.slice(sep + 1), remote: rest.slice(0, sep) }
        }
        const res = parent
          ? await api('POST', `/sessions/${encodeURIComponent(parent)}/fork-worktree`, {
            child: finalName, dir: sessionDir, ...baseReq,
          })
          : await api('POST', '/worktree-sessions', {
            name: finalName, dir: sessionDir, ...baseReq,
          })
        actual = res.name || res.data?.session || finalName
        sessionDir = res.data?.path || sessionDir
      } else {
        // 主仓库直接用所选目录；「已有 worktree」= 会话 cwd 指进该 worktree；
        // 派生模式走 fork（dir 留空则继承父 cwd）
        if (wtMode === 'existing' && wtPath) sessionDir = wtPath
        const res = parent
          ? await api('POST', `/sessions/${encodeURIComponent(parent)}/fork`, {
            child: finalName, ...(sessionDir ? { dir: sessionDir } : {}),
          })
          : await api('POST', '/sessions', { name: finalName, dir: sessionDir })
        actual = res.name || finalName
      }
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        let launch = cmd
        if (prompt.trim()) {
          // prompt 作为 CLI 参数随启动一次带入；新建 worktree 时前置命名约定：
          // 让 agent 开工前 git branch -m 一个语义化分支名（占位分支来自后端）
          const naming = t(wtMode === 'new' ? 'session.wt.namingHint' : 'session.wt.namingHintRepo') + '\n\n'
          launch = `${cmd} ${shq(naming + prompt.trim())}`
        }
        await api('POST', '/tasks/_/send', { sess: actual, msg: launch })
        if (autoReview && !sessionDir) {
          message.warning(t('session.autoReviewNeedsDir'))
        } else if (autoReview && sessionDir) {
          // track 会登记跟踪并拉起 review-<会话> 监控会话:对话空闲即互审,意见回灌
          await api('POST', '/plugin/track', {
            session: actual,
            labels: { 'review:auto': 'true', role: 'author', workdir: sessionDir },
          }).catch((e: any) => message.warning(t('session.autoReviewTrackFailed') + ': ' + e.message))
        }
      }
      pushRecentDir(dir); message.success(t(parent ? 'session.fork.created' : 'session.created')); onClose(); onDone(actual)
    }
    catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok}
        okText={parent ? t('session.fork.ok') : t('file.create')}
        title={parent ? t('session.fork.title', { parent }) : initialDir ? t('tree.newTaskIn', { name: initialDir.replace(/\/+$/, '').split('/').pop() || initialDir }) : t('session.new')} destroyOnClose
        confirmLoading={creating}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {/* 名称是一等短输入(可留空自动命名)；需求是任务本体,发给 Agent/派生分支 */}
          <Input placeholder={t('session.namePlaceholder2')} value={name} autoFocus
            onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
          {/* 顺序（交互修订 5）：先定位置——名字 → 目录 → 在哪干活；再定执行——Agent → 需求。
              派生模式目录固定 = 父会话 cwd（派生的语义就是在父目录干活），只读展示 */}
          {parent ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir}>{dir || '…'}</div>
          ) : (<>
            <Space.Compact style={{ width: '100%' }}>
              <AutoComplete style={{ flex: 1 }} value={dir} onChange={setDir}
                options={recentDirs().map((d) => ({ value: d }))}
                filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
                placeholder={t('session.dirPlaceholder')} />
              <Button onClick={() => setPick(true)}>{t('common.browse')}</Button>
            </Space.Compact>
            {recentDirs().length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {recentDirs().map((d) => (
                  <Tooltip key={d} title={d}>
                    <Tag color={d === dir ? 'blue' : undefined} style={{ cursor: 'pointer', margin: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      onClick={() => setDir(d)}>
                      {d.split('/').filter(Boolean).pop() || d}
                    </Tag>
                  </Tooltip>
                ))}
              </div>
            )}
          </>)}
          {/* 工作区三选一（W1 交互修订）：常驻不隐藏(cc96123 教训)——非 git 目录整组置灰+tooltip */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 13, flex: '0 0 auto' }}>{t('session.wt.where')}</span>
              <Tooltip title={isGitRepo ? '' : parent ? t('session.fork.parentNotRepo') : t('session.worktreeNeedsRepo')}>
                <Segmented size="small" value={isGitRepo ? (wtMode === 'repo' ? 'new' : wtMode) : 'repo'} onChange={(v) => setWtMode(v as any)} options={isGitRepo ? [
                  { label: t('session.wt.newWt'), value: 'new' },
                  { label: t('session.wt.existingWt', { count: existingWts.length }), value: 'existing', disabled: !existingWts.length },
                ] : [
                  { label: parent ? t('session.fork.parentDir') : t('session.wt.mainRepo'), value: 'repo' },
                ]} />
              </Tooltip>
            </div>
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>
              {!isGitRepo ? (parent ? t('session.fork.parentNotRepo') : t('session.worktreeNeedsRepo'))
                : wtMode === 'repo' ? (parent ? t('session.fork.hintParent') : t('session.wt.hintRepo'))
                  : wtMode === 'new' ? t('session.wt.hintNew') : t('session.wt.hintExisting')}
            </div>
            {wtMode === 'existing' && (
              <Select value={wtPath || undefined} onChange={(v) => setWtPath(v)} placeholder={t('session.wt.pickExisting')}
                style={{ width: '100%' }} optionLabelProp="title"
                options={existingWts.map((w: any) => {
                  const occupied = (w.sessions || []).length > 0
                  return {
                    value: w.path,
                    title: w.branch || w.path.split('/').pop(),
                    label: (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
                        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: 4 }}><BranchIcon size={11} />{w.branch || '?'}</span>
                        {occupied
                          ? <Tag color="green" style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>{sessionLabel(w.sessions[0].session)}</Tag>
                          : w.external
                            ? <Tag style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>⧉ {t('worktree.external')}</Tag>
                            : <Tag color="warning" style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>{t('worktree.orphan')}</Tag>}
                        {(w.dirty > 0 || w.untracked > 0) && <span style={{ color: 'var(--text-dimmer)', fontSize: 11 }}>{t('session.wt.dirtyShort', { count: w.dirty + w.untracked })}</span>}
                      </span>
                    ),
                  }
                })} />
            )}
            {/* 新建 worktree 展开态（W1 交互修订 4）：只选「基于」（缺省本地主干）。
                分支不提前指定——占位按会话名派生，Agent 开工后按任务命名 */}
            {wtMode === 'new' && isGitRepo && (
              <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--r-sm)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: '0 0 52px', color: 'var(--text-dim)', fontSize: 13 }}>{t('session.wt.base')}</span>
                  <Select size="small" showSearch optionFilterProp="label" style={{ flex: 1, minWidth: 0 }}
                    value={base || undefined} onChange={(v) => setBase(v)}
                    placeholder={t('session.wt.basePlaceholder')}
                    options={(() => {
                      type Opt = { value?: string; label: string; options?: { value: string; label: string }[] }
                      const locals = [
                        ...(defBranch ? [{ value: defBranch, label: t('session.wt.defaultBranch', { name: defBranch }) }] : []),
                        ...branches.filter((b) => b !== defBranch).map((b) => ({ value: b, label: b })),
                      ]
                      if (!remoteBranches.length) return locals as Opt[]
                      return [
                        { label: t('session.wt.localBranches'), options: locals },
                        {
                          label: t('session.wt.remoteBranches'),
                          options: remoteBranches.map((rb) => ({ value: `remote:${rb.remote}:${rb.name}`, label: `${rb.remote}/${rb.name}` })),
                        },
                      ] as Opt[]
                    })()} />
                </div>
                <div style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>
                  {base.startsWith('remote:') ? t('session.wt.remoteFetchNote')
                    : agent !== 'none' ? t('session.wt.autoNote') : t('session.wt.autoNoteNoAgent')}
                </div>
              </div>
            )}
          </div>
          <Radio.Group value={agent} onChange={(e) => setAgent(e.target.value)} optionType="button" buttonStyle="solid"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <Radio.Button value="none">{t('session.agentNone')}</Radio.Button>
            <Radio.Button value="claude">{t('session.agentClaude')}</Radio.Button>
            <Radio.Button value="codex">{t('session.agentCodex')}</Radio.Button>
          </Radio.Group>
          <Input.TextArea placeholder={t('session.promptPlaceholder')} value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }} />
          <Tooltip placement="right" title={agent !== 'none' ? t('session.autoReviewTip') : t('session.autoReviewNeedsAgent')}>
            <Checkbox checked={autoReview && agent !== 'none'} disabled={agent === 'none'}
              onChange={(e) => setAutoReview(e.target.checked)} style={{ width: 'fit-content' }}>
              <span style={{ fontSize: 13 }}>{t('session.autoReview')}</span>
            </Checkbox>
          </Tooltip>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir || undefined} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
}


// 改名 = 只改**展示名**：会话本身叫 id，改名不动 handle，
// 所以终端标签、URL、归属、正在跑的东西全都不受影响，重名也随便。
