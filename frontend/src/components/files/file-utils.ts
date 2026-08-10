// 文件相关的纯工具(无 JSX)：扩展名/大小/路径/语言映射/分隔文本解析 + 类型分类。
// 由目录浏览器(FileBrowser)与文件展示组件(fileview/)共用，放中性模块避免互相依赖成环。

export const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
export const MD_EXT = ['md', 'markdown', 'mdx']

export const CODE_LANG: Record<string, string> = {
  py: 'python', pyw: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', mjs: 'javascript', cjs: 'javascript',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', sass: 'sass', less: 'less', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', xml: 'xml', ini: 'ini', env: 'ini', conf: 'ini', Dockerfile: 'dockerfile',
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

export function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

export function fileNameOf(path: string): string {
  return path.split('/').pop() || 'download'
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K'
  return (n / 1024 / 1024).toFixed(1) + ' M'
}

export function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function normalizePath(path: string): string {
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return (abs ? '/' : '') + parts.join('/')
}

export function stripHashQuery(ref: string): string {
  return ref.split('#')[0].split('?')[0]
}

export function localPathFromRef(baseFile: string, ref: string): string | null {
  const raw = stripHashQuery(ref.trim())
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  let clean = raw
  try { clean = decodeURIComponent(raw) } catch { /* keep raw */ }
  return normalizePath(clean.startsWith('/') ? clean : joinPath(dirname(baseFile), clean))
}

export function codeLangOf(path: string): string {
  const name = path.split('/').pop() || ''
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile'
  return CODE_LANG[extOf(path)] || ''
}

export function monacoLangOf(path: string): string {
  const name = path.split('/').pop() || ''
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile'
  return MONACO_LANG[extOf(path)] || 'plaintext'
}

export function parseDelimited(text: string, sep: ',' | '\t'): string[][] {
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

// 文件类型分类：一次算好各 preview 分支要的布尔位，容器与子组件共用同一判定。
export interface FileKind {
  isImg: boolean
  isMd: boolean
  isHtml: boolean
  isPdf: boolean
  isOffice: boolean
  isDocx: boolean
  isExcel: boolean
  isPptx: boolean
  isSheet: boolean
}

export function fileKind(path: string): FileKind {
  const ext = extOf(path)
  return {
    isImg: IMG_EXT.includes(ext),
    isMd: MD_EXT.includes(ext),
    isHtml: ext === 'html' || ext === 'htm',
    isPdf: ext === 'pdf',
    isOffice: ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'odp'].includes(ext),
    isDocx: ext === 'docx',
    isExcel: ['xls', 'xlsx', 'xlsm', 'ods'].includes(ext),
    isPptx: ext === 'pptx',
    isSheet: ['csv', 'tsv'].includes(ext),
  }
}
