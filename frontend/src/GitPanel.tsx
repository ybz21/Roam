// Git 面板 —— 仿 VSCode「源代码管理」：提交框 + 暂存/取消暂存/放弃（按文件、按分组）+ Pull/Push/Fetch/Sync。
// 数据全部来自会话工作目录所属仓库的本地 .git（经 git CLI 读写），跟随会话工作目录。
import { useEffect, useMemo, useState } from 'react'
import { Button, Dropdown, Input, Spin, Tooltip, App as AntApp } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

interface GitFile { path: string; orig?: string; index: string; work: string; staged: boolean; untracked: boolean }
interface GitCommit { hash: string; short: string; subject: string; author: string; when: string }
interface GitStatus { repo: boolean; root?: string; branch?: string; ahead?: number; behind?: number; files?: GitFile[]; commits?: GitCommit[] }
interface Pick { file: string; staged: boolean; untracked: boolean; label: string }

const BranchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><circle cx="18" cy="8" r="2.3" /><path d="M6 8.3v7.4" /><path d="M18 10.3a6 6 0 0 1-6 6H8.3" /></svg>
)
const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></svg>
)
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
)
const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
)
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
)
const MinusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /></svg>
)
const DiscardIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
)
const SyncIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 12A9 9 0 0 1 18 5.3L21 8" /><path d="M21 3v5h-5" /><path d="M3 21v-5h5" /></svg>
)

function statusColor(code: string): string {
  switch (code) {
    case 'M': return 'hsl(38,90%,55%)'
    case 'A': return 'hsl(140,55%,48%)'
    case 'D': return 'hsl(0,70%,58%)'
    case 'R': case 'C': return 'hsl(210,75%,60%)'
    case 'U': return 'hsl(0,75%,60%)'
    case '?': return 'var(--text-dimmer)'
    default: return 'var(--text-dim)'
  }
}
function fileNameOf(p: string): string { return p.split('/').pop() || p }
function pickOf(f: GitFile): Pick {
  if (f.untracked) return { file: f.path, staged: false, untracked: true, label: f.path }
  const work = f.work !== ' ' && f.work !== '?'
  return { file: f.path, staged: !work, untracked: false, label: f.path }
}

// 差异文本按行着色：+ 绿 / - 红 / @@ 蓝 / 头部灰。
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto', height: '100%', boxSizing: 'border-box', background: 'var(--bg-base)', padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.5 }}>
      {lines.map((ln, i) => {
        let color = 'var(--text-bright)'
        let bg = 'transparent'
        if (ln.startsWith('@@')) color = 'hsl(210,75%,62%)'
        else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('new file') || ln.startsWith('deleted file') || ln.startsWith('rename ') || ln.startsWith('similarity ')) color = 'var(--text-dim)'
        else if (ln.startsWith('+')) { color = 'hsl(140,60%,62%)'; bg = 'hsla(140,60%,45%,.08)' }
        else if (ln.startsWith('-')) { color = 'hsl(0,72%,66%)'; bg = 'hsla(0,72%,50%,.08)' }
        return <div key={i} style={{ color, background: bg, minHeight: '1.5em' }}>{ln || ' '}</div>
      })}
    </pre>
  )
}

