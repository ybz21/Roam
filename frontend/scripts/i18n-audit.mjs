import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const srcDir = join(root, 'src')
const zhPath = join(srcDir, 'i18n/locales/zh-CN.ts')
const enPath = join(srcDir, 'i18n/locales/en-US.ts')

const allowFiles = new Set([
  'src/i18n/locales/zh-CN.ts',
  'src/i18n/locales/en-US.ts',
])

const attrNames = [
  'placeholder',
  'title',
  'okText',
  'cancelText',
  'description',
  'aria-label',
  'emptyText',
]

const technicalLiteral = /^(KEY|VALUE|Agent|Claude|Codex|tmux|auto\/plan\/default|[A-Z0-9_./:-]+)$/
const chinese = /[\u4e00-\u9fff]/
const textChars = /[A-Za-z\u4e00-\u9fff]/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

function localeKeys(path) {
  const text = readFileSync(path, 'utf8')
  return new Set([...text.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]))
}

function stripLineComment(line) {
  const idx = line.indexOf('//')
  return idx >= 0 ? line.slice(0, idx) : line
}

function report(issues, file, lineNo, reason, line) {
  issues.push(`${file}:${lineNo}: ${reason}\n  ${line.trim()}`)
}

const issues = []

const zh = localeKeys(zhPath)
const en = localeKeys(enPath)
for (const key of zh) if (!en.has(key)) issues.push(`locale: missing en-US key "${key}"`)
for (const key of en) if (!zh.has(key)) issues.push(`locale: missing zh-CN key "${key}"`)

const files = walk(srcDir)
for (const abs of files) {
  const file = relative(root, abs)
  if (allowFiles.has(file)) continue
  if (file.includes('src/i18n/')) continue

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  // 块注释（含 JSX 的 {/* … */}）要整段跳过。只剥 // 的话，一句提到 Button/Modal
  // 的中文注释就会被当成硬编码文案——注释是写给人看的，本来就该是中文。
  let inBlock = false
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    const trimmed = raw.trim()
    if (inBlock) {
      const end = raw.indexOf('*/')
      if (end < 0) return
      inBlock = false
      raw = raw.slice(end + 2)
    }
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return
    let line = stripLineComment(raw)
    const open = line.lastIndexOf('/*')
    if (open >= 0 && line.indexOf('*/', open) < 0) {
      inBlock = true
      line = line.slice(0, open)
    }

    for (const attr of attrNames) {
      const attrRe = new RegExp(`${attr}=["']([^"']+)["']`, 'g')
      for (const match of line.matchAll(attrRe)) {
        const literal = match[1].trim()
        if (literal && textChars.test(literal) && !technicalLiteral.test(literal)) {
          report(issues, file, lineNo, `hardcoded JSX ${attr}; use t('...')`, raw)
        }
      }
    }

    const messageRe = /message\.(success|error|warning|info)\(\s*(['"`])([^'"`]*[\u4e00-\u9fffA-Za-z][^'"`]*)\2/g
    for (const match of line.matchAll(messageRe)) {
      const literal = match[3].trim()
      if (literal && !technicalLiteral.test(literal)) {
        report(issues, file, lineNo, 'hardcoded toast/message literal; use t(...)', raw)
      }
    }

    const modalRe = /modal\.(confirm|warning|info|success|error)\(\s*\{.*\b(title|content|okText|cancelText)\s*:\s*(['"`])([^'"`]*[\u4e00-\u9fffA-Za-z][^'"`]*)\3/
    const modalMatch = line.match(modalRe)
    if (modalMatch && !technicalLiteral.test(modalMatch[4].trim())) {
      report(issues, file, lineNo, 'hardcoded modal literal; use t(...)', raw)
    }

    const jsxTextRe = />\s*([^<>{}`]*[\u4e00-\u9fff][^<>{}`]*)\s*</g
    for (const match of line.matchAll(jsxTextRe)) {
      const literal = match[1].trim()
      if (literal) report(issues, file, lineNo, 'hardcoded JSX text; use t(...)', raw)
    }

    if (chinese.test(line) && /(placeholder|okText|cancelText|message\.|Modal|Button|Empty|Tooltip|Popconfirm|Card|Tag|Text|title=)/.test(line) && !/t\(['"`]/.test(line)) {
      report(issues, file, lineNo, 'possible hardcoded user-facing Chinese', raw)
    }

    // t('不存在的key') 会原样把 key 渲染到界面上，两份 locale 又都缺它 → 上面的
    // 对齐检查也发现不了。这条专门堵这个洞：拼接出来的动态 key（t('a.' + x)）跳过。
    for (const match of line.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'\s*(\)|,)/g)) {
      if (!zh.has(match[1])) report(issues, file, lineNo, `unknown i18n key "${match[1]}"`, raw)
    }
  })
}

if (issues.length) {
  console.error('i18n audit failed:\n')
  console.error(issues.join('\n\n'))
  process.exit(1)
}

console.log(`i18n audit passed: ${zh.size} locale keys checked.`)
