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
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return
    const line = stripLineComment(raw)

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
  })
}

if (issues.length) {
  console.error('i18n audit failed:\n')
  console.error(issues.join('\n\n'))
  process.exit(1)
}

console.log(`i18n audit passed: ${zh.size} locale keys checked.`)
