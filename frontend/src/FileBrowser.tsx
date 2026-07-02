// 文件侧栏 —— 在 Claude / Codex 对话页右侧浏览工作目录、查看文件内容（类似 codex 右侧边栏）。
// 单层可导航列表：目录在前可进入、↑ 回上级、点文件在弹层里查看正文。
import { type MouseEvent, type ReactNode, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Button, Dropdown, Input, Modal, Space, Spin, App as AntApp, Tooltip, type MenuProps } from 'antd'
import { api, upload } from './api'
import Markdown from './Markdown'
import { useI18n } from './i18n'
import { recentDirs } from './App'
import { useThemeMode } from './theme'

// Monaco 代码编辑器很重，只有真正编辑/查看文本文件才需要 → 懒加载，不进首屏包。
const CodeEditor = lazy(() => import('./CodeEditor'))

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

// Monaco 语言 id（与 highlight.js 的略有出入：bash→shell、tsx→typescript、toml→ini…）
const MONACO_LANG: Record<string, string> = {
  py: 'python', pyw: 'python', ipynb: 'json', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', swift: 'swift', html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'scss', sass: 'scss',
  less: 'less', sql: 'sql', json: 'json', jsonl: 'json', ndjson: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini', conf: 'ini', lock: 'ini', xml: 'xml', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
}
function monacoLangOf(path: string): string {
  const name = path.split('/').pop() || ''
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile'
  return MONACO_LANG[extOf(path)] || 'plaintext'
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
export const FileTypeIcon = ({ name }: { name: string }) => {
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
const EyeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
)
const EyeOffIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a17.7 17.7 0 0 1-3 3.7" /><path d="M6.6 6.6A17.6 17.6 0 0 0 2 11s3.5 7 10 7a10.6 10.6 0 0 0 4.4-.9" /><path d="m2 2 20 20" /><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" /></svg>
)
const SortIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h7" /><path d="M3 12h10" /><path d="M3 18h14" /><path d="M18 6v12" /><path d="m15 15 3 3 3-3" /></svg>
)
// 树形视图开关：平铺列表 <-> 可展开目录树
const TreeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h6a2 2 0 0 1 2 2v7" /></svg>
)
const ListIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
)
const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
)
// markdown 预览（VSCode 式）：切换预览 / 侧栏打开预览
const PreviewIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10" /><path d="M7 13h10" /><path d="M7 17h6" /></svg>
)
const PreviewSideIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M13 4v16" /><path d="M16 10h3" /><path d="M16 14h3" /></svg>
)
// 目录展开箭头：展开时旋转 90°
const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }}><path d="m9 18 6-6-6-6" /></svg>
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

