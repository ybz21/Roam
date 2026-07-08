// 文件侧栏 —— 在 Claude / Codex 对话页右侧浏览工作目录、查看文件内容（类似 codex 右侧边栏）。
// 单层可导航列表：目录在前可进入、↑ 回上级、点文件在弹层里查看正文。
import { type ReactNode, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Button, ConfigProvider, Dropdown, Input, Modal, Spin, App as AntApp, Tooltip, type MenuProps } from 'antd'
import { api, upload } from './api'
import { useI18n } from './i18n'
import { recentDirs } from './App'
import { dirname, fileNameOf, fmtSize, joinPath, normalizePath } from './file-utils'
import {
  BackIcon, Chevron, ClosePanelButton, CloseIcon, DownloadIcon, EyeIcon, EyeOffIcon, FileTypeIcon, FolderIcon,
  FolderUpIcon, ForwardIcon, IconButton, ListIcon, NewFolderIcon, RefreshIcon, SearchIcon, SortIcon, TreeIcon, UploadIcon,
} from './file-icons'
import { Viewer } from './fileview'

interface Entry { name: string; dir: boolean; size: number; mtime: number; ctime: number }
interface Dir { path: string; parent: string; entries: Entry[] }
interface FileTarget extends Entry { path: string }
interface FileStat {
  path: string
  name: string
  dir: boolean
  size: number
  mtime: number
  ctime: number
  mode: string
  entryCount?: number
}

type SortKey = 'name' | 'kind' | 'mtime' | 'ctime' | 'size'

function entryExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function sortEntries(entries: Entry[], key: SortKey): Entry[] {
  const sorted = [...entries]
  sorted.sort((a, b) => {
    // ponytail: dirs always first, secondary sort by key
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    switch (key) {
      case 'name': return a.name.localeCompare(b.name)
      case 'kind': return entryExt(a.name).localeCompare(entryExt(b.name)) || a.name.localeCompare(b.name)
      case 'mtime': return b.mtime - a.mtime || a.name.localeCompare(b.name)
      case 'ctime': return b.ctime - a.ctime || a.name.localeCompare(b.name)
      case 'size': return b.size - a.size || a.name.localeCompare(b.name)
    }
  })
  return sorted
}

function displayPath(path: string): string {
  return path || '/'
}

