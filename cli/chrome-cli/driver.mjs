// chrome driver — Playwright over CDP。
// 由 cli/chrome-cli/build.sh 内联进 launcher 生成根目录 chrome；本文件是真源，改这里。
// 用法: node driver.mjs <verb> [args] [--tab N|--url 子串] [--timeout ms] [--cdp 地址]
import { chromium } from 'playwright-core'

const argv = process.argv.slice(2)
const verb = argv[0] || 'help'
const rest = argv.slice(1)
const flags = {}
const pos = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a === '--full') flags.full = true
  else if (a.startsWith('--')) flags[a.slice(2)] = rest[++i]
  else pos.push(a)
}

const log = (x) => { if (x !== undefined) console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2)) }
const die = (m) => { console.error('chrome: ' + m); process.exit(1) }

const cdp = flags.cdp || process.env.TTMUX_CHROME_CDP || 'http://127.0.0.1:9222'
let browser
try { browser = await chromium.connectOverCDP(cdp) }
catch (e) { die('连不上 Chrome (' + cdp + '): ' + e.message) }

const ctx = browser.contexts()[0] || (await browser.newContext())
const pages = ctx.pages()
const to = Number(flags.timeout || 15000)

const pick = () => {
  if (flags.tab != null) return pages[Number(flags.tab)] || die('无此 tab #' + flags.tab)
  if (flags.url) return pages.find((x) => x.url().includes(flags.url)) || die('无匹配 url 的 tab: ' + flags.url)
  return pages[0] || die('当前没有打开的 tab（先 chrome new <url>）')
}

try {
  switch (verb) {
    case 'goto': { const p = pick(); await p.goto(pos[0], { waitUntil: 'load', timeout: to }); log({ url: p.url(), title: await p.title() }); break }
    case 'url': log(pick().url()); break
    case 'title': log(await pick().title()); break
    case 'click': await pick().click(pos[0], { timeout: to }); log('ok'); break
    case 'fill': await pick().fill(pos[0], pos[1] ?? '', { timeout: to }); log('ok'); break
    case 'type': await pick().type(pos[0], pos[1] ?? '', { timeout: to }); log('ok'); break
    case 'press': { const p = pick(); if (pos.length > 1) await p.press(pos[0], pos[1], { timeout: to }); else await p.keyboard.press(pos[0]); log('ok'); break }
    case 'text': log(await pick().innerText(pos[0] || 'body', { timeout: to })); break
    case 'attr': log(await pick().getAttribute(pos[0], pos[1], { timeout: to })); break
    case 'html': { const p = pick(); log(pos[0] ? await p.locator(pos[0]).first().evaluate((e) => e.outerHTML) : await p.content()); break }
    case 'eval': { const r = await pick().evaluate(pos[0]); log(r === undefined ? 'undefined' : r); break }
    case 'wait': await pick().waitForSelector(pos[0], { timeout: to }); log('ok'); break
    case 'screenshot': case 'shot': { const f = pos[0] || 'screenshot.png'; await pick().screenshot({ path: f, fullPage: !!flags.full }); log(f); break }
    case 'pdf': { const f = pos[0] || 'page.pdf'; await pick().pdf({ path: f }); log(f); break }
    case 'tabs': log(await Promise.all(pages.map(async (pg, i) => ({ i, title: await pg.title().catch(() => ''), url: pg.url() })))); break
    case 'new': { const np = await ctx.newPage(); if (pos[0]) await np.goto(pos[0], { waitUntil: 'load', timeout: to }); log({ i: ctx.pages().indexOf(np), url: np.url() }); break }
    case 'close': await pick().close(); log('ok'); break
    default: die('未知命令: ' + verb)
  }
} catch (e) {
  await browser.close().catch(() => {})
  die(e.message)
}
// connectOverCDP 的 close 仅断开连接，不会杀掉全局 Chrome。
await browser.close()
