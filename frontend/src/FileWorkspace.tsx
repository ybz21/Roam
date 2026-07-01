// 统一「文件工作区」：左侧文件浏览器(可拖拽调宽) + VSCode 式多文件编辑 tab + Monaco 编辑器。
// 支持左右双栏(编辑组 A/B)：拖 tab 到另一栏、或从文件树拖文件到某栏；会话(终端)作为固定首 tab 常驻 A 栏。
// 两处复用：独立 Files 页（纯文件）与新标签 SoloTerminal（会话经 leading* 槽传入）。
import { type ReactNode, Fragment, useEffect, useRef, useState } from 'react'
import { App as AntApp } from 'antd'
import FileBrowser, { Viewer, FileTypeIcon } from './FileBrowser'
import { useI18n } from './i18n'

type Group = 'A' | 'B'
const TAB_MIME = 'application/x-ttmux-tab'
const PATH_MIME = 'application/x-ttmux-path'
const LEAD_MIME = 'application/x-ttmux-lead' // 拖会话(首)tab → 左右易位
const PREVIEW_PREFIX = 'preview://' // 侧栏预览 tab 的标识前缀（区别于同文件的源码 tab）

function baseName(p: string): string {
  return p.split('/').pop() || p
}
const isPreview = (id: string) => id.startsWith(PREVIEW_PREFIX)
const realPath = (id: string) => (isPreview(id) ? id.slice(PREVIEW_PREFIX.length) : id)

