// 建链要多久：从建 PeerConnection 到 connectionState==='connected'。
//
// 顺带打印选中的候选对，以及**发出去的 SDP 里到底有没有 srflx**——后者是这个改动的关键：
// 早发 offer 换来的速度，不能以丢掉反射候选（跨网只能中转）为代价。
//
//   TARGET=https://127.0.0.1:13579 PW=口令 [NODE_ID=n_xxx] node scripts/dev/p2p/connect-timing.mjs
import { chromium } from '/home/ai/.local/share/ttmux/chrome/node_modules/playwright-core/index.mjs'

const TARGET = process.env.TARGET || 'https://127.0.0.1:13579'
const PW = process.env.PW || ''
const NODE = process.env.NODE_ID || ''
const WAIT_S = Number(process.env.WAIT_S || 70)

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
// 在页面脚本之前包一层 RTCPeerConnection：应用建的每条 PC 都记下来，并给它挂上计时。
await ctx.addInitScript(({ node }) => {
  if (node) localStorage.setItem('roam.nodeId', node)
  const Orig = window.RTCPeerConnection
  window.__pcs = []; window.__t0 = 0; window.__conn = -1
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a)
    window.__pcs.push(pc)
    if (!window.__t0) window.__t0 = performance.now()
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' && window.__conn < 0) window.__conn = performance.now() - window.__t0
    })
    return pc
  }
  window.RTCPeerConnection.prototype = Orig.prototype
}, { node: NODE })

const page = await ctx.newPage()
await page.goto(TARGET + '/', { waitUntil: 'domcontentloaded' })
await page.locator('input[type="password"]').first().fill(PW)
await page.locator('button[type="submit"]').first().click()

let ms = -1
for (let i = 0; i < WAIT_S * 2; i++) {
  ms = await page.evaluate(() => window.__conn)
  if (ms > 0) break
  await page.waitForTimeout(500)
}
if (ms <= 0) {
  console.error(`${WAIT_S}s 内没连上（节点 p2p_enabled 开了吗？偏好 p2pEnabled 呢？）`)
  await browser.close()
  process.exit(1)
}
console.log(`control PC 从建 PC 到 connected：${(ms / 1000).toFixed(2)}s`)

const info = await page.evaluate(async () => {
  const pc = window.__pcs.find((p) => p.connectionState === 'connected')
  const stats = await pc.getStats()
  const cand = {}
  stats.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cand[r.id] = r })
  let pair = '?'
  stats.forEach((r) => {
    if (r.type === 'candidate-pair' && (r.nominated || r.selected)) {
      pair = `${cand[r.localCandidateId]?.candidateType}/${cand[r.remoteCandidateId]?.candidateType} rtt=${r.currentRoundTripTime}`
    }
  })
  const count = (sdp, typ) => (sdp.match(new RegExp('typ ' + typ, 'g')) || []).length
  const l = pc.localDescription?.sdp || ''
  const r = pc.remoteDescription?.sdp || ''
  return { pair, sdp: `发出去的 offer: host×${count(l, 'host')} srflx×${count(l, 'srflx')} | 收到的 answer: host×${count(r, 'host')} srflx×${count(r, 'srflx')}` }
})
console.log('选中候选对：', info.pair)
console.log(info.sdp)
await browser.close()
