// 文件侧栏 —— 在 Claude / Codex 对话页右侧浏览工作目录、查看文件内容（类似 codex 右侧边栏）。
// 单层可导航列表：目录在前可进入、↑ 回上级、点文件在弹层里查看正文。
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button, Modal, Spin, App as AntApp, Popconfirm, Tooltip } from 'antd'
import { api, upload } from './api'
import Markdown from './Markdown'

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
const FolderUpIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 16V10" /><path d="m9 13 3-3 3 3" /></svg>
)
const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></svg>
)
const UploadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16h2a4 4 0 0 0 .7-7.9A6 6 0 0 0 7.4 6.8 5 5 0 0 0 8 16h1" /><path d="M12 18V10" /><path d="m8.5 13.5 3.5-3.5 3.5 3.5" /></svg>
)
const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10" /><path d="m8.5 9.5 3.5 3.5 3.5-3.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
)
const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
)
const EnterIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h12" /><path d="m13 8 4 4-4 4" /><path d="M19 5v14" /></svg>
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
function Viewer({ path, accent, onClose, onDelete }: { path: string; accent: string; onClose: () => void; onDelete: (p: string) => Promise<void> }) {
  const ext = extOf(path)
  const isImg = IMG_EXT.includes(ext)
  const isMd = MD_EXT.includes(ext)
  const isPdf = ext === 'pdf'
  const isOffice = ['doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'rtf'].includes(ext)
  const isSheetText = ['csv', 'tsv'].includes(ext)
  const codeLang = codeLangOf(path)
  const rawUrl = `/api/file/raw?path=${encodeURIComponent(path)}`
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [source, setSource] = useState(false) // markdown：源码/渲染切换
  const { message } = AntApp.useApp()

  useEffect(() => {
    if (isImg || isPdf || isOffice) return // 图片/PDF/Office 直接走 raw 或专用面板
    setData(null); setErr(''); setSource(false)
    api('GET', `/file?path=${encodeURIComponent(path)}`).then((r) => setData(r.data)).catch((e) => setErr(e.message))
  }, [path, isImg, isPdf, isOffice])

  const name = path.split('/').pop()
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      message.success('已复制路径')
    } catch {
      message.error('复制失败')
    }
  }
  const codePre = (text: string) => (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto', maxHeight: '70vh', background: 'var(--bg-base)', padding: 12, borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.5, color: '#c9d1d9' }}>{text}</pre>
  )
  const previewShell = (title: string, body: React.ReactNode) => (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-base)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: 12 }}>
        <FileTypeIcon name={path} />
        <span>{title}</span>
        {data?.truncated && <span style={{ marginLeft: 'auto', color: '#d29922' }}>仅显示前 512 KB</span>}
      </div>
      {body}
    </div>
  )
  const csvTable = (text: string, sep: ',' | '\t') => {
    const rows = parseDelimited(text, sep)
    const head = rows[0] || []
    const body = rows.slice(1)
    return previewShell(`${sep === ',' ? 'CSV' : 'TSV'} 表格预览 · 最多 80 行 / 12 列`, (
      <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>{head.length > 0 && <tr>{head.map((c, i) => <th key={i} style={cellStyle(true)}>{c || `列 ${i + 1}`}</th>)}</tr>}</thead>
          <tbody>{body.map((r, i) => <tr key={i}>{head.map((_, j) => <td key={j} style={cellStyle(false)}>{r[j] || ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
    ))
  }

  return (
    <Modal open onCancel={onClose} footer={null} width="min(900px,94vw)"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 28 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: accent }}>▸</span> {name}
          </span>
          <span style={{ flex: 1 }} />
          {isMd && data && !data.binary && (
            <Button size="small" onClick={() => setSource((s) => !s)}>{source ? '渲染' : '源码'}</Button>
          )}
          <Button size="small" onClick={copyPath}>复制路径</Button>
          <Button size="small" href={`${rawUrl}&dl=1`}>下载</Button>
          <Popconfirm title="删除此文件？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={async () => { await onDelete(path); onClose() }}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
          <a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)', fontSize: 12 }}>原始</a>
        </div>
      }>
      {isImg ? (
        <div style={{ textAlign: 'center', background: 'var(--bg-base)', borderRadius: 8, padding: 12 }}>
          <img src={rawUrl} alt={name} style={{ maxWidth: '100%', maxHeight: '74vh', objectFit: 'contain' }} />
        </div>
      ) : isPdf ? (
        previewShell('PDF 内嵌预览', <iframe title={name} src={rawUrl} style={{ width: '100%', height: '74vh', border: 0, background: '#fff' }} />)
      ) : isOffice ? (
        previewShell('Office 文件预览', (
          <div style={{ padding: 18, color: 'var(--text-dim)', lineHeight: 1.7 }}>
            <div style={{ color: 'var(--text-bright)', fontWeight: 700, marginBottom: 6 }}>{name}</div>
            <div>浏览器不能稳定直接渲染此类 Office 二进制文件。请下载后用本地 Office/WPS/LibreOffice 打开，或点“原始”交给浏览器处理。</div>
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <Button size="small" type="primary" href={`${rawUrl}&dl=1`}>下载文件</Button>
              <Button size="small" href={rawUrl} target="_blank">打开原始</Button>
            </div>
          </div>
        ))
      ) : (
        <>
          {err && <div style={{ color: '#f85149' }}>{err}</div>}
          {!data && !err && <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div>}
          {data && data.binary && (
            <div style={{ color: 'var(--text-dim)' }}>二进制文件，无法预览（{fmtSize(data.size)}）。<a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: accent }}>下载/打开原始文件</a></div>
          )}
          {data && !data.binary && (
            <>
              {isSheetText
                ? csvTable(data.content, ext === 'tsv' ? '\t' : ',')
                : isMd && !source
                  ? <div style={{ maxHeight: '70vh', overflow: 'auto' }}><Markdown accent={accent}>{data.content}</Markdown></div>
                  : ext === 'json'
                    ? previewShell('JSON 结构预览', <div style={{ maxHeight: '70vh', overflow: 'auto', padding: 12 }}><Markdown accent={accent}>{fence('json', formatJSON(data.content))}</Markdown></div>)
                    : codeLang
                      ? previewShell(`${codeLang.toUpperCase()} 代码预览`, <div style={{ maxHeight: '70vh', overflow: 'auto', padding: 12 }}><Markdown accent={accent}>{fence(codeLang, data.content)}</Markdown></div>)
                      : codePre(data.content)}
              {data.truncated && <div style={{ color: '#d29922', fontSize: 12, marginTop: 6 }}>⚠ 文件较大，仅显示前 512 KB</div>}
            </>
          )}
        </>
      )}
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