// 行内小动作按钮：hover 文件行时浮现（沿用 .cc-dl 的浮现样式）。
const RowAct = ({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <Tooltip title={title}>
    <button type="button" className="cc-dl" data-file-action
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', display: 'inline-grid', placeItems: 'center', color: danger ? 'hsl(0,72%,62%)' : 'var(--text-dim)', flex: '0 0 auto' }}>
      {children}
    </button>
  </Tooltip>
)

function GitRow({ f, accent, active, kind, root, onOpen, onStage, onUnstage, onDiscard }: {
  f: GitFile; accent: string; active: boolean; kind: 'staged' | 'changes' | 'untracked'; root?: string
  onOpen: () => void; onStage: () => void; onUnstage: () => void; onDiscard: () => void
}) {
  const { t } = useI18n()
  const code = (f.index !== ' ' && f.index !== '?') ? f.index : f.work
  const badge = f.untracked ? 'U' : (code || '?')
  const subdir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  // f.path 相对仓库根；拼成绝对路径供拖到终端时识别（与文件面板一致的拖拽载荷）。
  const fullPath = root ? root.replace(/\/$/, '') + '/' + f.path : f.path
  return (
    <div className="cc-filerow" onClick={onOpen}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData('application/x-ttmux-path', fullPath)
        ev.dataTransfer.setData('text/plain', fullPath)
        ev.dataTransfer.effectAllowed = 'copy'
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none', background: active ? 'rgba(88,166,255,.12)' : undefined }}>
      <span style={{ width: 16, flex: '0 0 auto', textAlign: 'center', fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: statusColor(badge) }}>{badge}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-bright)' }} title={f.path}>
        {f.orig && <span style={{ color: 'var(--text-dimmer)' }}>{fileNameOf(f.orig)} → </span>}
        {fileNameOf(f.path)}
        {subdir && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, marginLeft: 6 }}>{subdir}</span>}
      </span>
      {kind === 'staged'
        ? <RowAct title={t('git.unstage')} onClick={onUnstage}><MinusIcon /></RowAct>
        : <>
            <RowAct title={t('git.discard')} danger onClick={onDiscard}><DiscardIcon /></RowAct>
            <RowAct title={t('git.stage')} onClick={onStage}><PlusIcon /></RowAct>
          </>}
      <span style={{ width: 5, height: 5, borderRadius: '50%', flex: '0 0 auto', background: accent, opacity: active ? 1 : 0 }} />
    </div>
  )
}