export default function FileWorkspace({
  dir,
  accent = '#58a6ff',
  onOpenAgent,
  explorerOpen = true,
  onExplorerClose,
  leadingTab,
  leadingTitle,
  leadingContent,
  chrome,
  footer,
  emptyText,
}: {
  dir: string
  accent?: string
  onOpenAgent?: (kind: 'claude' | 'codex', path: string) => void
  explorerOpen?: boolean
  onExplorerClose?: () => void
  leadingTab?: ReactNode
  leadingTitle?: string
  leadingContent?: ReactNode
  chrome?: ReactNode
  footer?: ReactNode
  emptyText?: string
}) {
  const { t } = useI18n()
  const { modal } = AntApp.useApp()
  const hasLeading = leadingTab != null

  // 两个编辑组：A 主（含固定首 tab）、B 副（filesB 非空时出现，即分栏）
  const [filesA, setFilesA] = useState<string[]>([])
  const [filesB, setFilesB] = useState<string[]>([])
  const [activeA, setActiveA] = useState<string | null>(null) // null = 固定首 tab(会话)
  const [activeB, setActiveB] = useState<string | null>(null)
  const [focus, setFocus] = useState<Group>('A')
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set())
  const [dropHint, setDropHint] = useState<Group | 'split' | null>(null) // 拖拽落点提示
  useEffect(() => {
    const clear = () => setDropHint(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear, true)
    return () => { document.removeEventListener('dragend', clear); document.removeEventListener('drop', clear, true) }
  }, [])
  const split = filesB.length > 0

  const filesOf = (g: Group) => (g === 'A' ? filesA : filesB)
  const setFilesOf = (g: Group, v: string[]) => (g === 'A' ? setFilesA(v) : setFilesB(v))
  const activeOf = (g: Group) => (g === 'A' ? activeA : activeB)
  const setActiveOf = (g: Group, v: string | null) => (g === 'A' ? setActiveA(v) : setActiveB(v))

  const setFileDirty = (p: string, dirty: boolean) => setDirtyFiles((prev) => {
    if (prev.has(p) === dirty) return prev
    const n = new Set(prev); dirty ? n.add(p) : n.delete(p); return n
  })

  // 在某组打开文件；若已在另一组则跳到那一组，避免同一文件跨组重复
  const openInGroup = (p: string, g: Group) => {
    const other: Group = g === 'A' ? 'B' : 'A'
    if (filesOf(other).includes(p)) { setActiveOf(other, p); setFocus(other); return }
    if (!filesOf(g).includes(p)) setFilesOf(g, [...filesOf(g), p])
    setActiveOf(g, p); setFocus(g)
  }
  const openFileTab = (p: string) => openInGroup(p, split ? focus : 'A')
  // VSCode「侧栏打开预览」：把该 markdown 的渲染预览开到另一栏（预览 tab 用前缀区分，可与源码同时存在）
  const openPreviewToSide = (fromGroup: Group, p: string) => {
    const to: Group = fromGroup === 'A' ? 'B' : 'A'
    const id = PREVIEW_PREFIX + p
    if (!filesOf(to).includes(id)) setFilesOf(to, [...filesOf(to), id])
    setActiveOf(to, id); setFocus(to)
  }

  const neighbor = (arr: string[], removedIdx: number, g: Group): string | null => {
    const next = arr
    return next[removedIdx - 1] ?? next[removedIdx] ?? (g === 'A' && hasLeading ? null : (next[0] ?? null))
  }
  const doClose = (p: string, g: Group) => {
    const arr = filesOf(g)
    const i = arr.indexOf(p)
    if (i < 0) return
    const next = arr.filter((x) => x !== p)
    setFilesOf(g, next)
    setFileDirty(p, false)
    if (activeOf(g) === p) setActiveOf(g, neighbor(next, i, g))
    if (g === 'B' && next.length === 0) setFocus('A')
  }
  const closeFileTab = (p: string, g: Group) => {
    if (dirtyFiles.has(p)) {
      modal.confirm({
        title: t('file.closeUnsavedTitle'), content: baseName(p),
        okText: t('file.closeWithoutSaving'), cancelText: t('common.cancel'),
        okButtonProps: { danger: true }, onOk: () => doClose(p, g),
      })
    } else doClose(p, g)
  }
  // 把 tab 从 from 组移到 to 组（拖拽到另一栏）
  const moveTab = (p: string, from: Group, to: Group) => {
    if (from === to) { setActiveOf(to, p); setFocus(to); return }
    const fromArr = filesOf(from)
    const i = fromArr.indexOf(p)
    const fromNext = fromArr.filter((x) => x !== p)
    setFilesOf(from, fromNext)
    if (activeOf(from) === p) setActiveOf(from, neighbor(fromNext, i, from))
    if (!filesOf(to).includes(p)) setFilesOf(to, [...filesOf(to), p])
    setActiveOf(to, p); setFocus(to)
    if (from === 'B' && fromNext.length === 0) setFocus('A')
  }

  const leadingActive = hasLeading && activeA === null

  // 两栏：宽度比(左栏占比，拖分隔条调整) + 左右易位
  const panesRef = useRef<HTMLDivElement>(null)
  const [splitFrac, setSplitFrac] = useState(0.5)
  const [swapped, setSwapped] = useState(false)
  const leftGroup: Group = swapped ? 'B' : 'A'
  const startSplitResize = (e: React.PointerEvent) => {
    e.preventDefault()
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize'
    const move = (ev: PointerEvent) => {
      const el = panesRef.current; if (!el) return
      const r = el.getBoundingClientRect(); if (r.width <= 0) return
      setSplitFrac(Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''; document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // 左侧文件栏宽度：可拖拽调整，记 localStorage
  const [dockW, setDockW] = useState(() => { const s = Number(localStorage.getItem('ttmux.fileDockW')); return s >= 160 && s <= 640 ? s : 280 })
  const dockWRef = useRef(dockW)
  dockWRef.current = dockW
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX, startW = dockW
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize'
    const move = (ev: PointerEvent) => setDockW(Math.min(640, Math.max(160, startW + ev.clientX - startX)))
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''; document.body.style.cursor = ''
      localStorage.setItem('ttmux.fileDockW', String(dockWRef.current))
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const dragHasPayload = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(PATH_MIME) || e.dataTransfer.types.includes(LEAD_MIME)
  const applyDrop = (e: React.DragEvent, to: Group) => {
    if (e.dataTransfer.types.includes(LEAD_MIME)) { setSwapped(to !== leftGroup); return } // 会话拖到某栏 → 会话那栏挪到该侧
    const tab = e.dataTransfer.getData(TAB_MIME)
    if (tab) { try { const { path, from } = JSON.parse(tab); moveTab(path, from, to) } catch {} ; return }
    const p = e.dataTransfer.getData(PATH_MIME)
    if (p) openInGroup(p, to)
  }

  const tabBase: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', fontSize: 12, cursor: 'pointer', borderRight: '1px solid var(--border)' }

  const fileTab = (f: string, g: Group) => {
    const prev = isPreview(f)
    const rp = realPath(f)
    const isDirty = !prev && dirtyFiles.has(f)
    const act = activeOf(g) === f
    return (
      <div key={g + f} title={prev ? `${t('file.preview')} · ${rp}` : f} draggable
        onDragStart={(e) => { e.dataTransfer.setData(TAB_MIME, JSON.stringify({ path: f, from: g })); e.dataTransfer.effectAllowed = 'move' }}
        onClick={() => { setActiveOf(g, f); setFocus(g) }}
        className={`cc-filetab${isDirty ? ' dirty' : ''}`}
        style={{ ...tabBase, gap: 3, padding: '5px 8px 5px 10px', color: act ? 'var(--text-bright)' : 'var(--text-dim)', background: act ? 'var(--bg-base)' : 'transparent', borderTop: `2px solid ${act ? '#58a6ff' : 'transparent'}` }}>
        <span style={{ display: 'inline-flex', transform: 'scale(0.72)' }}><FileTypeIcon name={rp} /></span>
        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', fontStyle: prev ? 'italic' : undefined }}>{prev ? `${t('file.preview')}: ${baseName(rp)}` : baseName(f)}</span>
        <a className="cc-tabx" onClick={(e) => { e.stopPropagation(); closeFileTab(f, g) }} title={isDirty ? t('file.unsaved') : t('file.closeTab')}>
          <span className="dot">●</span><span className="x">×</span>
        </a>
      </div>
    )
  }

  // 渲染一个编辑组（栏）：tab 条 + 内容（会话内容仅 A 栏；文件用 Monaco 覆盖）
  const pane = (g: Group) => {
    const primary = g === 'A'
    const files = filesOf(g)
    const active = activeOf(g)
    const grow = !split ? 1 : (g === leftGroup ? splitFrac : 1 - splitFrac)
    return (
      <div style={{ flex: `${grow} 1 0`, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        onClick={() => setFocus(g)}>
        <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border)', background: 'var(--bg-container)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}
            onDragOver={(e) => { if (dragHasPayload(e)) { e.preventDefault(); setDropHint(g) } }}
            onDragLeave={() => setDropHint((h) => (h === g ? null : h))}
            onDrop={(e) => { if (dragHasPayload(e)) { e.preventDefault(); setDropHint(null); applyDrop(e, g) } }}>
            {primary && hasLeading && (
              <div onClick={() => setActiveOf('A', null)} title={leadingTitle}
                draggable={split}
                onDragStart={(e) => { e.dataTransfer.setData(LEAD_MIME, '1'); e.dataTransfer.effectAllowed = 'move' }}
                style={{ ...tabBase, gap: 6, padding: '5px 12px', color: leadingActive ? 'var(--text-bright)' : 'var(--text-dim)', background: leadingActive ? 'var(--bg-base)' : 'transparent', borderTop: `2px solid ${leadingActive ? '#58a6ff' : 'transparent'}` }}>
                {leadingTab}
              </div>
            )}
            {files.map((f) => fileTab(f, g))}
            {dropHint === g && <div style={{ flex: 1, minWidth: 24, background: 'rgba(88,166,255,.18)' }} />}
          </div>
        </div>
        {/* 会话工具栏：只属会话，放在会话首 tab 的正下方、终端之上（跟着会话那栏走） */}
        {primary && leadingActive && chrome}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex' }}
          onDragOver={(e) => { if (dragHasPayload(e)) { e.preventDefault(); if (!split && primary) setDropHint('split'); else setDropHint(g) } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHint(null) }}
          onDrop={(e) => {
            if (!dragHasPayload(e)) return
            e.preventDefault()
            const target: Group = (!split && primary && dropHint === 'split') ? 'B' : g
            setDropHint(null); applyDrop(e, target)
          }}>
          {primary && leadingContent}
          {files.map((f) => {
            const prev = isPreview(f)
            return (
              <div key={f} style={{ position: 'absolute', inset: 0, zIndex: 6, background: 'var(--bg-base)', display: active === f ? 'block' : 'none' }}>
                <Viewer path={realPath(f)} accent={accent} inline tabbed forcePreview={prev} active={active === f}
                  onClose={() => closeFileTab(f, g)} onOpenPath={(p) => openInGroup(p, g)}
                  onDirtyChange={prev ? undefined : setFileDirty} onOpenAgent={onOpenAgent}
                  onPreviewToSide={prev ? undefined : (p) => openPreviewToSide(g, p)} />
              </div>
            )
          })}
          {(!primary || !hasLeading) && active === null && files.length === 0 && (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dimmer)', fontSize: 13 }}>{emptyText || t('file.selectPreview')}</div>
          )}
          {/* 单栏时拖到右半区 → 拆出第二栏 */}
          {!split && primary && dropHint === 'split' && (
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '50%', zIndex: 20, pointerEvents: 'none', background: 'rgba(88,166,255,.12)', borderLeft: '2px dashed #58a6ff', display: 'grid', placeItems: 'center', color: '#58a6ff', fontSize: 13, fontWeight: 600 }}>{t('file.splitHere')}</div>
          )}
        </div>
        {/* 会话底部输入/快捷键栏：只属会话，放在会话那栏终端下方 */}
        {primary && leadingActive && footer}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {explorerOpen && (
        <>
          <div style={{ flex: `0 0 ${dockW}px`, minWidth: 0, minHeight: 0, display: 'flex' }}>
            <FileBrowser dir={dir} accent={accent} layout="dock" onClose={onExplorerClose} onOpenFile={openFileTab} selectedPath={activeA ? realPath(activeA) : null} onOpenAgent={onOpenAgent} />
          </div>
          <div onPointerDown={startResize} title={t('file.dragResize')} style={{ flex: '0 0 5px', cursor: 'col-resize', background: 'var(--border)', touchAction: 'none' }} />
        </>
      )}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div ref={panesRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {(split ? (swapped ? ['B', 'A'] : ['A', 'B']) : ['A'] as Group[]).map((g, i) => (
            // key 按组固定 → 易位/分栏时 React 不重挂终端(会话)，PTY/xterm 不断
            <Fragment key={g}>
              {i > 0 && <div onPointerDown={startSplitResize} title={t('file.dragResize')} style={{ flex: '0 0 5px', cursor: 'col-resize', background: 'var(--border)', touchAction: 'none' }} />}
              {pane(g as Group)}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