export default function FileBrowser({ dir, accent = '#58a6ff', onClose, onInsertPath }: { dir?: string; accent?: string; onClose?: () => void; onInsertPath?: (p: string) => void }) {
  const [path, setPath] = useState(dir || '')
  const [data, setData] = useState<Dir | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<string | null>(null)
  const [tick, setTick] = useState(0) // 上传后强制重载当前目录
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { message } = AntApp.useApp()

  // 会话切换（dir 变化）→ 回到工作目录根
  useEffect(() => { setPath(dir || '') }, [dir])

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
  const goUp = () => { if (data && canUp) setPath(data.parent) }

  const doUpload = async (files: FileList | File[]) => {
    if (!files || !files.length || !cur || uploading) return
    setUploading(true)
    try {
      const res = await upload(cur, files)
      message.success(`已上传 ${res.saved.length} 个文件`)
      refresh()
    } catch (e: any) { message.error('上传失败：' + e.message) }
    finally { setUploading(false) }
  }
  const deletePath = async (target: string) => {
    try {
      const res = await api('DELETE', `/file?path=${encodeURIComponent(target)}`)
      message.success(res.data?.missing ? '文件已不存在，已刷新' : '已删除')
      if (view === target) setView(null)
      refresh()
    } catch (e: any) {
      message.error('删除失败：' + e.message)
      throw e
    }
  }
  // 根目录之上不再回退（防止越过工作目录乱逛；dir 为空时允许一直向上）
  const canUp = !!data && data.parent !== data.path && (!dir || cur !== dir)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0e13', borderLeft: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ color: accent }}><FolderIcon /></span>
          <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontSize: 13 }}>文件管理</span>
          <span style={{ flex: 1 }} />
          {onClose && <IconButton title="关闭文件栏" onClick={onClose}><CloseIcon /></IconButton>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) doUpload(e.target.files); e.target.value = '' }} />
          <IconButton title="返回上级目录" disabled={!canUp} onClick={goUp}><FolderUpIcon /></IconButton>
          <IconButton title="重新读取当前目录" onClick={refresh}><RefreshIcon /></IconButton>
          <IconButton title="上传到当前目录" disabled={uploading || !cur} onClick={() => fileRef.current?.click()}>{uploading ? '…' : <UploadIcon />}</IconButton>
        </div>
      </div>
      <div title={cur} style={{ padding: '4px 10px', color: 'var(--text-dim)', fontSize: 11.5, fontFamily: 'ui-monospace, monospace', borderBottom: '1px solid var(--bg-container)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{cur || '…'}</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '6px 10px' }}>{err}</div>}
        {canUp && (
          <div onClick={goUp} style={rowStyle()}>
            <span style={{ color: 'var(--text-dim)' }}>↑</span><span style={{ color: 'var(--text-dim)' }}>上级目录</span>
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
              e.dir ? setPath(joinPath(cur, e.name)) : setView(joinPath(cur, e.name))
            }} style={rowStyle()}>
            <span style={{ color: e.dir ? accent : 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex', width: 25, justifyContent: 'center' }}>{e.dir ? <FolderIcon /> : <FileTypeIcon name={e.name} />}</span>
            <span style={{ color: e.dir ? 'var(--text-bright)' : 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {!e.dir && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>{fmtSize(e.size)}</span>}
            {onInsertPath && (
              <span data-file-action>
                <IconButton title="插入路径" onClick={() => onInsertPath(joinPath(cur, e.name))}>@</IconButton>
              </span>
            )}
            {!e.dir && (
              <>
                <span data-file-action>
                  <Tooltip title="下载">
                    <Button type="text" size="small" href={`/api/file/raw?path=${encodeURIComponent(joinPath(cur, e.name))}&dl=1`}
                      style={{ width: 24, height: 24, minWidth: 24, padding: 0, color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><DownloadIcon /></Button>
                  </Tooltip>
                </span>
              </>
            )}
            <Popconfirm title={e.dir ? '删除此空目录？' : '删除此文件？'} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
              onConfirm={() => deletePath(joinPath(cur, e.name))}>
              <span data-file-action>
                <Button type="text" size="small" danger
                  style={{ width: 24, height: 24, minWidth: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><TrashIcon /></Button>
              </span>
            </Popconfirm>
            {e.dir && (
              <span data-file-action>
                <IconButton title="进入目录" onClick={() => setPath(joinPath(cur, e.name))}><EnterIcon /></IconButton>
              </span>
            )}
          </div>
        ))}
        {data && data.entries.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>空目录</div>}
      </div>
      {view && <Viewer path={view} accent={accent} onClose={() => setView(null)} onDelete={deletePath} />}
    </div>
  )
}

function rowStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none' }
}
