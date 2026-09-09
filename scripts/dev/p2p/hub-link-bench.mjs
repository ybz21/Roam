// 直连比中转快多少：同一台节点、同样大小的数据，两条路各量一遍。
//
//   ① 直连：在 control PC 上开一条 echo 通道，打 N MB 进去等它原样回来（数据不经中心）
//   ② 中转：GET /n/<id>/api/file/download 拉同样大小的一个文件（走中心的隧道）
//
//   HUB=https://中心 NODE_ID=n_xxx HUB_PW=口令 MB=20 FILE=/tmp/bench.bin \
//     node scripts/dev/p2p/hub-link-bench.mjs
//
// FILE 可省（省了就只跑直连那一半）；要跑对照就先在那台节点上造一个同样大小的文件：
//   head -c $((20*1024*1024)) /dev/urandom > /tmp/bench.bin
// 结论见 docs/design/p2p/hub-direct-link.md §2。
import { chromium } from '/home/ai/.local/share/ttmux/chrome/node_modules/playwright-core/index.mjs'

const HUB = process.env.HUB || 'https://127.0.0.1:13570'
const NODE = process.env.NODE_ID || ''
const PW = process.env.HUB_PW || ''
const MB = Number(process.env.MB || 20)
const FILE = process.env.FILE || ''

if (!NODE || !PW) {
  console.error('用法：HUB=https://中心 NODE_ID=n_xxx HUB_PW=口令 [MB=20] [FILE=/tmp/bench.bin] node scripts/dev/p2p/hub-link-bench.mjs')
  process.exit(2)
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
await ctx.addInitScript(({ node }) => {
  localStorage.setItem('roam.nodeId', node)
  const Orig = window.RTCPeerConnection
  window.__pcs = []
  window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc }
  window.RTCPeerConnection.prototype = Orig.prototype
}, { node: NODE })

const page = await ctx.newPage()
await page.goto(HUB + '/', { waitUntil: 'domcontentloaded' })
await page.locator('input[type="password"]').first().fill(PW)
await page.locator('button[type="submit"]').first().click()

// 非 trickle：候选收集要等到上限（默认 30s）才发 offer，所以这里最多等 60 秒。
let ready = false
for (let i = 0; i < 60 && !ready; i++) {
  ready = await page.evaluate(() => (window.__pcs || []).some((p) => p.connectionState === 'connected'))
  if (!ready) await page.waitForTimeout(1000)
}
if (!ready) {
  console.error('直连没建起来（节点 p2p_enabled 打开了吗？偏好 p2pEnabled 呢？）')
  await browser.close()
  process.exit(1)
}

const direct = await page.evaluate(async (mb) => {
  const pc = window.__pcs.find((p) => p.connectionState === 'connected')
  const dc = pc.createDataChannel('echo#bench')
  dc.binaryType = 'arraybuffer'
  await new Promise((res, rej) => {
    dc.onopen = res
    dc.onerror = rej
    setTimeout(() => rej(new Error('通道十秒没打开')), 10000)
  })

  const CHUNK = 64 * 1024              // SCTP 单条消息别贴着上限走，64K 是各浏览器都稳的块
  const total = mb * 1024 * 1024
  const buf = new Uint8Array(CHUNK)
  let got = 0
  const done = new Promise((res) => {
    dc.onmessage = (e) => { got += e.data.byteLength ?? e.data.length; if (got >= total) res() }
  })

  // 背压：缓冲堆到 8MB 就停手，等 bufferedamountlow 再继续，否则大文件会把标签页撑爆。
  dc.bufferedAmountLowThreshold = 1 << 20
  const t0 = performance.now()
  for (let sent = 0; sent < total; sent += CHUNK) {
    if (dc.bufferedAmount > 8 << 20) await new Promise((res) => { dc.onbufferedamountlow = res })
    dc.send(buf)
  }
  await done
  const ms = performance.now() - t0
  dc.close()
  // echo 是往返：链路上实际跑了 2×total，单向等效再除以二
  return { ms: Math.round(ms), wireMBps: +(2 * total / 1048576 / (ms / 1000)).toFixed(1), oneWayMBps: +(total / 1048576 / (ms / 1000)).toFixed(1) }
}, MB)
console.log(`直连 echo 往返 ${MB}MB：${direct.ms}ms  线上 ${direct.wireMBps} MB/s（单向等效 ${direct.oneWayMBps} MB/s）`)

if (FILE) {
  const relay = await page.evaluate(async ({ node, file }) => {
    const t0 = performance.now()
    const r = await fetch(`/n/${node}/api/file/download?path=${encodeURIComponent(file)}`, { cache: 'no-store' })
    const b = await r.arrayBuffer()
    const ms = performance.now() - t0
    return { ms: Math.round(ms), mb: +(b.byteLength / 1048576).toFixed(1), MBps: +(b.byteLength / 1048576 / (ms / 1000)).toFixed(2) }
  }, { node: NODE, file: FILE })
  console.log(`经中心中转下载 ${relay.mb}MB：${relay.ms}ms  ${relay.MBps} MB/s`)
  console.log(`直连约为中转的 ${(direct.oneWayMBps / relay.MBps).toFixed(0)}×`)
}

await browser.close()
