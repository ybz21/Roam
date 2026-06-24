// 文件侧栏 —— 在 Claude / Codex 对话页右侧浏览工作目录、查看文件内容（类似 codex 右侧边栏）。
// 单层可导航列表：目录在前可进入、↑ 回上级、点文件在弹层里查看正文。
import { type MouseEvent, type ReactNode, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Button, Input, Modal, Space, Spin, App as AntApp, Tooltip } from 'antd'
import { api, upload } from './api'
import Markdown from './Markdown'
import { useI18n } from './i18n'

// Office 预览（docx-preview / xlsx / pptx）依赖很重，只有真正打开 Office 文件才需要：
// 懒加载使其不进入首屏包，按需异步取。
const OfficePreviewers = () => import('./OfficePreviewers')
const DocxFilePreview = lazy(() => OfficePreviewers().then((m) => ({ default: m.DocxFilePreview })))
const ExcelFilePreview = lazy(() => OfficePreviewers().then((m) => ({ default: m.ExcelFilePreview })))
const PptxFilePreview = lazy(() => OfficePreviewers().then((m) => ({ default: m.PptxFilePreview })))

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
const MD_EXT = ['md', 'markdown', 'mdx']
const CODE_LANG: Record<string, string> = {
  py: 'python', pyw: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', mjs: 'javascript', cjs: 'javascript',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', sass: 'sass', less: 'less', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', xml: 'xml', ini: 'ini', env: 'ini', conf: 'ini', Dockerfile: 'dockerfile',
}
function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function fileNameOf(path: string): string {
  return path.split('/').pop() || 'download'
}

interface Entry { name: string; dir: boolean; size: number }
interface Dir { path: string; parent: string; entries: Entry[] }

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K'
  return (n / 1024 / 1024).toFixed(1) + ' M'
}

function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function normalizePath(path: string): string {
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return (abs ? '/' : '') + parts.join('/')
}

function displayPath(path: string): string {
  return path || '/'
}

function stripHashQuery(ref: string): string {
  return ref.split('#')[0].split('?')[0]
}

function localPathFromRef(baseFile: string, ref: string): string | null {
  const raw = stripHashQuery(ref.trim())
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  let clean = raw
  try { clean = decodeURIComponent(raw) } catch { /* keep raw */ }
  return normalizePath(clean.startsWith('/') ? clean : joinPath(dirname(baseFile), clean))
}

function codeLangOf(path: string): string {
  const name = path.split('/').pop() || ''
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile'
  return CODE_LANG[extOf(path)] || ''
}

function parseDelimited(text: string, sep: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote && ch === '"' && text[i + 1] === '"') { cell += '"'; i++; continue }
    if (ch === '"') { quote = !quote; continue }
    if (!quote && ch === sep) { row.push(cell); cell = ''; continue }
    if (!quote && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
      continue
    }
    cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== '')).slice(0, 80).map((r) => r.slice(0, 12))
}

