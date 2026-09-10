// 逐个探公共 STUN：能不能通、要多久、看到的公网地址是什么。
//
// 为什么要探：我们是非 trickle，等的是 iceGatheringState==='complete'。一台不通的 STUN
// 不会被跳过，Chrome 会重试到自己超时——写进默认列表的每一台死服务器，都是加在每次建链
// 上的等待。所以默认列表只收这里实测通过的。
//
//   node scripts/dev/p2p/stun-probe.mjs                # 探内置候选表
//   node scripts/dev/p2p/stun-probe.mjs stun:a:3478 …  # 只探指定的
//   ROUNDS=3 TIMEOUT=1500 node scripts/dev/p2p/stun-probe.mjs
import dgram from 'node:dgram'
import dns from 'node:dns/promises'

const CANDIDATES = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.syncthing.net:3478',
  'stun:stun.nextcloud.com:3478',
  'stun:stun.nextcloud.com:443',
  'stun:global.stun.twilio.com:3478',
  'stun:stun.relay.metered.ca:80',
  'stun:stun.hot-chilli.net:3478',
  'stun:stun.sipgate.net:3478',
  'stun:stun.ekiga.net:3478',
  'stun:stun.voipbuster.com:3478',
  'stun:stun.stunprotocol.org:3478',
  'stun:stun.services.mozilla.com:3478',
]

const ROUNDS = Number(process.env.ROUNDS || 3)
const TIMEOUT = Number(process.env.TIMEOUT || 1500)
const MAGIC = 0x2112a442

function bindingRequest() {
  const b = Buffer.alloc(20)
  b.writeUInt16BE(0x0001, 0) // Binding Request
  b.writeUInt16BE(0, 2)      // length
  b.writeUInt32BE(MAGIC, 4)
  for (let i = 8; i < 20; i++) b[i] = Math.floor(Math.random() * 256)
  return b
}

// 只认 XOR-MAPPED-ADDRESS(0x0020)/MAPPED-ADDRESS(0x0001)，其余属性跳过。
function parseMapped(msg, tid) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101) return null
  if (!msg.subarray(8, 20).equals(tid)) return null
  let off = 20
  const end = 20 + msg.readUInt16BE(2)
  while (off + 4 <= Math.min(end, msg.length)) {
    const type = msg.readUInt16BE(off)
    const len = msg.readUInt16BE(off + 2)
    const val = msg.subarray(off + 4, off + 4 + len)
    if ((type === 0x0020 || type === 0x0001) && len >= 8 && val[1] === 0x01) {
      const xor = type === 0x0020
      const port = val.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0)
      const ip = [...val.subarray(4, 8)].map((b, i) => b ^ (xor ? (MAGIC >>> ((3 - i) * 8)) & 0xff : 0))
      return `${ip.join('.')}:${port}`
    }
    off += 4 + len + ((4 - (len % 4)) % 4) // 属性 4 字节对齐
  }
  return null
}

function probeOnce(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const tid = bindingRequest()
    const t0 = process.hrtime.bigint()
    const timer = setTimeout(() => { sock.close(); resolve({ ok: false, err: '超时' }) }, TIMEOUT)
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); resolve({ ok: false, err: e.code || e.message }) })
    sock.on('message', (msg) => {
      const mapped = parseMapped(msg, tid.subarray(8, 20))
      clearTimeout(timer); sock.close()
      resolve(mapped ? { ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6, mapped } : { ok: false, err: '响应无法解析' })
    })
    sock.send(tid, port, host, (e) => { if (e) { clearTimeout(timer); sock.close(); resolve({ ok: false, err: e.code || e.message }) } })
  })
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES
const rows = []
for (const url of targets) {
  const m = /^(?:stun:)?([^:]+|\[[^\]]+\]):(\d+)$/.exec(url.replace(/\?.*$/, ''))
  if (!m) { console.log(`${url.padEnd(40)} 解析不了`); continue }
  const [, host, port] = m
  let ip = ''
  try { ip = (await dns.lookup(host, { family: 4 })).address } catch (e) { rows.push({ url, ok: false, err: 'DNS ' + (e.code || '') }); console.log(`${url.padEnd(40)} DNS 解析失败`); continue }
  const oks = []
  let err = ''
  let mapped = ''
  for (let i = 0; i < ROUNDS; i++) {
    const r = await probeOnce(host, Number(port))
    if (r.ok) { oks.push(r.ms); mapped = r.mapped } else err = r.err
  }
  const ok = oks.length > 0
  const avg = ok ? oks.reduce((a, b) => a + b, 0) / oks.length : 0
  rows.push({ url, ip, ok, loss: (ROUNDS - oks.length) / ROUNDS, ms: avg, mapped, err })
  console.log(`${ok ? '通' : '不通'}  ${url.padEnd(40)} ${ip.padEnd(16)} ${ok ? `${avg.toFixed(0)}ms  ${oks.length}/${ROUNDS}  ${mapped}` : err}`)
}

const good = rows.filter((r) => r.ok && r.loss === 0).sort((a, b) => a.ms - b.ms)
console.log(`\n${good.length}/${rows.length} 台零丢包，按时延排序：`)
for (const r of good) console.log(`  ${r.ms.toFixed(0).padStart(5)}ms  ${r.url}`)
