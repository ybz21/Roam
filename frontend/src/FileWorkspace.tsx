// 统一「文件工作区」：左侧文件浏览器(可拖拽调宽) + VSCode 式多文件编辑 tab + Monaco 编辑器。
// 支持左右双栏(编辑组 A/B)：拖 tab 到另一栏、或从文件树拖文件到某栏；会话(终端)作为固定首 tab 常驻 A 栏。
// 两处复用：独立 Files 页（纯文件）与新标签 SoloTerminal（会话经 leading* 槽传入）。
import { type ReactNode, Fragment, useEffect, useRef, useState } from 'react'
import { App as AntApp, Dropdown, type MenuProps } from 'antd'
import FileBrowser from './FileBrowser'
import { FileView } from './fileview'
import { FileTypeIcon } from './file-icons'
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
  const [dragging, setDragging] = useState(false) // 原生拖拽进行中 → 每栏内容盖一层透明接盘层，压过终端/Monaco
  // 拖的是 tab/会话(需接盘层压过终端才能移栏) 还是文件路径(要落回终端/对话做 @引用注入,不能被接盘层截走)
  const [dragKind, setDragKind] = useState<'tab' | 'lead' | 'path' | null>(null)
  useEffect(() => {
    // drop 用「冒泡阶段」清理：React 事件委托挂在 document 内层根节点，冒泡到 document 时
    // onDrop 已派发完，此时卸接盘层安全。若用捕获阶段则会赶在 onDrop 前卸掉接盘层 →
    // drop 落到已移除的元素 → onDrop 不触发 → tab 不动。dragend 兜底（拖到界外/取消）。
    const end = () => { setDropHint(null); setDragging(false); setDragKind(null) }
    document.addEventListener('dragend', end)
    document.addEventListener('drop', end)
    return () => { document.removeEventListener('dragend', end); document.removeEventListener('drop', end) }
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

  // ── 触屏拖拽 + 点按菜单兜底 ──
  // HTML5 原生拖拽在触屏不触发；且拖到另一栏时，那栏的终端/Monaco 会吞掉 drag 事件，
  // 导致「拖不进另一个分栏」。这里改用 PointerEvent + elementFromPoint 命中落点栏（爬到
  // 带 data-drop-group 的祖先），绕开内层控件，落点栏一定能识别。
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  type Payload = { kind: 'tab'; path: string; from: Group } | { kind: 'lead' }
  const [touchDrag, setTouchDrag] = useState<{ label: string; x: number; y: number } | null>(null)
  const draggedRef = useRef(false)
  const rightGroup: Group = leftGroup === 'A' ? 'B' : 'A'

  const resolveDropAt = (x: number, y: number): { group: Group; hint: Group | 'split' } | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const zone = el?.closest('[data-drop-group]') as HTMLElement | null
    if (!zone) return null
    const g = zone.getAttribute('data-drop-group') as Group
    if (zone.getAttribute('data-drop-content') === '1' && !split && g === 'A') {
      const r = zone.getBoundingClientRect()
      if (x > r.left + r.width / 2) return { group: 'B', hint: 'split' } // 单栏拖到右半 → 拆栏
    }
    return { group: g, hint: g }
  }
  const applyPayload = (p: Payload, to: Group) => {
    if (p.kind === 'lead') { setSwapped(to !== leftGroup); return }
    moveTab(p.path, p.from, to)
  }
  const startTouchDrag = (e: React.PointerEvent, p: Payload, label: string) => {
    if (e.pointerType === 'mouse') return // 桌面走原生 HTML5 拖拽
    const sx = e.clientX, sy = e.clientY
    let started = false
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return
      started = true; draggedRef.current = true
      ev.preventDefault()
      const hit = resolveDropAt(ev.clientX, ev.clientY)
      setDropHint(hit ? hit.hint : null)
      setTouchDrag({ label, x: ev.clientX, y: ev.clientY })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setTouchDrag(null); setDropHint(null)
      if (started) { const hit = resolveDropAt(ev.clientX, ev.clientY); if (hit) applyPayload(p, hit.group) }
      setTimeout(() => { draggedRef.current = false }, 0) // 让紧随的 click 被忽略
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  // 触屏兜底：tab 上「⋯」菜单，不拖也能移到左右栏 / 分栏
  const buildMenu = (p: Payload): NonNullable<MenuProps['items']> => {
    if (p.kind === 'lead') {
      if (!split) return []
      return leftGroup === 'A'
        ? [{ key: 'r', label: t('file.sessionRight'), onClick: () => setSwapped(true) }]
        : [{ key: 'l', label: t('file.sessionLeft'), onClick: () => setSwapped(false) }]
    }
    if (!split) return [
      { key: 'sr', label: t('file.splitRight'), onClick: () => { moveTab(p.path, p.from, 'B'); setSwapped(false) } },
      { key: 'sl', label: t('file.splitLeft'), onClick: () => { moveTab(p.path, p.from, 'B'); setSwapped(true) } },
    ]
    return p.from === leftGroup
      ? [{ key: 'mr', label: t('file.moveRight'), onClick: () => moveTab(p.path, p.from, rightGroup) }]
      : [{ key: 'ml', label: t('file.moveLeft'), onClick: () => moveTab(p.path, p.from, leftGroup) }]
  }
  const tabMenuBtn = (p: Payload) => {
    if (!coarse) return null
    const items = buildMenu(p)
    if (items.length === 0) return null
    return (
      <Dropdown trigger={['click']} placement="bottomRight" menu={{ items }}>
        <span className="cc-tabmenu" title={t('file.tabActions')} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
          style={{ padding: '0 4px', color: 'var(--text-dim)', fontSize: 15, lineHeight: 1 }}>⋯</span>
      </Dropdown>
    )
  }

  // 内容区(终端/编辑器)拖放：单栏 primary 落右半 → 拆栏，否则落本栏。content div 与拖拽期覆盖层共用。
  const onContentDragOver = (e: React.DragEvent, g: Group, primary: boolean) => {
    if (!dragHasPayload(e)) return
    e.preventDefault()
    if (!split && primary) setDropHint('split'); else setDropHint(g)
  }
  const onContentDrop = (e: React.DragEvent, g: Group, primary: boolean) => {
    if (!dragHasPayload(e)) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const inRightHalf = e.clientX > r.left + r.width / 2
    const target: Group = (!split && primary && inRightHalf) ? 'B' : g
    setDropHint(null); applyDrop(e, target)
  }

  const tabBase: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', fontSize: 12, cursor: 'pointer', borderRight: '1px solid var(--border)', touchAction: 'none' }

  const fileTab = (f: string, g: Group) => {
    const prev = isPreview(f)
    const rp = realPath(f)
    const isDirty = !prev && dirtyFiles.has(f)
    const act = activeOf(g) === f
    return (
      <div key={g + f} title={prev ? `${t('file.preview')} · ${rp}` : f} draggable
        onDragStart={(e) => { e.dataTransfer.setData(TAB_MIME, JSON.stringify({ path: f, from: g })); e.dataTransfer.effectAllowed = 'move'; setDragging(true); setDragKind('tab') }}
        onPointerDown={(e) => startTouchDrag(e, { kind: 'tab', path: f, from: g }, baseName(f))}
        onClick={() => { if (draggedRef.current) return; setActiveOf(g, f); setFocus(g) }}
        className={`cc-filetab${isDirty ? ' dirty' : ''}`}
        style={{ ...tabBase, gap: 3, padding: '5px 8px 5px 10px', color: act ? 'var(--text-bright)' : 'var(--text-dim)', background: act ? 'var(--bg-base)' : 'transparent', borderTop: `2px solid ${act ? '#58a6ff' : 'transparent'}` }}>
        <span style={{ display: 'inline-flex', transform: 'scale(0.72)' }}><FileTypeIcon name={rp} /></span>
        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', fontStyle: prev ? 'italic' : undefined }}>{prev ? `${t('file.preview')}: ${baseName(rp)}` : baseName(f)}</span>
        {tabMenuBtn({ kind: 'tab', path: f, from: g })}
        <a className="cc-tabx" onClick={(e) => { e.stopPropagation(); closeFileTab(f, g) }} onPointerDown={(e) => e.stopPropagation()} title={isDirty ? t('file.unsaved') : t('file.closeTab')}>
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
          <div data-drop-group={g} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}
            onDragOver={(e) => { if (dragHasPayload(e)) { e.preventDefault(); setDropHint(g) } }}
            onDragLeave={() => setDropHint((h) => (h === g ? null : h))}
            onDrop={(e) => { if (dragHasPayload(e)) { e.preventDefault(); setDropHint(null); applyDrop(e, g) } }}>
            {primary && hasLeading && (
              <div onClick={() => { if (draggedRef.current) return; setActiveOf('A', null) }} title={leadingTitle}
                draggable={split}
                onDragStart={(e) => { e.dataTransfer.setData(LEAD_MIME, '1'); e.dataTransfer.effectAllowed = 'move'; setDragging(true); setDragKind('lead') }}
                onPointerDown={(e) => { if (split) startTouchDrag(e, { kind: 'lead' }, leadingTitle || '') }}
                style={{ ...tabBase, gap: 6, padding: '5px 12px', color: leadingActive ? 'var(--text-bright)' : 'var(--text-dim)', background: leadingActive ? 'var(--bg-base)' : 'transparent', borderTop: `2px solid ${leadingActive ? '#58a6ff' : 'transparent'}` }}>
                {leadingTab}
                {tabMenuBtn({ kind: 'lead' })}
              </div>
            )}
            {files.map((f) => fileTab(f, g))}
            {dropHint === g && <div style={{ flex: 1, minWidth: 24, background: 'rgba(88,166,255,.18)' }} />}
          </div>
        </div>
        {/* 会话工具栏：只属会话，放在会话首 tab 的正下方、终端之上（跟着会话那栏走） */}
        {primary && leadingActive && chrome}
        <div data-drop-group={g} data-drop-content="1" style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex' }}
          onDragOver={(e) => onContentDragOver(e, g, primary)}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHint(null) }}
          onDrop={(e) => onContentDrop(e, g, primary)}>
          {primary && leadingContent}
          {files.map((f) => {
            const prev = isPreview(f)
            return (
              <div key={f} style={{ position: 'absolute', inset: 0, zIndex: 6, background: 'var(--bg-base)', display: active === f ? 'block' : 'none' }}>
                <FileView path={realPath(f)} accent={accent} inline tabbed forcePreview={prev} active={active === f}
                  onClose={() => closeFileTab(f, g)} onOpenPath={(p) => openInGroup(p, g)}
                  onDirtyChange={prev ? undefined : setFileDirty} onOpenAgent={onOpenAgent}
                  onPreviewToSide={prev ? undefined : (p) => openPreviewToSide(g, p)} />
              </div>
            )
          })}
          {(!primary || !hasLeading) && active === null && files.length === 0 && (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dimmer)', fontSize: 13 }}>{emptyText || t('file.selectPreview')}</div>
          )}
          {/* 拖拽期透明接盘层：盖在终端/Monaco 之上，抢在它们之前接住 dragover/drop，
              否则拖 tab 到有终端/编辑器的那一栏时事件被内层吞掉 → 拖不进去。
              但拖「文件路径」到正显示会话(终端/对话)的首栏时不盖 → 让终端/ChatShell 自己接住做 @引用注入,
              否则文件会被当成「开文件/分栏」而进不了对话。tab/lead 拖拽照旧盖(移栏必须压过终端)。 */}
          {dragging && !(primary && leadingActive && dragKind === 'path') && (
            <div data-drop-group={g} data-drop-content="1" style={{ position: 'absolute', inset: 0, zIndex: 15 }}
              onDragOver={(e) => onContentDragOver(e, g, primary)}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHint(null) }}
              onDrop={(e) => onContentDrop(e, g, primary)} />
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
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}
      onDragEnter={(e) => {
        if (dragging || !dragHasPayload(e)) return
        setDragging(true)
        // 文件树拖出的路径:onDragStart 在 FileBrowser 里不置 kind,这里补判(唯一非 tab/lead 的来源)
        setDragKind(e.dataTransfer.types.includes(PATH_MIME) ? 'path' : e.dataTransfer.types.includes(LEAD_MIME) ? 'lead' : 'tab')
      }}>
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
      {touchDrag && (
        <div style={{ position: 'fixed', left: touchDrag.x + 12, top: touchDrag.y + 12, zIndex: 9999, pointerEvents: 'none', padding: '4px 10px', fontSize: 12, borderRadius: 6, background: 'var(--bg-container)', border: '1px solid #58a6ff', color: 'var(--text-bright)', boxShadow: '0 4px 16px rgba(0,0,0,.4)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{touchDrag.label}</div>
      )}
    </div>
  )
}
