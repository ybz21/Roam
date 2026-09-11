// 状态条的格子有没有在原地待着：每格左边界采样 30 秒，报最大位移。
//
// 为什么要量：位置跳变是「看得出、说不清」的那类 bug——肉眼只记得「刚才它好像在左边」。
// 一格挪了 81px 还是 0px，采一遍就没有争议了。
//
//   TARGET=http://127.0.0.1:13581 PW=口令 [WIDTH=1100] [ECHO=1] node scripts/dev/statusbar-jitter.mjs
//
// ECHO=1 会在采样中途从已连上的 P2P 链路灌一股流量，让直连格的速率出现又消失——
// 那一截正是最容易推着右边所有格平移的东西。
import { chromium } from '/home/ai/.local/share/ttmux/chrome/node_modules/playwright-core/index.mjs'

const TARGET = process.env.TARGET || 'http://127.0.0.1:13581'
const PW = process.env.PW || ''
const WIDTH = Number(process.env.WIDTH || 1100)
const SAMPLES = Number(process.env.SAMPLES || 40)

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: WIDTH, height: 800 } })
if (process.env.ECHO === '1') {
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc }
    window.RTCPeerConnection.prototype = Orig.prototype
  })
}
const page = await ctx.newPage()
await page.goto(TARGET + '/', { waitUntil: 'domcontentloaded' })
await page.locator('input[type="password"]').first().fill(PW)
await page.locator('button[type="submit"]').first().click()
await page.waitForSelector('.tt-statusbar', { timeout: 20000 })
await page.waitForTimeout(4000)   // 等第一批读数到齐，否则量到的是「格子陆续出现」

const samples = []
for (let i = 0; i < SAMPLES; i++) {
  if (i === 10 && process.env.ECHO === '1') {
    await page.evaluate(() => {
      const pc = (window.__pcs || []).find((p) => p.connectionState === 'connected')
      if (!pc) return
      const dc = pc.createDataChannel('echo#jitter')
      dc.binaryType = 'arraybuffer'
      // 定时器发，不用 while 死循环：那样会占满主线程，React 根本不重绘，测了个寂寞。
      dc.onopen = () => {
        const buf = new Uint8Array(65536)
        const end = performance.now() + 12000
        const t = setInterval(() => {
          if (performance.now() > end) { clearInterval(t); dc.close(); return }
          for (let k = 0; k < 24 && dc.bufferedAmount < (8 << 20); k++) dc.send(buf)
        }, 50)
      }
    })
  }
  samples.push(await page.evaluate(() => [...document.querySelectorAll('.tt-statusbar .cell')]
    .map((c) => ({ t: c.innerText.replace(/\n/g, ' '), x: Math.round(c.getBoundingClientRect().x) }))))
  await page.waitForTimeout(750)
}

// 把数字抠成 #，才能把「同一格的不同读数」认成同一格
const byCell = new Map()
for (const snap of samples) {
  for (const c of snap) {
    const key = c.t.replace(/[\d.<]+\s*(ms|%|°C|K\/s|M\/s|G|\/\d+G)?/g, '#').trim()
    if (!byCell.has(key)) byCell.set(key, [])
    byCell.get(key).push(c.x)
  }
}
console.log(`${TARGET} · ${samples.length} 次采样（${(samples.length * 0.75).toFixed(0)} 秒，视口 ${WIDTH}px）`)
let worst = 0
for (const [key, xs] of byCell) {
  const d = Math.max(...xs) - Math.min(...xs)
  worst = Math.max(worst, d)
  console.log(`  ${d ? '挪了' : '没动'} ${String(d).padStart(4)}px  ${key}`)
}
console.log(`最大位移 ${worst}px`)
await browser.close()
process.exit(worst === 0 ? 0 : 1)