// 目录/文件图标：按 blade-agent 的分类 SVG 思路做轻量映射，避免字母块图标。
const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" opacity="0.9"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z" /></svg>
)
const FileIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
)
const CodeIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
const TableIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /></svg>
const SlidesIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>
const PdfIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><path d="M8 13h8" /><path d="M8 17h5" /></svg>
const ImageIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></svg>
const TextIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><path d="M8 13h8" /><path d="M8 17h8" /><path d="M8 9h3" /></svg>
const ArchiveIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M12 4v16" /><path d="m10 10 4 4" /><path d="m14 10-4 4" /></svg>
const ConfigIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><circle cx="12" cy="15" r="2" /><path d="M12 11v2" /></svg>
const DatabaseIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></svg>
const AudioIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
const VideoIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2" /><path d="m10 8 6 4-6 4V8z" /></svg>
const DesignIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z" /><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="m2 2 7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
type FileIconEntry = { icon: ReactNode; color: string }
const EXT_ICON: Record<string, FileIconEntry> = {}
function regIcon(exts: string[], icon: ReactNode, color: string) {
  for (const ext of exts) EXT_ICON[ext] = { icon, color }
}
regIcon(['py', 'pyw', 'ipynb'], <CodeIcon />, 'hsl(210,70%,58%)')
regIcon(['js', 'jsx', 'mjs', 'cjs'], <CodeIcon />, 'hsl(48,90%,50%)')
regIcon(['ts', 'tsx'], <CodeIcon />, 'hsl(210,80%,55%)')
regIcon(['go'], <CodeIcon />, 'hsl(195,70%,50%)')
regIcon(['rs'], <CodeIcon />, 'hsl(25,80%,55%)')
regIcon(['java', 'kt'], <CodeIcon />, 'hsl(20,85%,52%)')
regIcon(['rb'], <CodeIcon />, 'hsl(0,70%,55%)')
regIcon(['c', 'cpp', 'h', 'hpp'], <CodeIcon />, 'hsl(210,60%,55%)')
regIcon(['cs'], <CodeIcon />, 'hsl(265,55%,55%)')
regIcon(['swift'], <CodeIcon />, 'hsl(20,90%,55%)')
regIcon(['html', 'htm'], <CodeIcon />, 'hsl(15,85%,55%)')
regIcon(['css', 'scss', 'sass', 'less'], <CodeIcon />, 'hsl(210,70%,55%)')
regIcon(['vue'], <CodeIcon />, 'hsl(153,60%,48%)')
regIcon(['php'], <CodeIcon />, 'hsl(240,40%,58%)')
regIcon(['sh', 'bash', 'zsh', 'fish', 'ps1'], <CodeIcon />, 'var(--text-dim)')
regIcon(['sql'], <CodeIcon />, 'hsl(210,50%,55%)')
regIcon(['json', 'jsonl', 'ndjson'], <ConfigIcon />, 'hsl(158,55%,48%)')
regIcon(['yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'lock'], <ConfigIcon />, 'var(--text-dim)')
regIcon(['xml'], <CodeIcon />, 'hsl(25,65%,52%)')
regIcon(['db', 'sqlite', 'parquet'], <DatabaseIcon />, 'hsl(210,50%,55%)')
regIcon(['doc', 'docx', 'odt', 'rtf', 'pages'], <TextIcon />, 'hsl(210,65%,52%)')
regIcon(['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods', 'numbers'], <TableIcon />, 'hsl(140,55%,42%)')
regIcon(['ppt', 'pptx', 'odp', 'key'], <SlidesIcon />, 'hsl(15,80%,52%)')
regIcon(['pdf'], <PdfIcon />, 'hsl(0,65%,50%)')
regIcon(['md', 'markdown', 'txt', 'log', 'tex', 'epub'], <TextIcon />, 'var(--text-dim)')
regIcon(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'heif', 'avif', 'tif', 'tiff', 'svg'], <ImageIcon />, 'hsl(280,55%,58%)')
regIcon(['psd', 'ai', 'fig', 'sketch', 'xd', 'blend'], <DesignIcon />, 'hsl(280,50%,55%)')
regIcon(['mp3', 'wav', 'flac', 'ogg', 'aac', 'aiff', 'm4a', 'mid'], <AudioIcon />, 'hsl(330,60%,55%)')
regIcon(['mp4', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'm4v'], <VideoIcon />, 'hsl(340,65%,52%)')
regIcon(['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz', 'dmg', 'iso', 'pkg'], <ArchiveIcon />, 'hsl(30,50%,48%)')
regIcon(['ttf', 'otf', 'woff', 'woff2'], <FileIcon />, 'var(--text-dim)')
const FileTypeIcon = ({ name }: { name: string }) => {
  const entry = EXT_ICON[extOf(name)] || { icon: <FileIcon />, color: 'var(--text-dimmer)' }
  return (
    <span style={{
      width: 22, height: 22, display: 'inline-grid', placeItems: 'center', color: entry.color,
      flex: '0 0 auto',
    }}>{entry.icon}</span>
  )
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
const FolderUpIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 16V10" /><path d="m9 13 3-3 3 3" /></svg>
)
const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></svg>
)
const BackIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
)
const ForwardIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
)
const NewFolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></svg>
)
const UploadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16h2a4 4 0 0 0 .7-7.9A6 6 0 0 0 7.4 6.8 5 5 0 0 0 8 16h1" /><path d="M12 18V10" /><path d="m8.5 13.5 3.5-3.5 3.5 3.5" /></svg>
)
const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10" /><path d="m8.5 9.5 3.5 3.5 3.5-3.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
)
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
)
const IconButton = ({ title, children, danger, onClick, disabled, width = 24 }: { title: string; children: React.ReactNode; danger?: boolean; onClick?: (e: React.MouseEvent) => void; disabled?: boolean; width?: number | string }) => (
  <Tooltip title={title}>
    <Button type="text" size="small" disabled={disabled} danger={danger} onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
      style={{ width, height: 24, minWidth: 24, padding: width === 24 ? 0 : '0 6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      {children}
    </Button>
  </Tooltip>
)

const ClosePanelButton = ({ title, onClick }: { title: string; onClick: () => void }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    className="tt-file-close"
    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
  >
    <CloseIcon />
  </button>
)

function OfficePreview({ name, previewUrl, rawUrl, downloadUrl, downloadName, height }: { name: string; previewUrl: string; rawUrl: string; downloadUrl: string; downloadName: string; height: string }) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let stop = false
    let objectUrl = ''
    setUrl('')
    setErr('')
    fetch(previewUrl).then(async (r) => {
      if (!r.ok) {
        const data = await r.json().catch(() => null)
        throw new Error(data?.error?.message || data?.error?.code || `HTTP ${r.status}`)
      }
      return r.blob()
    }).then((blob) => {
      if (stop) return
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch((e) => {
      if (!stop) setErr(e.message || 'Office 预览生成失败')
    })
    return () => {
      stop = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [previewUrl])

  if (err) {
    return (
      <div style={{ minHeight: height, padding: 18, color: 'var(--text-dim)', lineHeight: 1.7 }}>
        <div style={{ color: 'var(--text-bright)', fontWeight: 700, marginBottom: 6 }}>{name}</div>
        <div>{err}</div>
        <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="small" type="primary" href={downloadUrl} download={downloadName}>{t('file.downloadFile')}</Button>
          <Button size="small" href={rawUrl} target="_blank">{t('file.openRaw')}</Button>
        </div>
      </div>
    )
  }
  if (!url) return <div style={{ height, display: 'grid', placeItems: 'center' }}><Spin /></div>
  return <iframe title={name} src={url} style={{ width: '100%', height, border: 0, background: '#fff' }} />
}

function Viewer({
  path,
  accent,
  inline,
  onClose,
  onOpenPath,
  onOpenAgent,
}: {
  path: string
  accent: string
  inline?: boolean
  onClose: () => void
  onOpenPath: (p: string) => void
  onOpenAgent?: (kind: 'claude' | 'codex', path: string) => void
}) {
  const ext = extOf(path)
  const isImg = IMG_EXT.includes(ext)
  const isMd = MD_EXT.includes(ext)
  const isPdf = ext === 'pdf'
  const isOffice = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'odp'].includes(ext)
  const isDocxPreview = ext === 'docx'
  const isExcelPreview = ['xls', 'xlsx', 'xlsm', 'ods'].includes(ext)
  const isPptxPreview = ext === 'pptx'
  const isSheetText = ['csv', 'tsv'].includes(ext)
  const codeLang = codeLangOf(path)
  const rawUrl = `/api/file/raw?path=${encodeURIComponent(path)}`
  const previewUrl = `/api/file/preview?path=${encodeURIComponent(path)}`
  const downloadUrl = `${rawUrl}&dl=1`
  const downloadName = fileNameOf(path)
  const previewHeight = inline ? '100%' : '74vh'
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [source, setSource] = useState(false) // markdown：源码/渲染切换
  const [agentPick, setAgentPick] = useState(false)
  const { message } = AntApp.useApp()
  const { t } = useI18n()

  useEffect(() => {
    if (isImg || isPdf || isOffice) return // 图片/PDF/Office 直接走 raw 或专用面板
    setData(null); setErr(''); setSource(false)
    api('GET', `/file?path=${encodeURIComponent(path)}`).then((r) => setData(r.data)).catch((e) => setErr(e.message))
  }, [path, isImg, isPdf, isOffice])

  const name = fileNameOf(path)
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      message.success(t('file.pathCopied'))
    } catch {
      message.error(t('common.copyFailed'))
    }
  }
  const codePre = (text: string) => (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto', height: previewHeight, background: 'var(--bg-base)', padding: 12, borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-bright)' }}>{text}</pre>
  )
  const resolvePreviewHref = (href: string, kind: 'link' | 'image') => {
    const local = localPathFromRef(path, href)
    if (!local) return href
    if (kind === 'image') return `/api/file/raw?path=${encodeURIComponent(local)}`
    return `/api/file/raw?path=${encodeURIComponent(local)}`
  }
  const openPreviewLink = (href: string, ev: MouseEvent<HTMLAnchorElement>) => {
    const local = localPathFromRef(path, href)
    if (!local) return
    ev.preventDefault()
    onOpenPath(local)
  }
  const previewShell = (title: string, body: React.ReactNode) => (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-base)', height: inline ? '100%' : undefined, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: 12 }}>
        <FileTypeIcon name={path} />
        <span>{title}</span>
        {data?.truncated && <span style={{ marginLeft: 'auto', color: '#d29922' }}>{t('file.truncatedShort')}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{body}</div>
    </div>
  )
  const csvTable = (text: string, sep: ',' | '\t') => {
    const rows = parseDelimited(text, sep)
    const head = rows[0] || []
    const body = rows.slice(1)
    return previewShell(t('file.tablePreviewTitle', { kind: sep === ',' ? 'CSV' : 'TSV' }), (
      <div style={{ height: previewHeight, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>{head.length > 0 && <tr>{head.map((c, i) => <th key={i} style={cellStyle(true)}>{c || t('file.column', { index: i + 1 })}</th>)}</tr>}</thead>
          <tbody>{body.map((r, i) => <tr key={i}>{head.map((_, j) => <td key={j} style={cellStyle(false)}>{r[j] || ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
    ))
  }

  const titleNode = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: inline ? 0 : 28, minWidth: 0 }}>
      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ color: accent }}>▸</span> {name}
      </span>
      <span style={{ flex: 1, minWidth: 8 }} />
      {isMd && data && !data.binary && (
        <Button size="small" onClick={() => setSource((s) => !s)}>{source ? t('file.rendered') : t('file.source')}</Button>
      )}
      {onOpenAgent && (
        <Button size="small" onClick={() => setAgentPick(true)}>{t('file.openInAgent')}</Button>
      )}
      <Button size="small" onClick={copyPath}>{t('file.copyPath')}</Button>
      <Button size="small" href={downloadUrl} download={downloadName}>{t('file.download')}</Button>
      <a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('file.raw')}</a>
      {inline && <IconButton title={t('file.closePreview')} onClick={onClose}><CloseIcon /></IconButton>}
    </div>
  )
  const bodyNode = (
    <>
      {isImg ? (
        <div style={{ height: '100%', textAlign: 'center', background: 'var(--bg-base)', borderRadius: 8, padding: 12, display: 'grid', placeItems: 'center' }}>
          <img src={rawUrl} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      ) : isPdf ? (
        previewShell(t('file.pdfPreview'), <iframe title={name} src={rawUrl} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />)
      ) : isDocxPreview ? (
        previewShell(t('file.wordPreview'), <Suspense fallback={<Spin />}><DocxFilePreview src={rawUrl} name={name} downloadUrl={downloadUrl} /></Suspense>)
      ) : isExcelPreview ? (
        previewShell(t('file.excelPreview'), <Suspense fallback={<Spin />}><ExcelFilePreview src={rawUrl} name={name} downloadUrl={downloadUrl} /></Suspense>)
      ) : isPptxPreview ? (
        previewShell(t('file.pptPreview'), <Suspense fallback={<Spin />}><PptxFilePreview src={rawUrl} name={name} downloadUrl={downloadUrl} /></Suspense>)
      ) : isOffice ? (
        previewShell(t('file.officePreview'), (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <OfficePreview name={name} previewUrl={previewUrl} rawUrl={rawUrl} downloadUrl={downloadUrl} downloadName={downloadName} height="100%" />
            </div>
            <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{t('file.officePreviewHelp')}</span>
              <Button size="small" type="primary" href={downloadUrl} download={downloadName}>{t('file.downloadFile')}</Button>
              <Button size="small" href={rawUrl} target="_blank">{t('file.openRaw')}</Button>
            </div>
          </div>
        ))
      ) : (
        <>
          {err && <div style={{ color: '#f85149' }}>{err}</div>}
          {!data && !err && <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div>}
          {data && data.binary && (
            <div style={{ color: 'var(--text-dim)' }}>{t('file.binaryCannotPreview', { size: fmtSize(data.size) })}<a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: accent }}>{t('file.downloadOrOpenRaw')}</a></div>
          )}
          {data && !data.binary && (
            <>
              {isSheetText
                ? csvTable(data.content, ext === 'tsv' ? '\t' : ',')
                : isMd && !source
                  ? <div style={{ height: previewHeight, overflow: 'auto' }}><Markdown accent={accent} resolveHref={resolvePreviewHref} onLinkClick={openPreviewLink}>{data.content}</Markdown></div>
                  : ext === 'json'
                    ? previewShell(t('file.jsonPreview'), <div style={{ height: previewHeight, boxSizing: 'border-box', overflow: 'auto', padding: 12 }}><Markdown accent={accent} fill>{fence('json', formatJSON(data.content))}</Markdown></div>)
                    : codeLang
                      ? previewShell(t('file.codePreview', { lang: codeLang.toUpperCase() }), <div style={{ height: previewHeight, boxSizing: 'border-box', overflow: 'auto', padding: 12 }}><Markdown accent={accent} fill>{fence(codeLang, data.content)}</Markdown></div>)
                      : codePre(data.content)}
              {data.truncated && <div style={{ color: '#d29922', fontSize: 12, marginTop: 6 }}>⚠ {t('file.truncatedLong')}</div>}
            </>
          )}
        </>
      )}
      {onOpenAgent && (
        <Modal open={agentPick} title={t('file.openInAgent')} footer={null} onCancel={() => setAgentPick(false)}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div style={{ color: 'var(--text-dim)', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{path}</div>
            <Space>
              <Button type="primary" onClick={() => { setAgentPick(false); onOpenAgent('claude', path) }}>Claude Code</Button>
              <Button onClick={() => { setAgentPick(false); onOpenAgent('codex', path) }}>Codex</Button>
            </Space>
          </Space>
        </Modal>
      )}
    </>
  )

  if (inline) {
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
        <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)' }}>{titleNode}</div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 12 }}>{bodyNode}</div>
      </div>
    )
  }

  return (
    <Modal open onCancel={onClose} footer={null} width="min(900px,94vw)" title={titleNode}>
      {bodyNode}
    </Modal>
  )
}