function Section({ title, count, extra, children }: { title: string; count: number; extra?: React.ReactNode; children: React.ReactNode }) {
  if (!count) return null
  return (
    <div className="cc-git-section" style={{ marginBottom: 4 }}>
      <div style={{ padding: '4px 8px 4px 10px', color: 'var(--text-dim)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{title}</span><span style={{ color: 'var(--text-dimmer)' }}>{count}</span>
        <span style={{ flex: 1 }} />
        <span className="cc-git-section-act" style={{ display: 'inline-flex', gap: 2 }}>{extra}</span>
      </div>
      {children}
    </div>
  )
}

export default function GitPanel({ dir, accent = '#58a6ff', onClose }: { dir?: string; accent?: string; onClose?: () => void }) {
  const { t } = useI18n()
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [pick, setPick] = useState<Pick | null>(null)
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const root = status?.root

  useEffect(() => {
    if (!dir) { setStatus(null); return }
    let stop = false
    setLoading(true); setErr('')
    api('GET', `/git/status?dir=${encodeURIComponent(dir)}`)
      .then((r) => { if (!stop) setStatus(r.data) })
      .catch((e) => { if (!stop) setErr(e.message) })
      .finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [dir, tick])

  useEffect(() => {
    if (!pick || !status?.files) return
    if (!status.files.some((f) => f.path === pick.file)) { setPick(null); setDiff('') }
  }, [status])

  useEffect(() => {
    if (!pick || !root) { setDiff(''); return }
    let stop = false
    setDiffLoading(true)
    const q = `root=${encodeURIComponent(root)}&file=${encodeURIComponent(pick.file)}&staged=${pick.staged ? 1 : 0}&untracked=${pick.untracked ? 1 : 0}`
    api('GET', `/git/diff?${q}`)
      .then((r) => { if (!stop) setDiff(r.data?.diff || '') })
      .catch((e) => { if (!stop) setDiff(`# ${e.message}`) })
      .finally(() => { if (!stop) setDiffLoading(false) })
    return () => { stop = true }
  }, [pick, root])

  const refresh = () => setTick((n) => n + 1)
  // 统一跑写操作：置忙 → 调接口 → 刷新；出错弹消息。successOut 用于把 git 输出回显。
  const run = async (fn: () => Promise<any>, okMsg?: string) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fn()
      refresh()
      const out = r?.data?.output?.trim?.()
      if (out) message.success(out)
      else if (okMsg) message.success(okMsg)
    } catch (e: any) {
      message.error(e.message)
    } finally { setBusy(false) }
  }

  const stage = (files: string[]) => run(() => api('POST', '/git/stage', { root, files }))
  const stageAll = () => run(() => api('POST', '/git/stage', { root, all: true }))
  const unstage = (files: string[]) => run(() => api('POST', '/git/unstage', { root, files }))
  const unstageAll = () => run(() => api('POST', '/git/unstage', { root, all: true }))
  const discardFile = (f: GitFile) => {
    modal.confirm({
      title: t('git.discardConfirm', { file: f.path }),
      okText: t('git.discard'), cancelText: t('common.cancel'), okButtonProps: { danger: true },
      onOk: () => run(() => api('POST', '/git/discard', f.untracked ? { root, untracked: [f.path] } : { root, files: [f.path] })),
    })
  }
  const discardAll = () => {
    modal.confirm({
      title: t('git.discardAllConfirm'), okText: t('git.discardAll'), cancelText: t('common.cancel'), okButtonProps: { danger: true },
      onOk: () => run(() => api('POST', '/git/discard', { root, files: ['.'] })),
    })
  }
  const op = (o: string) => run(() => api('POST', '/git/op', { root, op: o }), t('git.opDone', { op: o }))
  const doCommit = async (mode: 'plain' | 'push' | 'sync') => {
    if (!msg.trim()) { message.warning(t('git.commitEmpty')); return }
    await run(async () => {
      const r = await api('POST', '/git/commit', { root, message: msg, push: mode === 'push' })
      setMsg('')
      if (mode === 'sync') await api('POST', '/git/op', { root, op: 'sync' })
      return r
    }, t('git.committed'))
  }

  const staged = useMemo(() => status?.files?.filter((f) => f.staged && !f.untracked) || [], [status])
  const changed = useMemo(() => status?.files?.filter((f) => !f.untracked && f.work !== ' ' && f.work !== '?') || [], [status])
  const untracked = useMemo(() => status?.files?.filter((f) => f.untracked) || [], [status])
  const clean = status?.repo && !loading && (status.files?.length ?? 0) === 0

  const moreItems = [
    { key: 'pull', label: t('git.pull') },
    { key: 'push', label: t('git.push') },
    { key: 'fetch', label: t('git.fetch') },
    { key: 'sync', label: t('git.sync') },
    { type: 'divider' as const },
    { key: 'stageAll', label: t('git.stageAll'), disabled: !changed.length && !untracked.length },
    { key: 'unstageAll', label: t('git.unstageAll'), disabled: !staged.length },
    { key: 'discardAll', label: t('git.discardAll'), danger: true, disabled: !changed.length },
  ]
  const onMore = ({ key }: { key: string }) => {
    if (key === 'stageAll') stageAll()
    else if (key === 'unstageAll') unstageAll()
    else if (key === 'discardAll') discardAll()
    else op(key)
  }

  const panel = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0, width: '100%', background: 'var(--bg-container)', borderLeft: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: accent }}><BranchIcon /></span>
          <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontSize: 13 }}>{t('git.panelTitle')}</span>
          <span style={{ flex: 1 }} />
          {status?.repo && (
            <Dropdown trigger={['click']} menu={{ items: moreItems as any, onClick: onMore }} placement="bottomRight" disabled={busy}>
              <Button type="text" size="small" style={{ width: 24, height: 24, minWidth: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><MoreIcon /></Button>
            </Dropdown>
          )}
          <Tooltip title={t('git.refresh')}>
            <Button type="text" size="small" onClick={refresh} style={{ width: 24, height: 24, minWidth: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><RefreshIcon /></Button>
          </Tooltip>
          {onClose && <button type="button" title={t('git.closePanel')} aria-label={t('git.closePanel')} className="tt-file-close" onClick={onClose}><CloseIcon /></button>}
        </div>
        {status?.repo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 6, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', color: 'var(--text-bright)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
              <span style={{ color: accent, display: 'inline-flex' }}><BranchIcon /></span>{status.branch || 'HEAD'}
            </span>
            <Tooltip title={t('git.sync')}>
              <Button type="text" size="small" onClick={() => op('sync')} disabled={busy}
                style={{ height: 22, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-dim)' }}>
                <SyncIcon />
                {!!status.behind && <span style={{ fontSize: 11 }}>↓{status.behind}</span>}
                {!!status.ahead && <span style={{ fontSize: 11 }}>↑{status.ahead}</span>}
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {/* 提交框（VSCode 风格）：暂存内容 + 信息 → 提交，可下拉提交并推送/同步 */}
      {status?.repo && (
        <div style={{ padding: '8px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Input.TextArea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit('plain') } }}
            placeholder={t('git.commitPlaceholder', { branch: status.branch || 'HEAD' })}
            autoSize={{ minRows: 1, maxRows: 5 }}
            style={{ fontSize: 12.5 }}
          />
          <Dropdown.Button
            size="small" type="primary"
            disabled={busy || !msg.trim()}
            onClick={() => doCommit('plain')}
            menu={{ items: [{ key: 'push', label: t('git.commitPush') }, { key: 'sync', label: t('git.commitSync') }], onClick: ({ key }) => doCommit(key as any) }}
          >
            ✓ {t('git.commit')}{staged.length ? ` (${staged.length})` : ''}
          </Dropdown.Button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {(loading || busy) && <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}><Spin size="small" /></div>}
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '6px 10px' }}>{t('git.loadFailed', { message: err })}</div>}
        {!dir && !loading && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '10px' }}>{t('git.noDir')}</div>}
        {status && !status.repo && !loading && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '10px', lineHeight: 1.6 }}>{t('git.notRepo')}</div>}
        {clean && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '10px' }}>✓ {t('git.noChanges')}</div>}

        <Section title={t('git.staged')} count={staged.length}
          extra={<RowAct title={t('git.unstageAll')} onClick={unstageAll}><MinusIcon /></RowAct>}>
          {staged.map((f) => <GitRow key={'s' + f.path} f={f} accent={accent} root={root} kind="staged" active={pick?.file === f.path && pick.staged}
            onOpen={() => setPick({ file: f.path, staged: true, untracked: false, label: f.path })}
            onStage={() => {}} onUnstage={() => unstage([f.path])} onDiscard={() => {}} />)}
        </Section>
        <Section title={t('git.changes')} count={changed.length}
          extra={<><RowAct title={t('git.discardAll')} danger onClick={discardAll}><DiscardIcon /></RowAct><RowAct title={t('git.stageAll')} onClick={() => stage(changed.map((f) => f.path))}><PlusIcon /></RowAct></>}>
          {changed.map((f) => <GitRow key={'c' + f.path} f={f} accent={accent} root={root} kind="changes" active={pick?.file === f.path && !pick.staged && !pick.untracked}
            onOpen={() => setPick({ file: f.path, staged: false, untracked: false, label: f.path })}
            onStage={() => stage([f.path])} onUnstage={() => {}} onDiscard={() => discardFile(f)} />)}
        </Section>
        <Section title={t('git.untracked')} count={untracked.length}
          extra={<RowAct title={t('git.stageAll')} onClick={() => stage(untracked.map((f) => f.path))}><PlusIcon /></RowAct>}>
          {untracked.map((f) => <GitRow key={'u' + f.path} f={f} accent={accent} root={root} kind="untracked" active={pick?.file === f.path}
            onOpen={() => setPick(pickOf(f))}
            onStage={() => stage([f.path])} onUnstage={() => {}} onDiscard={() => discardFile(f)} />)}
        </Section>

        {!!status?.commits?.length && (
          <Section title={t('git.commits')} count={status.commits.length}>
            {status.commits.map((cm) => (
              <div key={cm.hash} style={{ padding: '4px 10px', fontSize: 12, lineHeight: 1.4 }}>
                <div style={{ color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cm.subject}>{cm.subject}</div>
                <div style={{ color: 'var(--text-dimmer)', fontSize: 11, display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: accent }}>{cm.short}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cm.author}</span>
                  <span style={{ flex: '0 0 auto' }}>{cm.when}</span>
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  )

  return (
    <>
      {panel}
      {pick && (
        <div className="tt-file-detail" style={{ position: 'fixed', top: 0, bottom: 0, height: '100dvh', right: 'min(420px, 92vw)', zIndex: 1199, background: 'var(--bg-base)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--elevated-shadow)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              <span style={{ color: accent }}>▸</span> {pick.label}
            </span>
            <span style={{ flex: 1 }} />
            {!pick.untracked && (
              <Button size="small" type={pick.staged ? 'primary' : 'default'} onClick={() => setPick({ ...pick, staged: !pick.staged })}>
                {pick.staged ? t('git.stagedDiff') : t('git.working')}
              </Button>
            )}
            <button type="button" title={t('git.closeDiff')} aria-label={t('git.closeDiff')} className="tt-file-close" onClick={() => setPick(null)}><CloseIcon /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {diffLoading ? <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><Spin /></div>
              : diff.trim() ? <DiffView text={diff} />
                : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-dimmer)', fontSize: 13 }}>{t('git.binaryDiff')}</div>}
          </div>
        </div>
      )}
    </>
  )
}
