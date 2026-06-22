// chrome driver — Playwright over CDP。
// 由 cli/chrome-cli/build.sh 内联进 launcher 生成根目录 chrome；本文件是真源，改这里。
// 用法: node driver.mjs <verb> [args] [--tab N|--url 子串] [--timeout ms] [--cdp 地址]
import { chromium } from 'playwright-core'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const verb = argv[0] || 'help'
const rest = argv.slice(1)
const flags = {}
const pos = []
const booleanFlags = new Set(['full', 'fast', 'fresh'])
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const name = a.slice(2)
    if (booleanFlags.has(name)) flags[name] = true
    else flags[name] = rest[++i]
  }
  else pos.push(a)
}

const log = (x) => { if (x !== undefined) console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2)) }
const die = (m) => { console.error('chrome: ' + m); process.exit(1) }
const num = (x, d) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}
const parseViewport = (value) => {
  const m = String(value || '').match(/^(\d+)x(\d+)$/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}
const parseClip = (value) => {
  const m = String(value || '').match(/^(\d+),(\d+),(\d+),(\d+)$/)
  return m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null
}
const imageType = (file) => /\.(jpe?g)$/i.test(file) ? 'jpeg' : 'png'
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
])
const to = Number(flags.timeout || 15000)
const settle = () => num(flags.wait || flags.settle, 0)
const chromeExecutable = () => {
  const candidates = [
    process.env.CHROME_BIN,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

if ((verb === 'screenshot' || verb === 'shot') && flags.fresh) {
  const f = pos[0] || 'screenshot.png'
  const target = flags.goto || flags.open || flags.url || pos[1] || 'about:blank'
  const vp = parseViewport(flags.viewport) || { width: 1280, height: 800 }
  const type = imageType(f)
  const quality = type === 'jpeg' ? num(flags.quality, 85) : undefined
  let fresh
  try {
    const chromeBin = chromeExecutable()
    const launch = chromeBin
      ? { executablePath: chromeBin }
      : { channel: 'chrome' }
    fresh = await chromium.launch({
      ...launch,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      timeout: to,
    })
    const context = await fresh.newContext({
      viewport: vp,
      deviceScaleFactor: num(flags.scale, 1),
    })
    const p = await context.newPage()
    await p.goto(target, { waitUntil: flags.waitUntil || 'domcontentloaded', timeout: to })
    if (settle() > 0) await p.waitForTimeout(settle())
    await withTimeout(p.screenshot({ path: f, fullPage: !!flags.full, type, quality, timeout: to }), to + 1000, 'fresh screenshot')
    log(f)
    await fresh.close()
    process.exit(0)
  } catch (e) {
    await fresh?.close().catch(() => {})
    die(e.message)
  }
}

const cdp = flags.cdp || process.env.TTMUX_CHROME_CDP || 'http://127.0.0.1:9222'
let browser
try { browser = await chromium.connectOverCDP(cdp) }
catch (e) { die('连不上 Chrome (' + cdp + '): ' + e.message) }

const ctx = browser.contexts()[0] || (await browser.newContext())
const pages = ctx.pages()

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
    case 'screenshot': case 'shot': {
      const f = pos[0] || 'screenshot.png'
      const p = pick()
      const vp = parseViewport(flags.viewport)
      const clip = parseClip(flags.clip)
      if (vp) await p.setViewportSize(vp)
      if (settle() > 0) await p.waitForTimeout(settle())
      const type = imageType(f)
      const quality = type === 'jpeg' ? num(flags.quality, 85) : undefined
      const cdpScreenshot = async () => {
        const cdpSession = await ctx.newCDPSession(p)
        const params = { format: type, fromSurface: true, captureBeyondViewport: !!flags.full }
        if (quality !== undefined) params.quality = quality
        if (clip) {
          params.clip = { ...clip, scale: 1 }
        } else if (flags.full) {
          const metrics = await cdpSession.send('Page.getLayoutMetrics')
          const size = metrics.cssContentSize || metrics.contentSize
          params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
        }
        const out = await cdpSession.send('Page.captureScreenshot', params)
        await writeFile(f, Buffer.from(out.data, 'base64'))
      }
      if (flags.fast) {
        await withTimeout(cdpScreenshot(), to, 'fast screenshot')
      } else {
        try {
          await withTimeout(p.screenshot({ path: f, fullPage: !!flags.full, clip, type, quality, timeout: to }), to + 1000, 'screenshot')
        } catch (e) {
          await withTimeout(cdpScreenshot(), to, 'fallback screenshot')
        }
      }
      log(f)
      break
    }
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
