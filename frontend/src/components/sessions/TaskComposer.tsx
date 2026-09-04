// 「开任务」的 composer（23 设计 §3.1 #1）：描述 ⏎ 就在新 worktree 里开干。
//
// 原来长在项目主页里（Projects.tsx 的 ProjectHome），一份状态一份 JSX 只能在那一页用；
// 项目行的「+」、⌘N 都要同一个框——抽出来，项目主页和弹窗各挂一份。
// 提交流程（先会话后 worktree、开工约定、自动互审）和 NewSessionModal 同款，不改。
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { App as AntApp, Button, Dropdown, Input } from 'antd'
import { api, upload, makeClipboardImageFile } from '../../api'
import { appendPaths } from '../../agent-paths'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { shellQuote as shq } from '../../shell-quote'
import { taskNameFromPrompt } from './NewSessionModal'
import { VoiceInput } from '../chat/VoiceInput'
import { CheckIcon, ChevronDown, CircleIcon, PaperclipIcon } from '../../icons'
import { BranchIcon } from '../git/parts'

export type TaskComposerHandle = { focus: () => void; insert: (text: string) => void }

export const TaskComposer = forwardRef<TaskComposerHandle, {
  dir: string
  isGit: boolean
  openTerm: (name: string) => void
  /** 建完（会话已开）：项目主页刷新列表，弹窗关掉自己 */
  onCreated?: (name: string) => void
  autoFocus?: boolean
}>(function TaskComposer({ dir, isGit, openTerm, onCreated, autoFocus }, ref) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [prefs] = usePreferences()
  const [prompt, setPrompt] = useState('')
  const [wtMode, setWtMode] = useState<'new' | 'repo' | 'existing'>('new')
  const [agent, setAgent] = useState<'claude' | 'codex' | 'none'>('claude')
  const [wtsAll, setWtsAll] = useState<any[]>([])
  const [wtPath, setWtPath] = useState('')
  const [defBranch, setDefBranch] = useState('')
  const [base, setBase] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<{ remote: string; name: string }[]>([])
  const [autoReview, setAutoReview] = useState(false)
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<any>(null)
  useImperativeHandle(ref, () => ({
    focus: () => promptRef.current?.focus?.(),
    insert: (text) => setPrompt((cur) => appendPaths(cur, [text])),
  }))
  useEffect(() => { if (autoFocus) setTimeout(() => promptRef.current?.focus?.(), 0) }, [autoFocus])

  // worktree 清单（「已有(N)」）与分支（「基于」）：和项目主页同两条接口
  useEffect(() => {
    if (!dir || !isGit) { setWtsAll([]); return }
    let stop = false
    const loadWts = () => api('GET', `/git/worktrees?dir=${encodeURIComponent(dir)}`).then((r) => {
      if (!stop) setWtsAll(Array.isArray(r?.data) ? r.data : [])
    }).catch(() => {})
    loadWts()
    const i = setInterval(loadWts, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [dir, isGit])
  useEffect(() => {
    if (!dir || !isGit) return
    api('GET', `/git/branches?dir=${encodeURIComponent(dir)}`).then((r) => {
      const def = r?.data?.default || ''
      setDefBranch(def)
      setBranches(r?.data?.branches || [])
      setRemoteBranches(r?.data?.remotes || [])
      setBase((prev) => prev || def) // 「基于」默认跟主干走；用户选过就不再被覆盖
    }).catch(() => {})
  }, [dir, isGit])
  const wts = useMemo(() => wtsAll.filter((w: any) => !w.isMain && !w.prunable), [wtsAll])
  useEffect(() => {
    setWtPath((prev) => (prev && wts.some((w: any) => w.path === prev) ? prev : (wts[0]?.path || '')))
  }, [wts])

  const uploadImages = async (images: File[]) => {
    if (!images.length || uploading) return
    setUploading(true)
    try {
      const res = await upload('/tmp', images)
      setPrompt((v) => appendPaths(v, res.saved))
      message.success(t('chat.uploadedFiles', { count: images.length, dir: '/tmp' }))
    } catch (e: any) { message.error(t('chat.uploadFailed', { message: e.message })) }
    finally { setUploading(false) }
  }
  // Ctrl+V 粘贴图片：一次只取一张（同张截图常以多种 MIME 重复出现，全收会插入两次）
  const onPaste = (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.items) return
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) { e.preventDefault(); void uploadImages([makeClipboardImageFile(f, item.type, 0)]); return }
      }
    }
  }
  // 「基于」显示名：远端分支存的是 remote:<remote>:<branch>，展示时还原成 remote/branch
  const baseLabel = (() => {
    const v = base || defBranch
    if (!v) return t('project.baseDefault')
    if (!v.startsWith('remote:')) return v
    const rest = v.slice('remote:'.length)
    const sep = rest.indexOf(':')
    return `${rest.slice(0, sep)}/${rest.slice(sep + 1)}`
  })()

  const goCreate = async () => {
    if (!dir || creating) return
    if (!prompt.trim()) { message.error(t('session.promptOrNameRequired')); return }
    // 名字一律从需求派生：这就是任务名（23 设计 §3.3 #6），agent 不再改它
    let finalName = taskNameFromPrompt(prompt).slice(0, 16).replace(/[-，。,.\s]+$/g, '')
    if (!finalName) {
      const d = new Date()
      finalName = 'task-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
    }
    try {
      setCreating(true)
      let actual: string
      const wantWt = isGit && wtMode === 'new'
      let sessionDir = dir
      if (wantWt) {
        // 「基于」：本地分支存裸名，远端分支编码成 remote:<remote>:<branch>，提交前拆回 {base, remote}
        let baseReq: { base?: string; remote?: string } = base && base !== defBranch ? { base } : {}
        if (base.startsWith('remote:')) {
          const rest = base.slice('remote:'.length)
          const sep = rest.indexOf(':')
          baseReq = { base: rest.slice(sep + 1), remote: rest.slice(0, sep) }
        }
        const res = await api('POST', '/worktree-sessions', { name: finalName, dir, ...baseReq })
        actual = res.name || res.data?.session || finalName
        sessionDir = res.data?.path || dir
      } else {
        sessionDir = isGit && wtMode === 'existing' && wtPath ? wtPath : dir
        const res = await api('POST', '/sessions', { name: finalName, dir: sessionDir })
        actual = res.name || finalName
      }
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        // 开工约定按工作区形态分两版：Roam 已建 worktree 的只要改分支名；在主仓库 / 已有 worktree 里的得自己开分支
        const naming = t(wantWt ? 'session.wt.namingHint' : 'session.wt.namingHintRepo') + '\n\n'
        await api('POST', '/tasks/_/send', { sess: actual, msg: prompt.trim() ? `${cmd} ${shq(naming + prompt.trim())}` : cmd })
        if (autoReview) {
          await api('POST', '/plugin/track', {
            session: actual,
            labels: { 'review:auto': 'true', role: 'author', workdir: sessionDir },
          }).catch((e: any) => message.warning(t('session.autoReviewTrackFailed') + ': ' + e.message))
        }
      }
      setPrompt(''); message.success(t('session.created')); openTerm(actual); onCreated?.(actual)
    } catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }

  return (
    <div className="tt-composer prj-in" style={{ animationDelay: '60ms' }}>
      <Input.TextArea ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder={isGit ? t('project.composerPlaceholder') : t('project.composerPlain')} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"
        onPaste={onPaste}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void goCreate() } }} />
      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={(e) => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) void uploadImages(fs) }} />
      {/* 控制条按「在哪干活 / 谁来干 / 动作」三组排，组内 6px、组间 16px，不画分隔线 */}
      <div className="tt-cbar">
        {isGit && (
          <span className="tt-cgrp">
            <button type="button" className={`tt-pill${wtMode === 'new' ? ' on' : ''}`} aria-pressed={wtMode === 'new'} onClick={() => setWtMode('new')}><BranchIcon size={11} />{t('project.where.new')}</button>
            <button type="button" className={`tt-pill${wtMode === 'existing' ? ' on' : ''}`} aria-pressed={wtMode === 'existing'}
              disabled={!wts.length} onClick={() => setWtMode('existing')}>{t('project.where.existing', { count: wts.length })}</button>
            {wtMode === 'existing' && (
              <Dropdown trigger={['click']} menu={{
                selectedKeys: [wtPath],
                items: wts.map((w: any) => ({ key: w.path, label: w.branch || w.path.split('/').pop(), onClick: () => setWtPath(w.path) })),
              }}>
                <button type="button" className="tt-pill sel" title={t('session.wt.pickExisting')}>
                  <BranchIcon size={11} />
                  <b>{wts.find((w: any) => w.path === wtPath)?.branch || wtPath.split('/').pop() || '—'}</b>
                  <ChevronDown size={10} />
                </button>
              </Dropdown>
            )}
            {wtMode === 'new' && (
              <Dropdown trigger={['click']} menu={{
                selectedKeys: [base || defBranch],
                items: [
                  ...(branches.length ? [{ key: 'g-local', type: 'group' as const, label: t('session.wt.localBranches'),
                    children: branches.map((b) => ({ key: b, label: b, onClick: () => setBase(b) })) }] : []),
                  ...(remoteBranches.length ? [{ key: 'g-remote', type: 'group' as const, label: t('session.wt.remoteBranches'),
                    children: remoteBranches.map((r) => ({ key: `remote:${r.remote}:${r.name}`, label: `${r.remote}/${r.name}`, onClick: () => setBase(`remote:${r.remote}:${r.name}`) })) }] : []),
                ],
              }}>
                <button type="button" className="tt-pill sel" title={t('session.wt.base')}>
                  {t('project.basedOnShort')}
                  <b>{baseLabel}</b>
                  <ChevronDown size={10} />
                </button>
              </Dropdown>
            )}
          </span>
        )}
        <span className="tt-cgrp">
          <button type="button" className={`tt-pill${agent === 'claude' ? ' on' : ''}`} aria-pressed={agent === 'claude'} onClick={() => setAgent('claude')}>Claude</button>
          <button type="button" className={`tt-pill${agent === 'codex' ? ' on' : ''}`} aria-pressed={agent === 'codex'} onClick={() => setAgent('codex')}>Codex</button>
          <button type="button" className={`tt-pill${agent === 'none' ? ' on' : ''}`} aria-pressed={agent === 'none'} onClick={() => setAgent('none')}>{t('project.agent.none')}</button>
        </span>
        {agent !== 'none' && (
          <span className="tt-cgrp">
            <button type="button" className={`tt-pill${autoReview ? ' on' : ''}`} title={t('session.autoReviewTip')}
              aria-pressed={autoReview} onClick={() => setAutoReview((v) => !v)}>
              {autoReview ? <CheckIcon size={11} /> : <CircleIcon size={11} />}{t('session.autoReview')}
            </button>
          </span>
        )}
        <span className="tt-cend">
          <VoiceInput inline accent="var(--accent)" onResult={(text) => setPrompt((v) => (v ? v + ' ' : '') + text)} />
          <button type="button" className="tt-pill ico" title={t('project.attachImage')} aria-label={t('project.attachImage')}
            disabled={uploading} onClick={() => fileRef.current?.click()}>
            <PaperclipIcon size={13} />
          </button>
          <Button type="primary" size="small" className="prj-go" loading={creating} onClick={goCreate}>{t('project.go')}</Button>
        </span>
      </div>
    </div>
  )
})