export function Viewer({
  path,
  accent,
  inline,
  active = true,
  tabbed,
  forcePreview,
  onClose,
  onOpenPath,
  onOpenAgent,
  onDirtyChange,
  onPreviewToSide,
}: {
  path: string
  accent: string
  inline?: boolean
  // 多 tab 常驻挂载时，只有激活的才渲染重型 Monaco 编辑器/预览，避免多实例吃爆内存(OOM)。
  // 组件仍挂载 → draft/dirty 等 state 保留，切回来编辑内容不丢。
  active?: boolean
  // 编辑器 tab 上下文：外层 tab 已显示文件名+关闭，这里就不再重复顶部「▸ 文件名」标题行。
  tabbed?: boolean
  // 专用预览 tab（VSCode「侧栏预览」）：始终渲染 markdown，不显示编辑器/切换钮。
  forcePreview?: boolean
  onClose: () => void
  onOpenPath: (p: string) => void
  onOpenAgent?: (kind: 'claude' | 'codex', path: string) => void
  // 编辑器脏状态上报（供外层 tab 显示未保存圆点）
  onDirtyChange?: (path: string, dirty: boolean) => void
  // 在侧栏打开渲染预览（外层 FileWorkspace 处理，开另一栏）
  onPreviewToSide?: (path: string) => void
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
  const [draft, setDraft] = useState('') // 编辑器当前文本
  const [saving, setSaving] = useState(false)
  const [stale, setStale] = useState(false) // 磁盘上文件已被外部(cc/codex)改动，但本地有未保存改动没自动覆盖
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const { mode } = useThemeMode()

  // 可编辑：文本/代码/JSON/Markdown（源码）；二进制、被截断的大文件、表格/图片/PDF/Office 不可编辑。
  const editable = !!data && !data.binary && !data.truncated && !isSheetText && !isImg && !isPdf && !isOffice
  const dirty = editable && data ? draft !== data.content : false
  useEffect(() => { onDirtyChange?.(path, dirty); return () => onDirtyChange?.(path, false) }, [dirty, path])

  const save = async () => {
    if (!editable || saving || !dirty) return
    setSaving(true)
    try {
      const res = await api('POST', '/file/save', { path, content: draft })
      setData((d: any) => ({ ...d, content: draft, mtime: res.data?.mtime ?? d?.mtime })) // 基线更新 → dirty 归零；mtime 同步避免自触发重载
      setStale(false)
      message.success(t('file.saved'))
    } catch (e: any) {
      message.error(t('file.saveFailed', { message: e.message }))
    } finally {
      setSaving(false)
    }
  }
  // Monaco 的 Ctrl+S 命令在挂载时捕获闭包，用 ref 始终指向最新 save，避免存到旧文本。
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    if (isImg || isPdf || isOffice) return // 图片/PDF/Office 直接走 raw 或专用面板
    // tab 语境的 markdown 默认进编辑器（源码），点眼睛才切预览；非 tab（有头部）默认渲染。
    setData(null); setErr(''); setStale(false); setSource(!!tabbed && MD_EXT.includes(extOf(path))); setDraft('')
    api('GET', `/file?path=${encodeURIComponent(path)}`).then((r) => { setData(r.data); setDraft(r.data?.content || '') }).catch((e) => setErr(e.message))
  }, [path, isImg, isPdf, isOffice])

  // 从磁盘重载（放弃本地未保存改动）
  const reloadFromDisk = () => {
    api('GET', `/file?path=${encodeURIComponent(path)}`).then((r) => { setData(r.data); setDraft(r.data?.content || ''); setStale(false) }).catch(() => {})
  }
  // 外部(cc/codex 等)改动已打开的文件 → 轮询 mtime：无本地改动自动重载渲染；有未保存改动只提示不覆盖。
  useEffect(() => {
    if (!active || !data || err || isImg || isPdf || isOffice) return
    let stop = false
    const h = setInterval(async () => {
      try {
        const r = await api('GET', `/file/stat?path=${encodeURIComponent(path)}`)
        if (stop || !r.data?.mtime || r.data.mtime === data.mtime) return
        if (dirty) { setStale(true); return } // 有未保存改动 → 不覆盖，仅提示
        const fr = await api('GET', `/file?path=${encodeURIComponent(path)}`)
        if (!stop) { setData(fr.data); setDraft(fr.data?.content || '') }
      } catch {}
    }, 2000)
    return () => { stop = true; clearInterval(h) }
  }, [active, data?.mtime, dirty, path, isImg, isPdf, isOffice, err])

  // 非激活 tab：只占位、不挂载重型 Monaco/预览（state 已在上面 hook 里保留，切回来不丢编辑）。
  if (!active) return <div style={{ height: '100%' }} />

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
      {!tabbed && (
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: accent }}>▸</span> {name}
        </span>
      )}
      {dirty && <span title={t('file.unsaved')} style={{ width: 8, height: 8, borderRadius: '50%', background: '#d29922', flex: '0 0 auto' }} />}
      <span style={{ flex: 1, minWidth: 8 }} />
      {editable && (
        <Button size="small" type="primary" ghost={!dirty} disabled={!dirty || saving} loading={saving} onClick={save}>{t('file.save')}</Button>
      )}
      {isMd && data && !data.binary && (
        <Button size="small" onClick={() => setSource((s) => !s)}>{source ? t('file.rendered') : t('file.source')}</Button>
      )}
      {onOpenAgent && (
        <Button size="small" onClick={() => setAgentPick(true)}>{t('file.openInAgent')}</Button>
      )}
      <Button size="small" onClick={copyPath}>{t('file.copyPath')}</Button>
      <Button size="small" href={downloadUrl} download={downloadName}>{t('file.download')}</Button>
      <a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('file.raw')}</a>
      {inline && !tabbed && <IconButton title={t('file.closePreview')} onClick={onClose}><CloseIcon /></IconButton>}
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
                : isMd && (!source || forcePreview)
                  ? <div style={{ height: previewHeight, overflow: 'auto', padding: forcePreview ? '0 8px' : undefined }}><Markdown accent={accent} resolveHref={resolvePreviewHref} onLinkClick={openPreviewLink}>{data.content}</Markdown></div>
                  : (
                    // 文本/代码/JSON/Markdown(源码) → Monaco 编辑器（行号、语法高亮、可编辑；截断的大文件只读）。
                    // tab 语境下全屏无边框，背景由 CodeEditor 统一成应用底色。
                    <div style={{ height: previewHeight, border: tabbed ? 'none' : '1px solid var(--border-subtle)', borderRadius: tabbed ? 0 : 8, overflow: 'hidden' }}>
                      <Suspense fallback={<div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><Spin /></div>}>
                        <CodeEditor value={draft} language={monacoLangOf(path)} dark={mode === 'dark'} readOnly={!editable} onChange={setDraft} onSave={() => saveRef.current()} />
                      </Suspense>
                    </div>
                  )}
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
        {/* 编辑器 tab 语境(tabbed)：文件名/操作已由外层 tab 承担 → 去掉整条标题栏，编辑器全屏。保存用 Ctrl/Cmd+S。 */}
        {!tabbed && <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)' }}>{titleNode}</div>}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: tabbed ? 0 : 12, position: 'relative' }}>
          {bodyNode}
          {/* tab 语境无头部：markdown 右上角 VSCode 式预览按钮（切换预览 / 侧栏打开预览） */}
          {tabbed && isMd && !forcePreview && data && !data.binary && (
            <div style={{ position: 'absolute', top: 6, right: 8, zIndex: 10, display: 'inline-flex', gap: 2, background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)', borderRadius: 8, padding: 2 }}>
              <Tooltip title={source ? t('file.preview') : t('file.source')} placement="bottom">
                <Button type="text" size="small" onClick={() => setSource((s) => !s)} style={{ color: !source ? accent : 'var(--text-dim)', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><PreviewIcon /></Button>
              </Tooltip>
              {onPreviewToSide && (
                <Tooltip title={t('file.previewToSide')} placement="bottom">
                  <Button type="text" size="small" onClick={() => onPreviewToSide(path)} style={{ color: 'var(--text-dim)', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><PreviewSideIcon /></Button>
                </Tooltip>
              )}
            </div>
          )}
          {/* 文件被外部(cc/codex)改动、但本地有未保存改动 → 提示条 */}
          {stale && dirty && (
            <div style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', zIndex: 11, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, fontSize: 12, background: 'var(--bg-container)', border: '1px solid #d29922', color: 'var(--text-bright)', boxShadow: 'var(--elevated-shadow)' }}>
              <span>⚠ {t('file.changedOnDisk')}</span>
              <Button size="small" danger onClick={reloadFromDisk}>{t('file.reloadFromDisk')}</Button>
            </div>
          )}
        </div>
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

  // 换根目录或刷新（tick）→ 清空展开态与缓存，避免展示上一目录的子树
  useEffect(() => { setExpanded(new Set()); setChildMap({}); setLoading({}) }, [root, tick])

  const loadDir = (dirPath: string) => {
    setLoading((m) => ({ ...m, [dirPath]: true }))
    api('GET', `/files?path=${encodeURIComponent(dirPath)}`)
      .then((r) => setChildMap((m) => ({ ...m, [dirPath]: r.data?.entries || [] })))
      .catch(() => setChildMap((m) => ({ ...m, [dirPath]: [] })))
      .finally(() => setLoading((m) => ({ ...m, [dirPath]: false })))
  }
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
}

function rowStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none' }
}