function cellStyle(head: boolean): React.CSSProperties {
  return {
    padding: '6px 8px', border: '1px solid var(--border-subtle)', textAlign: 'left',
    background: head ? 'var(--bg-container)' : 'transparent', color: head ? 'var(--text-bright)' : 'var(--text-dim)',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }
}

function formatJSON(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function fence(lang: string, content: string): string {
  return '```' + lang + '\n' + content + '\n```'
}

export default function FileBrowser({
  dir,
  accent = '#58a6ff',
  layout = 'sidebar',
  onClose,
  onInsertPath,
  onOpenAgent,
}: {
  dir?: string
  accent?: string
  layout?: 'sidebar' | 'split'
  onClose?: () => void
  onInsertPath?: (p: string) => void
  onOpenAgent?: (kind: 'claude' | 'codex', path: string) => void
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
  const fileRef = useRef<HTMLInputElement>(null)
  const { message, modal } = AntApp.useApp()
  const { t } = useI18n()

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
      .catch((e) => { if (!stop) setErr(e.message) })
      .finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [path, tick])

  const cur = data?.path || path
  const refresh = () => setTick((t) => t + 1)
  const goUp = () => { if (data && canUp) navigate(data.parent) }

  useEffect(() => {
    setPathDraft(displayPath(cur))
  }, [cur])

  const doUpload = async (files: FileList | File[]) => {
    if (!files || !files.length || !cur || uploading) return
    setUploading(true)
    try {
      const res = await upload(cur, files)
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
  // 根目录之上不再回退（防止越过工作目录乱逛；dir 为空时允许一直向上）
  const canUp = !!data && data.parent !== data.path && (!dir || cur !== dir)

  const openPath = async (target: string) => {
    try {
      const res = await api('GET', `/file/stat?path=${encodeURIComponent(target)}`)
      if (res.data?.dir) {
        navigate(target)
      } else {
        setView(target)
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) doUpload(e.target.files); e.target.value = '' }} />
          <IconButton title={t('file.back')} disabled={!canBack} onClick={goBack}><BackIcon /></IconButton>
          <IconButton title={t('file.forward')} disabled={!canForward} onClick={goForward}><ForwardIcon /></IconButton>
          <IconButton title={t('file.up')} disabled={!canUp} onClick={goUp}><FolderUpIcon /></IconButton>
          <IconButton title={t('file.refreshDir')} onClick={refresh}><RefreshIcon /></IconButton>
          <IconButton title={t('file.newFolder')} disabled={!cur} onClick={() => { setMkdirName(''); setMkdirOpen(true) }}><NewFolderIcon /></IconButton>
          <IconButton title={t('file.uploadHere')} disabled={uploading || !cur} onClick={() => fileRef.current?.click()}>{uploading ? '…' : <UploadIcon />}</IconButton>
        </div>
      </div>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
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
        <div style={{ marginTop: 4, color: 'var(--text-dimmer)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t('file.pathHint')}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '6px 10px' }}>{err}</div>}
        {canUp && (
          <div onClick={goUp} style={rowStyle()}>
            <span style={{ color: 'var(--text-dim)' }}>↑</span><span style={{ color: 'var(--text-dim)' }}>{t('file.parentDir')}</span>
          </div>
        )}
        {data?.entries.map((e) => (
          <div key={e.name} className="cc-filerow"
            draggable
            onDragStart={(ev) => {
              const full = joinPath(cur, e.name)
              ev.dataTransfer.setData('application/x-ttmux-path', full) // 给对话框识别用
              ev.dataTransfer.setData('text/plain', full)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={(ev) => {
              if ((ev.target as HTMLElement).closest('[data-file-action]')) return
              e.dir ? navigate(joinPath(cur, e.name)) : setView(joinPath(cur, e.name))
            }}
            onContextMenu={(ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              confirmDelete(joinPath(cur, e.name), e.dir)
            }}
            style={rowStyle()}>
            <span style={{ color: e.dir ? accent : 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex', width: 25, justifyContent: 'center' }}>{e.dir ? <FolderIcon /> : <FileTypeIcon name={e.name} />}</span>
            <span style={{ color: e.dir ? 'var(--text-bright)' : 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {!e.dir && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>{fmtSize(e.size)}</span>}
            {onInsertPath && (
              <span data-file-action>
                <IconButton title={t('file.insertPath')} onClick={() => onInsertPath(joinPath(cur, e.name))}>@</IconButton>
              </span>
            )}
            {!e.dir && (
              <>
                <span data-file-action>
                  <Tooltip title={t('file.download')}>
                    <Button type="text" size="small" href={`/api/file/raw?path=${encodeURIComponent(joinPath(cur, e.name))}&dl=1`} download={e.name}
                      style={{ width: 24, height: 24, minWidth: 24, padding: 0, color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><DownloadIcon /></Button>
                  </Tooltip>
                </span>
              </>
            )}
          </div>
        ))}
        {data && data.entries.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>{t('file.emptyDirectory')}</div>}
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
    </div>
  )

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
}

function rowStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none' }
}
