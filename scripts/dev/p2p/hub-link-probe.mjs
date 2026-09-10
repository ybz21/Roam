// 经中心访问某台节点时，浏览器到底连到了哪里？
//
// 真 Chrome 登录真中心 → 切到指定节点 → 打印 ICE 候选时间线和最终选中的候选对。
// 选中对里是节点的局域网/公网地址 = 数据面绕开了中心；是中心的地址 = 没绕开。
// 设计与实测结论见 docs/design/p2p/hub-direct-link.md。
//
//   HUB=https://中心 NODE_ID=n_xxx HUB_PW=口令 node scripts/dev/p2p/hub-link-probe.mjs
//
// 前置：目标节点 ~/.roami/config.yaml 里 p2p_enabled: true（脚本会自动打开浏览器侧偏好）。
import { chromium } from '/home/ai/.local/share/ttmux/chrome/node_modules/playwright-core/index.mjs'

const HUB = process.env.HUB || 'https://127.0.0.1:13570'
const NODE = process.env.NODE_ID || ''
const PW = process.env.HUB_PW || ''
const SHOT = process.env.SHOT || ''

if (!NODE || !PW) {
  console.error('用法：HUB=https://中心 NODE_ID=n_xxx HUB_PW=口令 node scripts/dev/p2p/hub-link-probe.mjs')
  process.exit(2)
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })

// 页面脚本先于应用运行：钉住当前机器，并把每个 PeerConnection 的候选事件带时间戳记下来。
await ctx.addInitScript(({ node }) => {
  localStorage.setItem('roam.nodeId', node)
  const Orig = window.RTCPeerConnection
  window.__pcs = []
  window.__cand = []
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a)
    const t0 = performance.now()
    const at = () => Math.round(performance.now() - t0)
    pc.addEventListener('icecandidate', (e) => {
      window.__cand.push({ ms: at(), line: e.candidate ? e.candidate.candidate : '(候选收集结束)' })
    })
    pc.addEventListener('icegatheringstatechange', () => {
      window.__cand.push({ ms: at(), line: 'gathering=' + pc.iceGatheringState })
    })
    window.__pcs.push(pc)
    return pc
  }
  window.RTCPeerConnection.prototype = Orig.prototype
}, { node: NODE })

const page = await ctx.newPage()
await page.goto(HUB + '/', { waitUntil: 'domcontentloaded' })
await page.locator('input[type="password"]').first().fill(PW)
await page.locator('button[type="submit"]').first().click()
await page.waitForTimeout(4000)

// P2P 偏好是按节点存的（走 /n/<id>/api/preferences）：读回来改一个字段再写，别把别的偏好抹了。
await page.evaluate(async (node) => {
  const base = `/n/${node}/api`
  const cur = (await (await fetch(base + '/preferences')).json()).data || {}
  cur.p2pEnabled = true
  await fetch(base + '/preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cur),
  })
}, NODE)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)

const snapshot = () => page.evaluate(async () => {
  const out = []
  for (const pc of window.__pcs || []) {
    const row = { conn: pc.connectionState, gather: pc.iceGatheringState, pair: null }
    try {
      const stats = await pc.getStats()
      const pairs = [], cands = {}
      stats.forEach((r) => {
        if (r.type === 'candidate-pair') pairs.push(r)
        if (r.type.endsWith('candidate')) cands[r.id] = r
      })
      const sel = pairs.find((p) => p.state === 'succeeded' && (p.nominated || p.selected))
      if (sel) {
        const l = cands[sel.localCandidateId] || {}, r = cands[sel.remoteCandidateId] || {}
        row.pair = {
          local: `${l.candidateType}/${l.protocol} ${l.address || '(隐藏)'}:${l.port || ''}`,
          remote: `${r.candidateType}/${r.protocol} ${r.address || '(隐藏)'}:${r.port || ''}`,
          rttMs: Math.round((sel.currentRoundTripTime || 0) * 1000),
          bytes: `${sel.bytesSent}/${sel.bytesReceived}`,
        }
      }
    } catch { /* 统计取不到就当没有 */ }
    out.push(row)
  }
  return { pcs: out, rail: document.body.innerText.match(/直连[^\n]*|中转[^\n]*/g) }
})

// 非 trickle 建链最坏要等满 gather 上限（默认 30s），所以给到 70s。
let last = null
for (let i = 0; i < 70; i++) {
  last = await snapshot()
  if (last.pcs.some((p) => p.pair)) { console.log(`第 ${i} 秒连上`); break }
  await page.waitForTimeout(1000)
}

console.log('链路：', JSON.stringify(last, null, 2))
console.log('候选时间线：')
for (const c of await page.evaluate(() => window.__cand || [])) console.log(`  +${c.ms}ms ${c.line}`)

if (SHOT) await page.screenshot({ path: SHOT })
await browser.close()
