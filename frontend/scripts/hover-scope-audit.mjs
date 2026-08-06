/*
 * 守两条触屏规矩（详见 src/index.css 文件头）：
 *
 * 1. 每条 :hover 规则都要写成 `:where(html[data-pointer="fine"]) X:hover`。
 *    触屏没有 mouseleave，:hover 会粘在最后点过的那枚元素上不走——一排按钮轮流亮灭，
 *    用户看到的就是「点一下在抖，而且没反应」。
 * 2. 只在 hover 里现身的东西（opacity:0 / display:none 的复制、关闭、下载键），
 *    必须另有一条手指档常显规则，否则手机上永远够不着。
 *
 * 覆盖 src 下的 .css，以及 .tsx 里用模板字符串塞进 <style> 的那几坨样式。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const srcDir = join(root, 'src')
const FINE = ':where(html[data-pointer="fine"])'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(css|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** 逐条规则切出「选择器 + 声明」；@keyframes 里的 0%/100% 不是选择器，跳过。 */
function rules(text) {
  const out = []
  const stack = []
  let i = 0
  let start = 0
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    const ch = text[i]
    if (ch === '{') {
      const prelude = text.slice(start, i)
      const head = prelude.trim()
      const atRule = head.startsWith('@')
      if (!atRule && !stack.some((s) => s.skip)) {
        const close = matchingBrace(text, i)
        out.push({
          selector: stripComments(prelude),
          decls: stripComments(text.slice(i + 1, close === -1 ? text.length : close)),
          line: text.slice(0, i).split('\n').length,
        })
      }
      stack.push({ skip: atRule && /keyframes/.test(head) })
      i += 1
      start = i
      continue
    }
    if (ch === '}') {
      stack.pop()
      i += 1
      start = i
      continue
    }
    i += 1
  }
  return out
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

function matchingBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** 顶层逗号切分：`:has(a, b)` 里的逗号不算。 */
function splitTop(selector) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
}

/** .tsx 里只有模板字符串那几段是 CSS，按「出现选择器块」的形态粗取即可。 */
function cssOf(path, text) {
  if (path.endsWith('.css')) return text
  const chunks = [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1])
  return chunks.filter((c) => /:hover|data-pointer|\{[^{}]*:[^{}]*\}/.test(c)).join('\n')
}

const issues = []
const revealed = [] // hover 里靠 opacity 现身的目标类
const hidden = new Set() // 静态就 opacity:0 的类（藏起来等 hover 的）
const coarseClasses = new Set() // 手指档规则点过名的类

const lastClass = (sel) => (sel.match(/\.[A-Za-z0-9_-]+/g) || []).pop()

for (const abs of walk(srcDir)) {
  const file = relative(root, abs)
  const text = cssOf(abs, readFileSync(abs, 'utf8'))
  if (!text) continue
  for (const rule of rules(text)) {
    for (const part of splitTop(rule.selector)) {
      const sel = part.trim()
      if (!sel) continue
      if (/data-pointer="coarse"/.test(sel)) {
        for (const cls of sel.match(/\.[A-Za-z0-9_-]+/g) || []) coarseClasses.add(cls)
      }
      if (!sel.includes(':hover')) {
        const cls = lastClass(sel)
        if (cls && /(^|;)\s*opacity\s*:\s*0\s*(;|$)/.test(rule.decls)) hidden.add(cls)
        continue
      }
      if (!sel.startsWith(FINE)) {
        issues.push(
          `${file}:${rule.line}: :hover 没关进细指针，触屏上会粘住\n` +
            `  ${sel}\n  改成：${FINE} ${sel.replace(FINE, '').trim()}`,
        )
        continue
      }
      // hover 现身：:hover 之后还有后代，且这条把它的 opacity 拉回来
      const tail = sel.slice(sel.lastIndexOf(':hover') + ':hover'.length)
      const target = lastClass(tail)
      if (target && /(^|;)\s*opacity\s*:\s*1\s*(;|$)/.test(rule.decls)) {
        revealed.push({ file, line: rule.line, sel, target })
      }
    }
  }
}

// .css 里的 @media (pointer: coarse) 也算给了手指档兜底
for (const abs of walk(srcDir)) {
  const text = cssOf(abs, readFileSync(abs, 'utf8'))
  for (const m of text.matchAll(/@media[^{]*pointer:\s*coarse[^{]*\{/g)) {
    const block = text.slice(m.index, matchingBrace(text, m.index + m[0].length - 1) + 1)
    for (const cls of block.match(/\.[A-Za-z0-9_-]+/g) || []) coarseClasses.add(cls)
  }
}

for (const r of revealed) {
  if (hidden.has(r.target) && !coarseClasses.has(r.target)) {
    issues.push(
      `${r.file}:${r.line}: ${r.target} 只在 hover 时现身，手指档没有常显规则——手机上够不着\n` +
        `  ${r.sel}\n  补一条：html[data-pointer="coarse"] ${r.target} { opacity: 1 }`,
    )
  }
}

if (issues.length) {
  console.error(`hover 作用域检查未通过（${issues.length} 处）：\n`)
  for (const issue of issues) console.error(issue + '\n')
  process.exit(1)
}
console.log('hover 作用域检查通过')