const PathOption = ({ kind, path, name, dir }: { kind: string; path: string; name?: string; dir?: boolean }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 260, maxWidth: 560 }}>
    <span style={{ color: dir ? 'var(--text-bright)' : 'var(--text-dimmer)', width: 20, display: 'inline-flex', justifyContent: 'center' }}>
      {dir ? <FolderIcon /> : name ? <FileTypeIcon name={name} /> : <FolderIcon />}
    </span>
    <span style={{ color: 'var(--text-bright)', fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {name || path}
    </span>
    <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>{kind}</span>
  </div>
)
function formatJSON(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function fence(lang: string, content: string): string {
  return '```' + lang + '\n' + content + '\n```'
}

// 统一：把文件绝对路径写进拖拽载荷（对话框识别 application/x-ttmux-path，其余认 text/plain）。
function startPathDrag(ev: React.DragEvent, full: string) {
  ev.dataTransfer.setData('application/x-ttmux-path', full)
  ev.dataTransfer.setData('text/plain', full)
  ev.dataTransfer.effectAllowed = 'copy'
}

function FileContextMenu({ target, children, onContextFocus, onContextBlur, onOpen, onRename, onCopyTo, onUploadHere, onDownload, onProperties, onDelete, onInsertPath }: {
  target: FileTarget
  children: ReactNode
  onContextFocus: (target: FileTarget) => void
  onContextBlur: (target: FileTarget) => void
  onOpen: (target: FileTarget) => void
  onRename: (target: FileTarget) => void
  onCopyTo: (target: FileTarget) => void
  onUploadHere: (target: FileTarget) => void
  onDownload: (target: FileTarget) => void
  onProperties: (target: FileTarget) => void
  onDelete: (target: FileTarget) => void
  onInsertPath?: (path: string) => void
}) {
  const { t } = useI18n()
  const items: MenuProps['items'] = [
    { key: 'open', label: target.dir ? t('file.openFolder') : t('file.open') },
    { key: 'rename', label: t('file.rename') },
    { key: 'copyTo', label: t('file.copyTo') },
    ...(target.dir ? [{ key: 'uploadHere', label: t('file.uploadHere') }] : []),
    { key: 'download', label: target.dir ? t('file.downloadZip') : t('file.download') },
    ...(onInsertPath ? [{ key: 'insertPath', label: t('file.insertPath') }] : []),
    { key: 'properties', label: t('file.properties') },
    { type: 'divider' as const },
    { key: 'delete', label: t('file.delete'), danger: true },
  ]
  const onClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    if (key === 'open') onOpen(target)
    else if (key === 'rename') onRename(target)
    else if (key === 'copyTo') onCopyTo(target)
    else if (key === 'uploadHere') onUploadHere(target)
    else if (key === 'download') onDownload(target)
    else if (key === 'insertPath') onInsertPath?.(target.path)
    else if (key === 'properties') onProperties(target)
    else if (key === 'delete') onDelete(target)
  }
  return (
    <Dropdown trigger={['contextMenu']} menu={{ items, onClick }} onOpenChange={(open) => { open ? onContextFocus(target) : onContextBlur(target) }}>
      <div onContextMenu={(ev) => { ev.stopPropagation(); onContextFocus(target) }}>{children}</div>
    </Dropdown>
  )
}

// 统一：一行文件/目录的图标 + 名称 + 大小 + @插入 + 下载。平铺列表与树共用（外层容器各自处理缩进/展开）。
function FileRowBody({ full, name, isDir, size, accent, onInsertPath }: {
  full: string; name: string; isDir: boolean; size: number; accent: string; onInsertPath?: (p: string) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <span style={{ color: isDir ? accent : 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex', width: 22, justifyContent: 'center' }}>{isDir ? <FolderIcon /> : <FileTypeIcon name={name} />}</span>
      <span style={{ color: 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {!isDir && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>{fmtSize(size)}</span>}
      {onInsertPath && (
        <span data-file-action>
          <IconButton title={t('file.insertPath')} onClick={() => onInsertPath(full)}>@</IconButton>
        </span>
      )}
      {!isDir && (
        <span data-file-action>
          <Tooltip title={t('file.download')}>
            <Button type="text" size="small" href={`/api/file/raw?path=${encodeURIComponent(full)}&dl=1`} download={name}
              style={{ width: 24, height: 24, minWidth: 24, padding: 0, color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><DownloadIcon /></Button>
          </Tooltip>
        </span>
      )}
    </>
  )
}

// VSCode 风格可展开目录树：以 root 为根，子目录首次展开时懒加载（复用 GET /files?path=）。
// 排序/隐藏文件过滤、点文件预览、拖入终端 @mention、右键删除都与平铺行一致。
function FileTree({
  root, rootEntries, accent, showHidden, sortKey, tick, selected,
  onContextFocus, onContextBlur, onOpenFile, onOpenEntry, onRenameEntry, onCopyEntry, onUploadEntry, onDownloadEntry, onPropertiesEntry, onDeleteEntry, onInsertPath,
}: {
  root: string
  rootEntries: Entry[]
  accent: string
  showHidden: boolean
  sortKey: SortKey
  tick: number
  selected: string | null
  onContextFocus: (target: FileTarget) => void
  onContextBlur: (target: FileTarget) => void
  onOpenFile: (full: string) => void
  onOpenEntry: (target: FileTarget) => void
  onRenameEntry: (target: FileTarget) => void
  onCopyEntry: (target: FileTarget) => void
  onUploadEntry: (target: FileTarget) => void
  onDownloadEntry: (target: FileTarget) => void
  onPropertiesEntry: (target: FileTarget) => void
  onDeleteEntry: (target: FileTarget) => void
  onInsertPath?: (full: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childMap, setChildMap] = useState<Record<string, Entry[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const { t } = useI18n()

  const loadDir = (dirPath: string) => {
    setLoading((m) => ({ ...m, [dirPath]: true }))
    api('GET', `/files?path=${encodeURIComponent(dirPath)}`)
      .then((r) => setChildMap((m) => ({ ...m, [dirPath]: r.data?.entries || [] })))
      .catch(() => setChildMap((m) => ({ ...m, [dirPath]: [] })))
      .finally(() => setLoading((m) => ({ ...m, [dirPath]: false })))
  }
  // 静默重拉子项：不置 loading（保留旧子项直到新数据到），刷新时展开的目录不闪 spinner
  const reloadDir = (dirPath: string) => {
    api('GET', `/files?path=${encodeURIComponent(dirPath)}`)
      .then((r) => setChildMap((m) => ({ ...m, [dirPath]: r.data?.entries || [] })))
      .catch(() => {})
  }

  const prevRoot = useRef(root)
  // 换根目录 → 清空展开态与缓存（旧展开对新目录无意义）。
  // 刷新(tick 变、root 不变) → 保留展开层级，静默重拉各已展开目录的子项，
  // 让新增/删除的文件显示出来而不折叠（顶层 rootEntries 由父组件随 tick 重拉）。
  useEffect(() => {
    if (prevRoot.current !== root) {
      prevRoot.current = root
      setExpanded(new Set()); setChildMap({}); setLoading({})
      return
    }
    expanded.forEach((dirPath) => reloadDir(dirPath))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, tick])
  const toggleDir = (dirPath: string) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(dirPath)) n.delete(dirPath)
      else { n.add(dirPath); if (!(dirPath in childMap)) loadDir(dirPath) }
      return n
    })
  }
  const visible = (entries: Entry[]) => sortEntries((entries || []).filter((e) => showHidden || !e.name.startsWith('.')), sortKey)

  const renderLevel = (dirPath: string, entries: Entry[], depth: number): ReactNode =>
    visible(entries).map((e) => {
      const full = joinPath(dirPath, e.name)
      const target: FileTarget = { ...e, path: full }
      const isOpen = e.dir && expanded.has(full)
      return (
        <Fragment key={full}>
          <FileContextMenu target={target} onContextFocus={onContextFocus} onContextBlur={onContextBlur} onOpen={onOpenEntry} onRename={onRenameEntry} onCopyTo={onCopyEntry} onUploadHere={onUploadEntry} onDownload={onDownloadEntry} onProperties={onPropertiesEntry} onDelete={onDeleteEntry} onInsertPath={onInsertPath}>
            <div className="cc-filerow"
              draggable
              onDragStart={(ev) => startPathDrag(ev, full)}
              onClick={(ev) => {
                if ((ev.target as HTMLElement).closest('[data-file-action]')) return
                e.dir ? toggleDir(full) : onOpenFile(full)
              }}
              style={{ ...rowStyle(), gap: 0, padding: 0, alignItems: 'stretch', minHeight: 26, background: full === selected ? '#1f6feb22' : undefined }}>
              {/* VSCode 式层级缩进导引线：每深一层一条竖线，逐行拼成连续的层级线 */}
              <span style={{ flex: '0 0 auto', width: 8 }} />
              {Array.from({ length: depth }).map((_, i) => (
                <span key={i} aria-hidden style={{ flex: '0 0 auto', width: 14, boxSizing: 'border-box', borderLeft: '1px solid var(--border-subtle)' }} />
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, padding: '4px 8px 4px 2px' }}>
                <span style={{ flex: '0 0 auto', width: 14, display: 'inline-flex', justifyContent: 'center', color: 'var(--text-dim)' }}>
                  {e.dir ? <Chevron open={!!isOpen} /> : null}
                </span>
                <FileRowBody full={full} name={e.name} isDir={e.dir} size={e.size} accent={accent} onInsertPath={onInsertPath} />
              </div>
            </div>
          </FileContextMenu>
          {isOpen && (
            loading[full]
              ? <div style={{ padding: '4px 0 4px', paddingLeft: 8 + (depth + 1) * 14 }}><Spin size="small" /></div>
              : renderLevel(full, childMap[full] || [], depth + 1)
          )}
        </Fragment>
      )
    })

  return <>{renderLevel(root, rootEntries, 0)}</>
}

export default function FileBrowser({
  dir,
  accent = '#58a6ff',
  layout = 'sidebar',
  onClose,
  onInsertPath,
  onOpenAgent,
  onOpenFile,
  selectedPath,
}: {
  dir?: string
  accent?: string
  layout?: 'sidebar' | 'split' | 'dock'
  onClose?: () => void
  onInsertPath?: (p: string) => void
  onOpenAgent?: (kind: 'claude' | 'codex', path: string) => void
  // dock 布局下由外层（编辑器 tab 区）接管文件打开：点文件不再弹内置预览，而是回调让外层开 tab。
  onOpenFile?: (path: string) => void
  // 外层当前激活的文件 tab，用于在浏览器里高亮选中项（覆盖内部 view）。
  selectedPath?: string | null
}) {
  const [path, setPath] = useState(dir || '')
  const [data, setData] = useState<Dir | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<string | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [tick, setTick] = useState(0) // 上传后强制重载当前目录
  const [uploading, setUploading] = useState(false)
  const [history, setHistory] = useState<string[]>([dir || '']) // 浏览器式前进/后退历史
  const [histIdx, setHistIdx] = useState(0)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [mkdirBusy, setMkdirBusy] = useState(false)
  const [renameTarget, setRenameTarget] = useState<FileTarget | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [copyTarget, setCopyTarget] = useState<FileTarget | null>(null)
  const [copyDest, setCopyDest] = useState('')
  const [copyBusy, setCopyBusy] = useState(false)
  const [propertiesTarget, setPropertiesTarget] = useState<FileTarget | null>(null)
  const [properties, setProperties] = useState<FileStat | null>(null)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [contextPath, setContextPath] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false) // 隐藏文件（点号开头）默认不显示，眼睛开关切换
  const [sortKey, setSortKey] = useState<SortKey>('name')
  // 递归按文件名搜索（当前目录向下），放大镜开关切换；有查询词时列表区改显搜索结果。
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; name: string; rel: string }[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchTrunc, setSearchTrunc] = useState(false)
  // 平铺列表 / VSCode 树 两种展示，所有文件面板都可切；localStorage 记住选择。
  // dock（新标签左侧）与 split（独立 Files 页）默认树模式，会话右侧抽屉(sidebar)默认平铺。
  const canToggleView = true
  const [browseMode, setBrowseMode] = useState<'flat' | 'tree'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('ttmux.fileBrowseMode') : null
    if (saved === 'tree' || saved === 'flat') return saved
    return layout === 'sidebar' ? 'flat' : 'tree'
  })
  useEffect(() => {
    if (canToggleView && typeof localStorage !== 'undefined') localStorage.setItem('ttmux.fileBrowseMode', browseMode)
  }, [browseMode, canToggleView])
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<string | null>(null)
  const { message, modal } = AntApp.useApp()
  const { t, locale } = useI18n()

  // 会话切换（dir 变化）→ 回到工作目录根，并重置历史
  useEffect(() => {
    setPath(dir || '')
    setHistory([dir || ''])
    setHistIdx(0)
  }, [dir])

  // 进入新目录：截断当前位置之后的前进记录，再追加并前移
  const navigate = (target: string) => {
    if (target === path) return
    setPath(target)
    setView(null)
    setHistory((h) => [...h.slice(0, histIdx + 1), target])
    setHistIdx((i) => i + 1)
  }
  const canBack = histIdx > 0
  const canForward = histIdx < history.length - 1
  const goBack = () => {
    if (!canBack) return
    const i = histIdx - 1
    setHistIdx(i); setPath(history[i]); setView(null)
  }
  const goForward = () => {
    if (!canForward) return
    const i = histIdx + 1
    setHistIdx(i); setPath(history[i]); setView(null)
  }

  useEffect(() => {
    let stop = false
    setErr('')
    setLoading(true)
    const q = path ? `?path=${encodeURIComponent(path)}` : ''
    api('GET', `/files${q}`)
      .then((r) => { if (!stop) setData(r.data) })
      .catch((e: any) => { if (!stop) setErr(e.apiError?.code === 'DIR_ACCESS_TIMEOUT' ? t('file.dirAccessTimeout', { path: e.apiError.path || path }) : e.message) })
      .finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [path, tick])

  const cur = data?.path || path
  const refresh = () => setTick((t) => t + 1)
  const goUp = () => { if (data && canUp) navigate(data.parent) }
  // 隐藏文件（点号开头）默认过滤掉；眼睛开关开启后全部显示。
  const visibleEntries = sortEntries((data?.entries || []).filter((e) => showHidden || !e.name.startsWith('.')), sortKey)
  const hiddenCount = (data?.entries.length || 0) - visibleEntries.length

  useEffect(() => {
    setPathDraft(displayPath(cur))
  }, [cur])

  // 递归文件名搜索：防抖 250ms，作用域为当前目录 cur。
  const searchQ = query.trim()
  useEffect(() => {
    if (!searchOpen || !searchQ || !cur) { setResults(null); setSearching(false); return }
    setSearching(true)
    let stop = false
    const h = setTimeout(() => {
      api('GET', `/file/search?dir=${encodeURIComponent(cur)}&q=${encodeURIComponent(searchQ)}`)
        .then((r) => { if (!stop) { setResults(r.data?.results || []); setSearchTrunc(!!r.data?.truncated) } })
        .catch(() => { if (!stop) { setResults([]); setSearchTrunc(false) } })
        .finally(() => { if (!stop) setSearching(false) })
    }, 250)
    return () => { stop = true; clearTimeout(h) }
  }, [searchQ, searchOpen, cur, tick])

  const doUpload = async (files: FileList | File[], targetDir = cur) => {
    if (!files || !files.length || !targetDir || uploading) return
    setUploading(true)
    try {
      const res = await upload(targetDir, files)
      message.success(t('file.uploadedCount', { count: res.saved.length }))
      refresh()
    } catch (e: any) { message.error(t('chat.uploadFailed', { message: e.message })) }
    finally { setUploading(false) }
  }
  const doMkdir = async () => {
    const name = mkdirName.trim()
    if (!name || !cur || mkdirBusy) return
    setMkdirBusy(true)
    try {
      await api('POST', '/file/mkdir', { dir: cur, name })
      message.success(t('file.folderCreated'))
      setMkdirOpen(false)
      setMkdirName('')
      refresh()
    } catch (e: any) { message.error(t('file.mkdirFailed', { message: e.message })) }
    finally { setMkdirBusy(false) }
  }
  const deletePath = async (target: string) => {
    try {
      const res = await api('DELETE', `/file?path=${encodeURIComponent(target)}`)
      message.success(res.data?.missing ? t('file.alreadyMissingRefreshed') : t('file.deleted'))
      if (view === target) setView(null)
      refresh()
    } catch (e: any) {
      message.error(t('file.deleteFailed', { message: e.message }))
      throw e
    }
  }
  const confirmDelete = (target: string, isDir: boolean) => {
    modal.confirm({
      title: isDir ? t('file.deleteEmptyDirConfirm') : t('file.deleteFileConfirm'),
      content: target,
      okText: t('file.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => deletePath(target),
    })
  }
  const confirmDeleteTarget = (target: FileTarget) => confirmDelete(target.path, target.dir)
  const markContextTarget = (target: FileTarget) => setContextPath(target.path)
  const clearContextTarget = (target: FileTarget) => setContextPath((path) => (path === target.path ? null : path))
  const openEntry = (target: FileTarget) => { target.dir ? navigate(target.path) : openFile(target.path) }
  const startRename = (target: FileTarget) => {
    setRenameTarget(target)
    setRenameName(target.name)
  }
  const doRename = async () => {
    const name = renameName.trim()
    if (!renameTarget || !name || renameBusy) return
    setRenameBusy(true)
    try {
      const res = await api('POST', '/file/rename', { path: renameTarget.path, name })
      message.success(t('file.renamed'))
      if (view === renameTarget.path) setView(res.data?.path || null)
      setRenameTarget(null)
      refresh()
    } catch (e: any) { message.error(t('file.renameFailed', { message: e.message })) }
    finally { setRenameBusy(false) }
  }
  const startCopy = (target: FileTarget) => {
    setCopyTarget(target)
    setCopyDest(joinPath(dirname(target.path), target.name))
  }
  const doCopy = async () => {
    const target = copyDest.trim()
    if (!copyTarget || !target || copyBusy) return
    setCopyBusy(true)
    try {
      await api('POST', '/file/copy', { path: copyTarget.path, target: resolveTypedPath(target) })
      message.success(t('file.copiedToPath'))
      setCopyTarget(null)
      refresh()
    } catch (e: any) { message.error(t('file.copyToFailed', { message: e.message })) }
    finally { setCopyBusy(false) }
  }
  const uploadInto = (target: FileTarget) => {
    uploadTargetRef.current = target.dir ? target.path : dirname(target.path)
    fileRef.current?.click()
  }
  const downloadEntry = (target: FileTarget) => {
    const a = document.createElement('a')
    a.href = `/api/file/download?path=${encodeURIComponent(target.path)}`
    a.download = target.dir ? `${target.name}.zip` : target.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  const showProperties = async (target: FileTarget) => {
    setPropertiesTarget(target)
    setProperties(null)
    setPropertiesLoading(true)
    try {
      const res = await api('GET', `/file/stat?path=${encodeURIComponent(target.path)}`)
      setProperties(res.data)
    } catch (e: any) {
      message.error(t('file.propertiesFailed', { message: e.message }))
    } finally {
      setPropertiesLoading(false)
    }
  }
  const fmtTime = (ts?: number) => {
    if (!ts) return t('file.unknown')
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ts * 1000))
  }
  // 根目录之上不再回退（防止越过工作目录乱逛；dir 为空时允许一直向上）
  const canUp = !!data && data.parent !== data.path && (!dir || cur !== dir)

  // 打开一个文件：dock 布局把打开交给外层（开编辑器 tab），否则用内置预览。
  const openFile = (target: string) => { if (onOpenFile) onOpenFile(target); else setView(target) }
  // 浏览器里高亮的选中项：外层受控（selectedPath）优先，否则用内部 view。
  const sel = contextPath || (selectedPath !== undefined ? selectedPath : view)

  const openPath = async (target: string) => {
    try {
      const res = await api('GET', `/file/stat?path=${encodeURIComponent(target)}`)
      if (res.data?.dir) {
        navigate(target)
      } else {
        openFile(target)
      }
    } catch (e: any) {
      message.error(t('file.openReferenceFailed', { message: e.message }))
    }
  }

  const resolveTypedPath = (value: string): string => {
    const raw = value.trim()
    if (!raw) return cur || '/'
    if (raw.startsWith('/')) return normalizePath(raw)
    return normalizePath(joinPath(cur || '/', raw))
  }

  const submitTypedPath = (value = pathDraft) => {
    const target = resolveTypedPath(value)
    setPathDraft(displayPath(target))
    openPath(target)
  }

  const pathOptions = useMemo(() => {
    const q = pathDraft.trim().toLowerCase()
    const list: { value: string; label: ReactNode }[] = []
    const add = (value: string, label: ReactNode) => {
      if (!value || list.some((x) => x.value === value)) return
      if (q && !value.toLowerCase().includes(q) && !fileNameOf(value).toLowerCase().includes(q)) return
      list.push({ value, label })
    }
    if (cur) add(cur, <PathOption kind={t('file.currentLocation')} path={cur} />)
    if (data?.parent && data.parent !== cur) add(data.parent, <PathOption kind={t('file.parentDir')} path={data.parent} />)
    if (dir && dir !== cur) add(dir, <PathOption kind={t('file.workingDir')} path={dir} />)
    for (const e of data?.entries || []) {
      const full = joinPath(cur || '/', e.name)
      add(full, <PathOption kind={e.dir ? t('file.directory') : t('common.file')} path={full} name={e.name} dir={e.dir} />)
    }
    return list.slice(0, 24)
  }, [cur, data?.entries, data?.parent, dir, pathDraft])

  const browserPane = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0, width: '100%', background: 'var(--bg-container)', borderLeft: '1px solid var(--border-subtle)', position: 'relative', overflow: 'hidden' }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ color: accent }}><FolderIcon /></span>
          <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontSize: 13 }}>{t('chat.fileManager')}</span>
          <span style={{ flex: 1 }} />
          {onClose && <ClosePanelButton title={t('file.closePanel')} onClick={onClose} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'nowrap', overflowX: 'auto' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) doUpload(e.target.files, uploadTargetRef.current || cur)
              uploadTargetRef.current = null
              e.target.value = ''
            }} />
          <IconButton title={t('file.back')} disabled={!canBack} onClick={goBack}><BackIcon /></IconButton>
          <IconButton title={t('file.forward')} disabled={!canForward} onClick={goForward}><ForwardIcon /></IconButton>
          <IconButton title={t('file.up')} disabled={!canUp} onClick={goUp}><FolderUpIcon /></IconButton>
          <IconButton title={t('file.refreshDir')} onClick={refresh}><RefreshIcon /></IconButton>
          <IconButton title={showHidden ? t('file.hideHidden') : t('file.showHidden')} onClick={() => setShowHidden((s) => !s)}>{showHidden ? <EyeIcon /> : <EyeOffIcon />}</IconButton>
          {canToggleView && (
            <IconButton title={browseMode === 'tree' ? t('file.flatView') : t('file.treeView')} onClick={() => setBrowseMode((m) => (m === 'tree' ? 'flat' : 'tree'))}>{browseMode === 'tree' ? <ListIcon /> : <TreeIcon />}</IconButton>
          )}
          <IconButton title={t('file.searchFiles')} onClick={() => { setSearchOpen((s) => { if (s) setQuery(''); return !s }) }}><SearchIcon /></IconButton>
          <Dropdown menu={{ items: ([['name', 'file.sort.name'], ['kind', 'file.sort.kind'], ['mtime', 'file.sort.mtime'], ['ctime', 'file.sort.ctime'], ['size', 'file.sort.size']] as const).map(([k, label]) => ({ key: k, label: t(label), style: k === sortKey ? { color: accent, fontWeight: 600 } : undefined, onClick: () => setSortKey(k) })) }} trigger={['click']}>
            <Tooltip title={t('file.sort')}>
              <Button type="text" size="small" style={{ width: 24, height: 24, minWidth: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><SortIcon /></Button>
            </Tooltip>
          </Dropdown>
          <IconButton title={t('file.newFolder')} disabled={!cur} onClick={() => { setMkdirName(''); setMkdirOpen(true) }}><NewFolderIcon /></IconButton>
          <IconButton title={t('file.uploadHere')} disabled={uploading || !cur} onClick={() => { uploadTargetRef.current = cur; fileRef.current?.click() }}>{uploading ? '…' : <UploadIcon />}</IconButton>
        </div>
      </div>
      {searchOpen && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Input
            size="small"
            autoFocus
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            prefix={<span style={{ color: 'var(--text-dimmer)', display: 'inline-flex' }}><SearchIcon /></span>}
            suffix={searching ? <Spin size="small" /> : null}
            placeholder={t('file.searchPlaceholder')}
            style={{ fontSize: 12 }}
          />
        </div>
      )}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        {(() => {
          const chips: { label: string; path: string }[] = []
          const seen = new Set<string>()
          const add = (label: string, path: string) => { if (path && !seen.has(path)) { seen.add(path); chips.push({ label, path }) } }
          if (dir) add(t('file.workingDir'), dir)
          for (const rd of recentDirs()) { if (rd !== dir) add(fileNameOf(rd), rd) }
          return chips.length > 0 ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {chips.map((c) => (
                <Tooltip key={c.path} title={c.path}>
                  <span onClick={() => navigate(c.path)} style={{
                    cursor: 'pointer', fontSize: 11, padding: '1px 8px', borderRadius: 4,
                    background: c.path === cur ? '#1f6feb' : 'var(--bg-base)', color: c.path === cur ? '#fff' : 'var(--text-dim)',
                    border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap',
                  }}>{c.label}</span>
                </Tooltip>
              ))}
            </div>
          ) : null
        })()}
        <AutoComplete
          value={pathDraft}
          options={pathOptions}
          onChange={(v) => setPathDraft(v)}
          onSelect={(v) => submitTypedPath(v)}
          style={{ width: '100%' }}
          popupMatchSelectWidth={false}
          filterOption={false}
        >
          <Input.Search
            size="small"
            allowClear
            enterButton={t('file.open')}
            onSearch={(v) => submitTypedPath(v)}
            onPressEnter={(e) => submitTypedPath((e.target as HTMLInputElement).value)}
            placeholder={t('file.pathPlaceholder')}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </AutoComplete>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {searchOpen && searchQ ? (
          searching && !results ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>
          ) : results && results.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>{t('file.noMatches')}</div>
          ) : (
            <>
              {searchTrunc && <div style={{ color: '#d29922', fontSize: 11, padding: '4px 10px' }}>{t('file.searchTruncated')}</div>}
              {(results || []).map((r) => (
                <div key={r.path} className="cc-filerow" draggable title={r.rel}
                  onDragStart={(ev) => startPathDrag(ev, r.path)}
                  onClick={() => openFile(r.path)}
                  style={{ ...rowStyle(), background: r.path === sel ? '#1f6feb22' : undefined }}>
                  <span style={{ color: 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex', width: 25, justifyContent: 'center' }}><FileTypeIcon name={r.name} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: 'var(--text-bright)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    <span style={{ color: 'var(--text-dimmer)', fontSize: 11, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rel}</span>
                  </span>
                </div>
              ))}
            </>
          )
        ) : (
        <>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '6px 10px' }}>{err}</div>}
        {canUp && (
          <div onClick={goUp} style={rowStyle()}>
            <span style={{ color: 'var(--text-dim)' }}>↑</span><span style={{ color: 'var(--text-dim)' }}>{t('file.parentDir')}</span>
          </div>
        )}
        {browseMode === 'tree' ? (
          <FileTree root={cur} rootEntries={data?.entries || []} accent={accent} showHidden={showHidden} sortKey={sortKey} tick={tick} selected={sel} onContextFocus={markContextTarget} onContextBlur={clearContextTarget} onOpenFile={openFile} onOpenEntry={openEntry} onRenameEntry={startRename} onCopyEntry={startCopy} onUploadEntry={uploadInto} onDownloadEntry={downloadEntry} onPropertiesEntry={showProperties} onDeleteEntry={confirmDeleteTarget} onInsertPath={onInsertPath} />
        ) : visibleEntries.map((e) => {
          const full = joinPath(cur, e.name)
          const target: FileTarget = { ...e, path: full }
          return (
            <FileContextMenu key={e.name} target={target} onContextFocus={markContextTarget} onContextBlur={clearContextTarget} onOpen={openEntry} onRename={startRename} onCopyTo={startCopy} onUploadHere={uploadInto} onDownload={downloadEntry} onProperties={showProperties} onDelete={confirmDeleteTarget} onInsertPath={onInsertPath}>
              <div className="cc-filerow"
                draggable
                onDragStart={(ev) => startPathDrag(ev, full)}
                onClick={(ev) => {
                  if ((ev.target as HTMLElement).closest('[data-file-action]')) return
                  e.dir ? navigate(full) : openFile(full)
                }}
                style={{ ...rowStyle(), background: full === sel ? '#1f6feb22' : undefined }}>
                <FileRowBody full={full} name={e.name} isDir={e.dir} size={e.size} accent={accent} onInsertPath={onInsertPath} />
              </div>
            </FileContextMenu>
          )
        })}
        {data && data.entries.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>{t('file.emptyDirectory')}</div>}
        {browseMode !== 'tree' && data && data.entries.length > 0 && visibleEntries.length === 0 && (
          <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>{t('file.allHidden', { count: hiddenCount })}</div>
        )}
        </>
        )}
      </div>
      <Modal
        open={mkdirOpen}
        title={t('file.newFolder')}
        okText={t('file.create')}
        cancelText={t('common.cancel')}
        confirmLoading={mkdirBusy}
        onOk={doMkdir}
        onCancel={() => { setMkdirOpen(false); setMkdirName('') }}
      >
        <Input autoFocus value={mkdirName} onChange={(e) => setMkdirName(e.target.value)} onPressEnter={doMkdir} placeholder={t('file.folderName')} />
        <div style={{ marginTop: 8, color: 'var(--text-dimmer)', fontSize: 12, wordBreak: 'break-all' }}>
          {t('file.createUnder', { path: displayPath(cur) })}
        </div>
      </Modal>
      <Modal
        open={!!renameTarget}
        title={t('file.rename')}
        okText={t('file.rename')}
        cancelText={t('common.cancel')}
        confirmLoading={renameBusy}
        onOk={doRename}
        onCancel={() => { setRenameTarget(null); setRenameName('') }}
      >
        <Input autoFocus value={renameName} onChange={(e) => setRenameName(e.target.value)} onPressEnter={doRename} placeholder={t('file.namePlaceholder')} />
        <div style={{ marginTop: 8, color: 'var(--text-dimmer)', fontSize: 12, wordBreak: 'break-all' }}>
          {renameTarget ? t('file.renamePathHint', { path: renameTarget.path }) : null}
        </div>
      </Modal>
      <Modal
        open={!!copyTarget}
        title={t('file.copyTo')}
        okText={t('common.copy')}
        cancelText={t('common.cancel')}
        confirmLoading={copyBusy}
        onOk={doCopy}
        onCancel={() => { setCopyTarget(null); setCopyDest('') }}
      >
        <Input autoFocus value={copyDest} onChange={(e) => setCopyDest(e.target.value)} onPressEnter={doCopy} placeholder={t('file.copyTargetPlaceholder')} />
        <div style={{ marginTop: 8, color: 'var(--text-dimmer)', fontSize: 12, wordBreak: 'break-all' }}>
          {copyTarget ? t('file.copySourceHint', { path: copyTarget.path }) : null}
        </div>
      </Modal>
      <Modal
        open={!!propertiesTarget}
        title={t('file.properties')}
        footer={<Button onClick={() => setPropertiesTarget(null)}>{t('common.close')}</Button>}
        onCancel={() => setPropertiesTarget(null)}
      >
        {propertiesLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spin /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', gap: '8px 12px', fontSize: 13 }}>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.name')}</span>
            <span style={{ color: 'var(--text-bright)', wordBreak: 'break-all' }}>{properties?.name || propertiesTarget?.name}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.type')}</span>
            <span>{properties?.dir ?? propertiesTarget?.dir ? t('file.directory') : t('common.file')}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.path')}</span>
            <span style={{ wordBreak: 'break-all' }}>{properties?.path || propertiesTarget?.path}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.size')}</span>
            <span>{properties?.dir ? t('file.property.folderEntries', { count: properties.entryCount ?? 0 }) : fmtSize(properties?.size ?? propertiesTarget?.size ?? 0)}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.modified')}</span>
            <span>{fmtTime(properties?.mtime || propertiesTarget?.mtime)}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.created')}</span>
            <span>{fmtTime(properties?.ctime || propertiesTarget?.ctime)}</span>
            <span style={{ color: 'var(--text-dim)' }}>{t('file.property.mode')}</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{properties?.mode || t('file.unknown')}</span>
          </div>
        )}
      </Modal>
    </div>
  )

  const content = (() => {
  if (layout === 'split') {
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', background: 'var(--bg-base)' }}>
        <div style={{ flex: '0 0 clamp(220px, 22vw, 300px)', minWidth: 0, borderRight: '1px solid var(--border-subtle)' }}>
          {browserPane}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {view ? (
            <Viewer path={view} accent={accent} inline onClose={() => setView(null)} onOpenPath={openPath} onOpenAgent={onOpenAgent} />
          ) : (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-dimmer)', fontSize: 13 }}>
              {t('file.selectPreview')}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 停靠布局（新标签左侧栏）：只有文件面板本身，预览以 Modal 弹出（右边是终端，不占版面）。
  if (layout === 'dock') {
    return (
      <>
        {browserPane}
        {view && (
          <Viewer path={view} accent={accent} onClose={() => setView(null)} onOpenPath={openPath} onOpenAgent={onOpenAgent} />
        )}
      </>
    )
  }

  if (layout === 'sidebar') {
    return (
      <>
        {browserPane}
        {view && (
          <div
            className="tt-file-detail"
            style={{
              position: 'fixed',
              top: 0,
              bottom: 0,
              height: '100dvh',
              right: 'min(420px, 92vw)',
              zIndex: 1199,
              background: 'var(--bg-base)',
              borderLeft: '1px solid var(--border)',
              boxShadow: 'var(--elevated-shadow)',
            }}
          >
            <Viewer path={view} accent={accent} inline onClose={() => setView(null)} onOpenPath={openPath} />
          </div>
        )}
      </>
    )
  }

  return browserPane
  })()

  // 文件浏览器可能挂在高 z-index 的悬浮抽屉(FloatingFileDrawer, z=1200)里，而 antd 弹层
  // (右键菜单/下拉/Modal)默认基线低于抽屉 → 弹层被抽屉盖住，表现为「右键没反应」。
  // 统一抬高弹层基线，保证无论挂在抽屉、停靠栏还是独立文件页，行为都一致。
  return <ConfigProvider theme={{ token: { zIndexPopupBase: 1300 } }}>{content}</ConfigProvider>
}

function rowStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none' }
}
