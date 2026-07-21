// 通用传输 Phase 1a：共享 control PeerConnection 客户端 + DuplexTransport connect() 工厂。
//
// 设计见 docs/design/p2p/general-transport-plan.md §2（DuplexTransport 抽象）/§3（左边栏全局状态）。
//
// 一条会话级常驻 control PC：
//   - 应用登录后，若 P2P 可用（/api/p2p/config 拉到）且用户偏好开（p2pEnabled），
//     经信令 WS 建一条带 class:"control" 的 PeerConnection（offer 里 class 标 control）。
//   - 后端按 class 走「会话级常驻 link PC」逻辑，连上后回 connected + 持续发 link{state,path}。
//   - 断线自动重连（指数退避）；建链失败/超时标记回退，供左边栏显示「中转」。
//
// connect(service)：control PC 已连 → createDataChannel(label=`<service>#<id>`)，
//   返回 DuplexTransport（≈WebSocket 的 send/onmessage/onclose/kind）。
//   未连 → 返回 kind='frp' 占位（本阶段 echo 无 frp 实现，仅结构就位，供后续消费者接管回退）。

import { openSignal } from './signaling'
import type { SignalMsg } from './types'
import type { P2PPathLabel } from './labels'
import { getPreferences } from '../preferences'

// dev-gate：ICE 生命周期诊断日志只在开发构建打印，生产静默（避免控制台噪音/泄漏地址）。
const P2P_DEBUG = import.meta.env.DEV
function dlog(...args: unknown[]) { if (P2P_DEBUG) console.log(...args) }

// 非 trickle（P0-2）：ICE gathering 完成才发 offer/answer 完整 SDP。等 iceGatheringState==='complete'，
// 或到 gather 上限就用当前 pc.localDescription 兜底发出。
// gather 上限可配（设置页 p2pGatherTimeoutSec，默认 30s）：STUN 正常时 gathering 1–2s 就 complete、
// 立刻发（LAN/快网不受影响）；只有慢网（如手机蜂窝 srflx 迟迟不来）才等满。太短会在 srflx 还没
// gather 出来时就发 SDP → srflx 丢失 → 跨网只能中转。connect 计时器已设为 gather+connect，不会误判。
const DEFAULT_GATHER_TIMEOUT_MS = 30_000
function gatherTimeoutMs() {
  const s = getPreferences().p2pGatherTimeoutSec
  return typeof s === 'number' && s >= 3 && s <= 300 ? s * 1000 : DEFAULT_GATHER_TIMEOUT_MS
}
// exported for unit test（非产品 API）；timeoutMs 缺省用 gatherTimeoutMs()（设置页可配）。
export function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = gatherTimeoutMs()): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      peer.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = () => { if (peer.iceGatheringState === 'complete') finish() }
    peer.addEventListener('icegatheringstatechange', onChange)
    // 上限兜底：超时用已 gather 的候选（当前 localDescription）发出，不无限等。
    const timer = setTimeout(finish, timeoutMs)
  })
}

// —— DuplexTransport：伪-WebSocket 抽象（两端对称），让功能层从 new WebSocket 平滑切到 connect() —— //
export interface DuplexTransport {
  send(data: string | ArrayBuffer): void
  onmessage: (d: string | ArrayBuffer) => void
  // 底层通道就绪（p2p=DataChannel open / frp=WebSocket open）。上层据此发首帧握手（如 emulate），
  // 语义与迁移前 ws.onopen 一致。设置晚于 open 的话，wrap 层会在下一微任务补触发一次。
  onopen: () => void
  onclose: () => void
  close(): void
  readonly kind: 'p2p' | 'frp' // 当前实际走哪条：p2p=DataChannel；frp=占位/回退
}

// 本阶段支持的服务名（echo 验证 + 后续消费者占位）。
export type Service = 'echo' | 'term' | 'screencast' | 'phone' | 'file'

// control 链路对外可观察状态（左边栏数据源）。
export type LinkState = 'disabled' | 'connecting' | 'connected' | 'relay'

export interface LinkStatus {
  state: LinkState
  // control PC 命中的路径枚举（ipv6-direct|upnp|stun|lan）或回退 'frp'；state=connected 时有值。
  path?: P2PPathLabel
  // 选中候选对 RTT（毫秒），仅诊断；来自 link 消息。
  rttMs?: number
  // media 类 PC 状态位（Phase 1b：浏览器/手机镜像）。按需建，镜像关闭后回 disabled。
  media?: LinkState
  // media PC 命中路径（ipv6-direct|upnp|stun|lan / frp）；media==='connected' 时有值。
  mediaPath?: P2PPathLabel
  // file 类临时 PC 状态位（每次下载一个，用完即拆）：connecting/connected/relay，空闲回 disabled。
  file?: LinkState
  // file 类 PC 命中路径（ipv6-direct|upnp|stun|lan / frp）；file==='connected' 时有值。
  filePath?: P2PPathLabel
}

// —— 全局 control 链路状态 store（useSyncExternalStore 订阅，喂左边栏 LinkStatus 组件）—— //
let status: LinkStatus = { state: 'disabled' }
const listeners = new Set<() => void>()

function setStatus(next: Partial<LinkStatus>) {
  status = { ...status, ...next }
  listeners.forEach((l) => l())
}

export function subscribeLink(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getLinkStatus(): LinkStatus {
  return status
}

// —— control PC 生命周期管理（单例）—— //

// 温和重连：首次 5s、每次退避翻倍、上限 60s。失败才退避，连上后清零。
// 之前 2s 基数会几秒一次 churn，跨网 ICE（STUN 往返 + trickle srflx + 连通性检查）根本来不及。
const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 60_000
// 建链超时（默认 30s，设置页可调 5–120s）：跨网需要 STUN 往返 + trickle srflx + 连通性检查，
// 太短到点拆 PC 会丢掉已 gather 的 srflx、永远连不上。只有「仍无候选对进展」时超时才判失败（见 negotiate）。
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
function connectTimeoutMs() {
  const s = getPreferences().p2pConnectTimeoutSec
  return typeof s === 'number' && s >= 5 && s <= 120 ? s * 1000 : DEFAULT_CONNECT_TIMEOUT_MS
}

interface P2PConfig {
  iceServers?: RTCIceServer[]
}

// control 类固定 transferId：后端按 class 分派，transferId 仅作会话内 PC 标识。
const CONTROL_ID = 'control'

let started = false        // start() 幂等
let stopped = false        // stop() 后不再重连
let ws: WebSocket | null = null
let pc: RTCPeerConnection | null = null
let controlChannel: RTCDataChannel | null = null // control PC 上的一条「保活/心跳」通道（label=control#id）
let reconnectTimer = 0
let connectTimer = 0
let attempt = 0
let iceServers: RTCIceServer[] | null = null // 缓存，避免每次重连都拉

// 拉后端 ICE 配置；成功 → P2P 可用。失败/未启用返回 null（不建 control PC）。
async function fetchIce(): Promise<RTCIceServer[] | null> {
  try {
    const r = await fetch('/api/p2p/config', { cache: 'no-store' })
    if (!r.ok) return null
    const data = await r.json().catch(() => null)
    const cfg: P2PConfig = data?.data ?? data ?? {}
    // 用户在设置页自定义了 STUN → 用它覆盖服务端默认（仅影响本浏览器侧打洞）。
    const userStun = getPreferences().p2pStunServers?.trim()
    if (userStun) {
      const urls = userStun.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      if (urls.length) return [{ urls }]
    }
    return Array.isArray(cfg.iceServers) ? cfg.iceServers : []
  } catch {
    return null
  }
}

function clearTimers() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0 }
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0 }
}

// 实时 RTT：control 连上后每 1.5s getStats 取选中候选对的 currentRoundTripTime → store，
// 让左边栏「往返时延」动态刷新（后端 connected/link 只给初值，静态）。
let rttTimer = 0
function startRttPoll(peer: RTCPeerConnection) {
  stopRttPoll()
  rttTimer = window.setInterval(() => {
    if (pc !== peer || status.state !== 'connected') return
    peer.getStats().then((stats) => {
      let rtt: number | undefined
      stats.forEach((r) => {
        const rr = r as { type?: string; nominated?: boolean; selected?: boolean; state?: string; currentRoundTripTime?: number }
        if (rr.type === 'candidate-pair' && (rr.nominated || rr.selected) && typeof rr.currentRoundTripTime === 'number') {
          rtt = rr.currentRoundTripTime
        }
      })
      if (rtt != null) setStatus({ rttMs: Math.round(rtt * 1000) })
    }).catch(() => { /* ignore */ })
  }, 1500)
}
function stopRttPoll() { if (rttTimer) { clearInterval(rttTimer); rttTimer = 0 } }

// 拆当前一轮 control 连接（幂等），保留 store 状态由调用方决定。
function teardown() {
  clearTimers()
  stopRttPoll()
  try { controlChannel?.close() } catch { /* ignore */ }
  try { pc?.close() } catch { /* ignore */ }
  try { ws?.close() } catch { /* ignore */ }
  controlChannel = null
  pc = null
  ws = null
}

// 安排一次退避重连（除非已 stop）。
function scheduleReconnect() {
  if (stopped) return
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4))
  attempt += 1
  clearTimers()
  reconnectTimer = window.setTimeout(() => { void negotiate() }, delay)
}

const wsSend = (m: SignalMsg) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}

// —— ICE 生命周期诊断日志（浏览器 F12 直接看两端有没有 srflx）—— //
// 每个本地候选打印 typ(host/srflx/relay)+地址；gathering/iceConnection/connection 每次变化打印。
// 前缀 [p2p-ice control] / [p2p-ice media] / [p2p-ice file]，方便复验。
function logLocalCandidate(tag: string, c: RTCIceCandidate | null) {
  if (!P2P_DEBUG) return
  if (!c) { dlog(`[p2p-ice ${tag}] local candidates: gathering done (null)`); return }
  // candidate 字符串形如 "candidate:... typ srflx raddr ... 地址 端口 ..."；直接透出便于核对 srflx。
  const typ = /\btyp (\w+)\b/.exec(c.candidate)?.[1] ?? '?'
  const addr = c.address ? `${c.address}:${c.port ?? '?'}` : c.candidate
  dlog(`[p2p-ice ${tag}] local candidate typ=${typ} ${addr}`)
}

// 给一个 PC 挂上 gathering/iceConnection/connection 三态变化日志（诊断用，不改行为）。dev-gate。
function attachIceDiagLogs(tag: string, peer: RTCPeerConnection) {
  if (!P2P_DEBUG) return
  peer.addEventListener('icegatheringstatechange', () => {
    dlog(`[p2p-ice ${tag}] iceGatheringState=${peer.iceGatheringState}`)
  })
  peer.addEventListener('iceconnectionstatechange', () => {
    dlog(`[p2p-ice ${tag}] iceConnectionState=${peer.iceConnectionState}`)
  })
  peer.addEventListener('connectionstatechange', () => {
    dlog(`[p2p-ice ${tag}] connectionState=${peer.connectionState}`)
  })
}

// 建一轮 control PC 协商：openSignal → offer(class:control) → answer/ice → connected。
async function negotiate() {
  if (stopped) return
  teardown() // 清掉上一轮（重连时）

  if (iceServers == null) iceServers = await fetchIce()
  if (iceServers == null) {
    // P2P 不可用（未启用或 config 拉不到）：保持 disabled，不重连。
    setStatus({ state: 'disabled', path: undefined, rttMs: undefined })
    return
  }

  setStatus({ state: 'connecting' })

  const socket = openSignal()
  ws = socket
  const peer = new RTCPeerConnection({ iceServers })
  pc = peer
  attachIceDiagLogs('control', peer)

  // control PC 上开一条保活通道（也让 SCTP/ICE 起真正协商）。label 走 control#id 规范，
  // 后端 OnDataChannel 按前缀识别为 control 保活，不承载业务。
  const keepAlive = peer.createDataChannel(`control#${CONTROL_ID}`, { ordered: true })
  keepAlive.binaryType = 'arraybuffer'
  controlChannel = keepAlive

  // 建链超时（30s）：到点时**只有**在 ICE 仍无任何进展（iceConnectionState 还是 new/checking
  // 且 gathering 已结束却没连上）才判失败。关键：iceGatheringState 还在 'gathering'、或
  // iceConnectionState 是 'new'/'checking'（连通性检查进行中）时，绝不 teardown 重建——
  // 重建会丢掉已 gather 的 srflx，跨网永远连不上。真正的失败交给 connectionstatechange→failed。
  connectTimer = window.setTimeout(() => {
    if (status.state === 'connected' || stopped) return
    const ice = peer.iceConnectionState
    const gathering = peer.iceGatheringState
    // ICE 还在推进（正在收候选或正在做连通性检查）：给它更多时间，不拆不重建，仅标 relay 供 UI 兜底。
    if (gathering === 'gathering' || ice === 'checking') {
      console.log(`[p2p-ice control] connect timeout reached but ICE still progressing (gathering=${gathering} ice=${ice}); keeping PC alive`)
      setStatus({ state: 'relay', path: 'frp' })
      return
    }
    // 无候选对进展（gather 完了 ice 还是 new，或已 failed/disconnected）：判失败，温和退避重连。
    console.log(`[p2p-ice control] connect timeout with no progress (gathering=${gathering} ice=${ice}); scheduling reconnect`)
    setStatus({ state: 'relay', path: 'frp' })
    scheduleReconnect()
  }, gatherTimeoutMs() + connectTimeoutMs()) // gather 有独立预算，连通性检查再享 connect 预算

  // 非 trickle（P0-2）：不再逐个 wsSend 候选——offer 会等 gathering 完成后一次性带全部候选发出。
  // 这里只保留候选诊断日志（dev-gate）。
  peer.onicecandidate = (e) => { logLocalCandidate('control', e.candidate) }

  peer.onconnectionstatechange = () => {
    if (!pc) return
    const st = peer.connectionState
    // 只有真正 failed/closed 才判失败重连。'disconnected' 常是暂时性网络抖动，ICE 会自愈回
    // connected（尤其跨网 srflx），此时拆 PC 反而丢候选——交给超时/failed 收口，不主动 teardown。
    if (st === 'failed' || st === 'closed') {
      if (!stopped) { setStatus({ state: 'relay', path: 'frp' }); scheduleReconnect() }
    }
  }

  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let m: SignalMsg
    try { m = JSON.parse(ev.data) } catch { return }
    // 只认 control 类（class 空的是老下载 file 流，忽略）。
    if (m.class !== 'control' && m.transferId !== CONTROL_ID) return
    if (m.type === 'answer' && m.sdp) {
      // 非 trickle：answer 完整 SDP 已含后端全部候选，直接 setRemoteDescription 即可，无需 addIceCandidate。
      peer.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { /* ignore */ })
    } else if (m.type === 'connected') {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0 }
      attempt = 0 // 连上即重置退避
      setStatus({ state: 'connected', path: (m.path as P2PPathLabel) ?? undefined, rttMs: m.rttMs })
      startRttPoll(peer) // 连上后实时刷新 RTT
    } else if (m.type === 'link') {
      // 后端 OnSelectedCandidatePairChange → link{state:up|down, path, rttMs}，左边栏据此更新。
      if (m.state === 'down') {
        setStatus({ state: 'relay', path: 'frp' })
      } else {
        setStatus({ state: 'connected', path: (m.path as P2PPathLabel) ?? status.path, rttMs: m.rttMs ?? status.rttMs })
      }
    } else if (m.type === 'fallback') {
      setStatus({ state: 'relay', path: 'frp' })
      scheduleReconnect()
    }
  }

  socket.onclose = () => {
    if (!stopped && status.state !== 'disabled') { setStatus({ state: 'relay', path: 'frp' }); scheduleReconnect() }
  }
  socket.onerror = () => { /* onclose 会接管重连 */ }

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    // 非 trickle：等 ICE gathering 完成，用含全部候选的 localDescription 一次性发 offer 完整 SDP。
    await waitForIceGathering(peer)
    if (pc !== peer || stopped) return // 已被下一轮/停机取代
    const fullSdp = peer.localDescription?.sdp ?? offer.sdp
    const sendOffer = () => wsSend({ type: 'offer', transferId: CONTROL_ID, class: 'control', sdp: fullSdp })
    if (socket.readyState === WebSocket.OPEN) sendOffer()
    else socket.addEventListener('open', sendOffer, { once: true })
  } catch {
    setStatus({ state: 'relay', path: 'frp' })
    scheduleReconnect()
  }
}

// startControlLink：应用登录后调用。幂等；偏好关闭时不建（保持 disabled/隐藏）。
export function startControlLink() {
  if (started) return
  if (!getPreferences().p2pEnabled) {
    setStatus({ state: 'disabled' })
    return
  }
  started = true
  stopped = false
  attempt = 0
  void negotiate()
}

// stopControlLink：登出/关闭偏好时拆链，回 disabled（连带拆 media PC）。
export function stopControlLink() {
  stopped = true
  started = false
  teardown()
  // media PC 依赖同一鉴权/偏好，主链停则一并拆（引用计数归零、不再重连）。
  if (mediaReleaseTimer) { clearTimeout(mediaReleaseTimer); mediaReleaseTimer = 0 }
  mediaStopped = true
  mediaStarted = false
  mediaRefs = 0
  teardownMedia()
  setStatus({ state: 'disabled', path: undefined, rttMs: undefined, media: 'disabled', mediaPath: undefined, file: 'disabled', filePath: undefined })
}

// control PC 是否已连（connect() 工厂据此决定走 DataChannel 还是 frp 占位）。
export function isControlConnected(): boolean {
  return status.state === 'connected' && !!pc && pc.connectionState === 'connected'
}

// ============================ media PC 生命周期（Phase 1b） ============================ //
// 高带宽、可丢帧的镜像流（浏览器/手机）走独立的 media 类 PC：单独 SCTP association、
// 单独拥塞控制，与 control 隔离（大文件/镜像不挤终端）。按需建（首个 connect('screencast')
// 触发 ensureMediaLink），最后一个消费者关闭后拆链（releaseMedia）。
//
// 与 control PC 对称：openSignal → offer(class:"media") → answer/ice → connected/link，
// 断线自动退避重连，建链超时/失败标记 media=relay（左边栏 media 行显示「中转」，消费者据此走 frp）。

const MEDIA_ID = 'media'

let mediaStarted = false          // ensureMediaLink 幂等
let mediaStopped = false          // releaseMedia 后不再重连
let mediaRefs = 0                 // 活跃 screencast 消费者计数，归零即释放
let mediaWs: WebSocket | null = null
let mediaPc: RTCPeerConnection | null = null
let mediaKeepAlive: RTCDataChannel | null = null
let mediaReconnectTimer = 0
let mediaConnectTimer = 0
let mediaAttempt = 0

function setMedia(state: LinkState, path?: P2PPathLabel) {
  setStatus({ media: state, mediaPath: state === 'connected' ? (path ?? status.mediaPath) : undefined })
}

function clearMediaTimers() {
  if (mediaReconnectTimer) { clearTimeout(mediaReconnectTimer); mediaReconnectTimer = 0 }
  if (mediaConnectTimer) { clearTimeout(mediaConnectTimer); mediaConnectTimer = 0 }
}

function teardownMedia() {
  clearMediaTimers()
  try { mediaKeepAlive?.close() } catch { /* ignore */ }
  try { mediaPc?.close() } catch { /* ignore */ }
  try { mediaWs?.close() } catch { /* ignore */ }
  mediaKeepAlive = null
  mediaPc = null
  mediaWs = null
}

function scheduleMediaReconnect() {
  if (mediaStopped || mediaRefs <= 0) return
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(mediaAttempt, 4))
  mediaAttempt += 1
  clearMediaTimers()
  mediaReconnectTimer = window.setTimeout(() => { void negotiateMedia() }, delay)
}

const mediaWsSend = (m: SignalMsg) => {
  if (mediaWs && mediaWs.readyState === WebSocket.OPEN) mediaWs.send(JSON.stringify(m))
}

// 建一轮 media PC 协商（与 control 对称，class:"media"）。
async function negotiateMedia() {
  if (mediaStopped || mediaRefs <= 0) return
  teardownMedia()

  // 复用 control 已拉到的 ICE 配置；未拉到则拉一次。null=P2P 不可用 → media 保持 disabled，消费者走 frp。
  if (iceServers == null) iceServers = await fetchIce()
  if (iceServers == null) { setStatus({ media: 'disabled', mediaPath: undefined }); return }

  setMedia('connecting')

  const socket = openSignal()
  mediaWs = socket
  const peer = new RTCPeerConnection({ iceServers })
  mediaPc = peer
  attachIceDiagLogs('media', peer)

  // media PC 上的保活/协商通道（label=media#id）。业务 screencast 通道另开（见 connect）。
  const keepAlive = peer.createDataChannel(`media#${MEDIA_ID}`, { ordered: true })
  keepAlive.binaryType = 'arraybuffer'
  mediaKeepAlive = keepAlive

  // 与 control 同款：30s 超时，且只在 ICE 无进展时才判失败重连；gathering/checking 中绝不拆重建。
  mediaConnectTimer = window.setTimeout(() => {
    if (status.media === 'connected' || mediaStopped || mediaRefs <= 0) return
    const ice = peer.iceConnectionState
    const gathering = peer.iceGatheringState
    if (gathering === 'gathering' || ice === 'checking') {
      console.log(`[p2p-ice media] connect timeout reached but ICE still progressing (gathering=${gathering} ice=${ice}); keeping PC alive`)
      setMedia('relay')
      return
    }
    console.log(`[p2p-ice media] connect timeout with no progress (gathering=${gathering} ice=${ice}); scheduling reconnect`)
    setMedia('relay')
    scheduleMediaReconnect()
  }, gatherTimeoutMs() + connectTimeoutMs()) // gather 有独立预算，连通性检查再享 connect 预算

  // 非 trickle（P0-2）：不再逐个 wsSend 候选；offer 等 gathering 完成后一次性带全部候选发出。
  peer.onicecandidate = (e) => { logLocalCandidate('media', e.candidate) }

  peer.onconnectionstatechange = () => {
    if (!mediaPc) return
    const st = peer.connectionState
    // 只在真正 failed/closed 才重连；'disconnected' 交给 ICE 自愈，不主动拆（丢候选）。
    if (st === 'failed' || st === 'closed') {
      if (!mediaStopped && mediaRefs > 0) { setMedia('relay'); scheduleMediaReconnect() }
    }
  }

  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let m: SignalMsg
    try { m = JSON.parse(ev.data) } catch { return }
    // 只认 media 类（避免同源信令 WS 上的 control/file 消息串扰）。
    if (m.class !== 'media' && m.transferId !== MEDIA_ID) return
    if (m.type === 'answer' && m.sdp) {
      // 非 trickle：answer 完整 SDP 已含后端全部候选，直接 setRemoteDescription。
      peer.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { /* ignore */ })
    } else if (m.type === 'connected') {
      if (mediaConnectTimer) { clearTimeout(mediaConnectTimer); mediaConnectTimer = 0 }
      mediaAttempt = 0
      // media PC 完整重协商成功：清掉「强制 WS」标记，给业务 DataChannel 再走一次 p2p 的机会（P1-6）。
      forceWsServices.clear()
      setMedia('connected', (m.path as P2PPathLabel) ?? undefined)
    } else if (m.type === 'link') {
      if (m.state === 'down') setMedia('relay')
      else setMedia('connected', (m.path as P2PPathLabel) ?? status.mediaPath)
    } else if (m.type === 'fallback') {
      setMedia('relay'); scheduleMediaReconnect()
    }
  }

  socket.onclose = () => {
    if (!mediaStopped && mediaRefs > 0 && status.media !== 'disabled') { setMedia('relay'); scheduleMediaReconnect() }
  }
  socket.onerror = () => { /* onclose 接管重连 */ }

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    // 非 trickle：等 gathering 完成，用含全部候选的 localDescription 一次性发 offer。
    await waitForIceGathering(peer)
    if (mediaPc !== peer || mediaStopped) return // 已被下一轮/释放取代
    const fullSdp = peer.localDescription?.sdp ?? offer.sdp
    const sendOffer = () => mediaWsSend({ type: 'offer', transferId: MEDIA_ID, class: 'media', sdp: fullSdp })
    if (socket.readyState === WebSocket.OPEN) sendOffer()
    else socket.addEventListener('open', sendOffer, { once: true })
  } catch {
    setMedia('relay'); scheduleMediaReconnect()
  }
}

// RELEASE_GRACE_MS：最后一个 screencast 消费者关闭后，延迟拆 media PC 的宽限期。
// BrowserView 会在 target/尺寸变化时卸载再挂载（close→refs 0→再 ensure→refs 1），若归零即
// 拆链，media PC 就会随每次重挂反复 ICE 重协商（churn），screencast DataChannel 永远稳不下来、
// 被迫退回 frp。宽限期内若有新消费者接手（refs 回升），取消这次拆链 → media PC 跨重挂存活。
const RELEASE_GRACE_MS = 3_000
let mediaReleaseTimer = 0

// ensureMediaLink：首个 screencast 消费者触发建 media PC（引用计数 +1）。
// 偏好关 / control PC 未启用（P2P 不可用）→ 不建，media 保持 disabled，消费者走 frp。
function ensureMediaLink() {
  mediaRefs += 1
  // 有新消费者接手：取消挂起的宽限拆链（重挂场景下 media PC 得以存活）。
  if (mediaReleaseTimer) { clearTimeout(mediaReleaseTimer); mediaReleaseTimer = 0 }
  if (!getPreferences().p2pEnabled) { setStatus({ media: 'disabled', mediaPath: undefined }); return }
  if (mediaStarted) return
  mediaStarted = true
  mediaStopped = false
  mediaAttempt = 0
  void negotiateMedia()
}

// releaseMedia：消费者关闭（引用计数 -1）；归零后经宽限期才拆 media PC，回 disabled。
// 宽限延迟避免 BrowserView 重挂（target 变化）时把 media PC 拆了又建导致 churn。
function releaseMedia() {
  mediaRefs = Math.max(0, mediaRefs - 1)
  if (mediaRefs > 0) return
  if (mediaReleaseTimer) clearTimeout(mediaReleaseTimer)
  mediaReleaseTimer = window.setTimeout(() => {
    mediaReleaseTimer = 0
    if (mediaRefs > 0) return // 宽限期内已被重新接手
    mediaStopped = true
    mediaStarted = false
    teardownMedia()
    setStatus({ media: 'disabled', mediaPath: undefined })
  }, RELEASE_GRACE_MS)
}

// media PC 是否已连（connect('screencast') 据此决定走不可靠 DataChannel 还是 frp WS）。
function isMediaConnected(): boolean {
  return status.media === 'connected' && !!mediaPc && mediaPc.connectionState === 'connected'
}

// ============================ file 类临时 PC（下载） ============================ //
// 文件下载走「每下载一个、用完即拆」的临时 PC（与 control/media 的持久 PC 区别开，做拥塞隔离：
// 大文件传输独立 SCTP，不挤终端/镜像）。但建链/ICE/信令/候选 trickle/超时全部复用上面那套低层
// 逻辑（fetchIce/openSignal/attachIceDiagLogs/logLocalCandidate/CONNECT_TIMEOUT_MS/wrapChannel），
// 不再在 download.ts 里另造一套。
//
// 线协议与迁移前逐字节一致：offer/ice/answer/connected 一律 class 留空（后端把空 class 路由到
// 「每下载一个 file PC」的 startTransfer，见 backend/p2p/manager.go），offer 携带 transfer{path,op}，
// 业务 DataChannel 的 label 固定为 'file'（可靠·有序）。
//
// download.ts 只拿回：那条 'file' DataChannel 的 DuplexTransport + connected/fallback 事件 + pc（取 RTT）
// + transferId（发 cancel）+ close()。所有低层托付本模块。

// file 类 PC 的对外句柄：文件协议层（download.ts）据此发/收 meta/分块/eof，并感知连上/回退。
export interface FilePeer {
  // 业务通道：可靠·有序的 'file' DataChannel（kind 恒为 'p2p'）。
  readonly tp: DuplexTransport
  // 本次传输的 transferId（信令校验/发 cancel 用）。
  readonly transferId: string
  // 底层 PC（GoodputMeter 取 candidate-pair RTT/诊断用）。
  readonly pc: RTCPeerConnection
  // 连上回调：后端回 connected 时触发一次，带命中 path 与候选诊断。由 download.ts 设置。
  onConnected: (path: P2PPathLabel, diag: FilePeerDiag) => void
  // 回退回调：连链超时 / ICE failed / 信令 WS 断 / 后端 fallback → 触发一次。由 download.ts 设置。
  // download.ts 收到后走 http 回退（file link 状态已由本模块置 relay）。
  onFallback: (reason: string) => void
  // 发 cancel 信令（回退/取消时通知后端拆 PC）。
  sendCancel: (reason: string) => void
  // 拆本次临时 PC（dc/pc/ws 全关，清超时），并把 file link 状态回 disabled（空闲）。幂等。
  close: () => void
}

// connected 附带的候选诊断（download.ts 透给详情浮层）。
export interface FilePeerDiag {
  rttMs?: number
  localType?: string
  remoteType?: string
  localFamily?: string
  remoteFamily?: string
}

// connectFile 选项。
export interface ConnectFileOptions {
  // 下载目标绝对路径（op=spike 时忽略）。
  path: string
  // 传输 op：真实下载=download（缺省）；spike 自测=spike。
  op?: 'download' | 'spike'
}

// 更新 file link store：connecting/connected(+path)/relay/disabled，喂左边栏「文件」行。
function setFile(state: LinkState, path?: P2PPathLabel) {
  setStatus({ file: state, filePath: state === 'connected' ? (path ?? status.filePath) : undefined })
}

// connectFile(target)：建一条 file 类临时 PC 并开可靠·有序 'file' DataChannel，返回 FilePeer。
//
// 复用 control/media 同款低层：fetchIce → openSignal → offer(空 class, 带 transfer) → trickle ICE →
// answer → connected；30s 连链超时（超时/ICE failed/WS 断 → onFallback）。连上/回退期间把 file link
// 状态写进全局 store（左边栏「文件」行显示 直连·<path> / 中转，空闲 disabled）。
//
// 与持久 link 的区别只在生命周期：file PC 每次下载新建、用完 close() 即拆、不重连、不进 links 表；
// 建链/ICE/信令/候选/classifyPath 全共用（低层只写一处）。
export async function connectFile(opts: ConnectFileOptions): Promise<FilePeer> {
  const transferId = crypto.randomUUID()
  // 复用 control 已拉到的 ICE 配置；未拉到则拉一次。null=P2P 不可用 → 空数组（本机/LAN 直连）。
  if (iceServers == null) iceServers = await fetchIce()
  const servers = iceServers ?? []

  const ws = openSignal()
  const peer = new RTCPeerConnection({ iceServers: servers })
  attachIceDiagLogs('file', peer)

  // 业务通道：label 固定 'file'（线协议约定），可靠·有序。后端 OnDataChannel 拿到即走 serveFile。
  const dc = peer.createDataChannel('file', { ordered: true })
  const tp = wrapChannel(dc)

  const wsSend = (m: SignalMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

  let done = false          // 终结标志：置 1 后忽略迟到 connected/link，onFallback/onConnected 各至多一次
  let connectTimer = 0
  const clearConnectTimer = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0 } }

  const peerObj: FilePeer = {
    tp,
    transferId,
    pc: peer,
    onConnected: () => {},
    onFallback: () => {},
    sendCancel: (reason) => wsSend({ type: 'cancel', transferId, reason }),
    close: () => {
      done = true
      clearConnectTimer()
      try { tp.close() } catch { /* ignore */ }
      try { peer.close() } catch { /* ignore */ }
      try { ws.close() } catch { /* ignore */ }
      setFile('disabled')
    },
  }

  // 触发一次回退：置 file link=relay，通知 download.ts 走 http（幂等）。
  const fail = (reason: string) => {
    if (done) return
    done = true
    clearConnectTimer()
    setFile('relay')
    peerObj.onFallback(reason)
  }

  setFile('connecting')

  // 连链超时（30s）：与 control/media 同款——只有 ICE 已无进展才判失败回退；gathering/checking
  // 中给足时间不拆（跨网 srflx 尚未到）。文件可回退，超时即 onFallback('timeout')。
  connectTimer = window.setTimeout(() => {
    if (done) return
    const ice = peer.iceConnectionState
    const gathering = peer.iceGatheringState
    if (gathering === 'gathering' || ice === 'checking') {
      console.log(`[p2p-ice file] connect timeout reached but ICE still progressing (gathering=${gathering} ice=${ice}); falling back`)
    } else {
      console.log(`[p2p-ice file] connect timeout with no progress (gathering=${gathering} ice=${ice}); falling back`)
    }
    fail('timeout')
  }, gatherTimeoutMs() + connectTimeoutMs()) // gather 有独立预算，连通性检查再享 connect 预算

  // 非 trickle（P0-2）：不再逐个 wsSend 候选；offer 等 gathering 完成后一次性带全部候选发出。
  peer.onicecandidate = (e) => { logLocalCandidate('file', e.candidate) }

  peer.onconnectionstatechange = () => {
    // 只有真正 failed 才回退（超时另有兜底）；'disconnected' 交给 ICE 自愈，不提前拆。
    if (peer.connectionState === 'failed') fail('ice-failed')
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return // 信令只走 text
    let m: SignalMsg
    try { m = JSON.parse(ev.data) } catch { return }
    // 只认本 transferId 的 file 类（class 空）消息；忽略串扰/迟到/持久 link 消息。
    if (m.transferId !== transferId || done) return
    if (m.type === 'answer' && m.sdp) {
      // 非 trickle：answer 完整 SDP 已含后端全部候选，直接 setRemoteDescription。
      peer.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { /* ignore */ })
    } else if (m.type === 'connected') {
      clearConnectTimer()
      setFile('connected', (m.path as P2PPathLabel) ?? undefined)
      peerObj.onConnected((m.path as P2PPathLabel) ?? 'stun', {
        rttMs: m.rttMs,
        localType: m.local?.type,
        remoteType: m.remote?.type,
        localFamily: m.local?.family,
        remoteFamily: m.remote?.family,
      })
    } else if (m.type === 'fallback') {
      fail(m.reason ?? 'fallback')
    }
  }
  ws.onclose = () => { fail('ws-closed') }
  ws.onerror = () => { /* onclose 接管回退 */ }

  // 发 offer（空 class + transfer{path,op}）。op 由调用方给（真实下载=download；spike=spike）。
  // 非 trickle：等 ICE gathering 完成后用含全部候选的 localDescription 一次性发。
  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForIceGathering(peer)
    if (done) return peerObj // 已被 close()/timeout 终结，别再发
    const fullSdp = peer.localDescription?.sdp ?? offer.sdp
    const sendOffer = () => wsSend({
      type: 'offer',
      transferId,
      sdp: fullSdp,
      transfer: { path: opts.path, op: opts.op ?? 'download' },
    })
    if (ws.readyState === WebSocket.OPEN) sendOffer()
    else ws.addEventListener('open', sendOffer, { once: true })
  } catch {
    // offer 失败：延到下一宏任务派发 onFallback——确保调用方拿到 peerObj 并挂好 onFallback 之后再触发
    // （connectFile 已 return，调用方的同步 executor 会先跑完设好回调）。
    setTimeout(() => fail('offer-failed'), 0)
  }

  return peerObj
}

// —— frp 占位 transport：结构就位，echo 等无 frp 后端实现的服务用它 —— //
function frpPlaceholder(): DuplexTransport {
  const tp: DuplexTransport = {
    kind: 'frp',
    onmessage: () => {},
    onopen: () => {},
    onclose: () => {},
    send: () => { /* 占位：echo 无 frp 实现 */ },
    close: () => { tp.onclose() },
  }
  return tp
}

// 把一条 WebSocket 包成 DuplexTransport（kind='frp'）。用于 P2P 不可用时的无感回退：
// send/onmessage/onclose/close 逐一映射到 WS，二进制以 ArrayBuffer 收发 —— 对上层与直接
// new WebSocket 逐字节等价（BrowserView 迁移后 frp 分支行为不回归的保证）。
function wrapWebSocket(ws: WebSocket): DuplexTransport {
  ws.binaryType = 'arraybuffer'
  let isOpen = ws.readyState === WebSocket.OPEN
  const tp: DuplexTransport = {
    kind: 'frp',
    onmessage: () => {},
    onopen: () => {},
    onclose: () => {},
    send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data as any) },
    close: () => { try { ws.close() } catch { /* ignore */ } },
  }
  ws.onopen = () => { isOpen = true; tp.onopen() }
  ws.onmessage = (ev) => tp.onmessage(ev.data)
  ws.onclose = () => tp.onclose()
  // 若 socket 已 open（罕见：同步复用），下一微任务补触发 onopen，让上层来得及挂回调。
  if (isOpen) queueMicrotask(() => tp.onopen())
  // onerror 不额外触发 onclose：WS 规范里 error 后必跟 close，交给 onclose 收口（避免双触发）。
  return tp
}

// 把一条 RTCDataChannel 包成 DuplexTransport。
function wrapChannel(dc: RTCDataChannel): DuplexTransport {
  dc.binaryType = 'arraybuffer'
  // 新建的 DataChannel 初始为 'connecting'，open 前调 dc.send 会抛错丢帧；
  // 故 open 前的 send 先入队，onopen 时按序冲刷（对上层=WebSocket send 语义透明）。
  let outbox: (string | ArrayBuffer)[] | null = dc.readyState === 'open' ? null : []
  const rawSend = (data: string | ArrayBuffer) => { try { dc.send(data as any) } catch { /* 通道已关，忽略 */ } }
  const tp: DuplexTransport = {
    kind: 'p2p',
    onmessage: () => {},
    onopen: () => {},
    onclose: () => {},
    send: (data) => { if (outbox) outbox.push(data); else rawSend(data) },
    close: () => { outbox = null; try { dc.close() } catch { /* ignore */ } },
  }
  dc.onopen = () => {
    const q = outbox
    outbox = null
    if (q) for (const d of q) rawSend(d)
    tp.onopen()
  }
  // 通道已经 open（罕见）：下一微任务补触发 onopen，让上层来得及挂回调。
  if (dc.readyState === 'open') queueMicrotask(() => tp.onopen())
  dc.onmessage = (ev) => tp.onmessage(ev.data)
  dc.onclose = () => tp.onclose()
  dc.onerror = () => { try { dc.close() } catch { /* ignore */ } }
  return tp
}

// P1-6：媒体业务 DataChannel open 超时（media PC 已 connected 但 DC 迟迟不 open→判 DC 层坏）。
const MEDIA_DC_OPEN_TIMEOUT_MS = 5_000

// forceWsServices：某服务的 media DataChannel 曾经 open 失败/意外断过 → 标记它下次 connect 直接走
// frp WS，别再赌 p2p（避免消费者反复重连都卡在坏 DC 上）。media PC 完整重协商后清空（下次或有救）。
const forceWsServices = new Set<Service>()

// mediaDcWithFallback：给镜像业务 DataChannel 包一层「open 超时 + 意外 close」→ 无感切 frpUrl。
//
// media PC 已 connected 不代表其上的业务 DataChannel 一定能 open（SCTP 抖动/后端 handler 没接线/
// 通道中途被关）。这里返回一个可切换底层的代理 DuplexTransport：
//   - 先接 DataChannel；MEDIA_DC_OPEN_TIMEOUT_MS 内未 open → 关 DC、标记该服务强制 WS、切 frpUrl。
//   - DC open 后又意外 close（非消费者主动 close）→ 同样标记强制 WS 并切 frpUrl，触发消费者层重连逻辑。
// 切换对消费者透明：代理把 onopen/onmessage/onclose 转发到当前底层；切到 WS 时 WS 的 onopen 会再触发
// 一次（消费者据此重发 emulate/init，语义与迁移前 ws.onopen 一致）。
function mediaDcWithFallback(dc: RTCDataChannel, service: Service, frpUrl?: string): DuplexTransport {
  let current = wrapChannel(dc)
  let opened = dc.readyState === 'open'
  let switched = false     // 已切到 frp（幂等）
  let userClosed = false   // 消费者主动 close（不再回退）
  let openTimer = 0

  // 代理对象：把消费者挂的回调转发给「当前底层」；切底层时重绑，对消费者透明。
  const proxy: DuplexTransport = {
    kind: current.kind,
    onmessage: () => {},
    onopen: () => {},
    onclose: () => {},
    send: (d) => current.send(d),
    close: () => {
      userClosed = true
      if (openTimer) { clearTimeout(openTimer); openTimer = 0 }
      current.close()
    },
  }

  // 把一条底层 transport 的事件接到 proxy 上。DC 底层额外接管 open 超时 / 意外 close 的回退。
  const bindDc = (tp: DuplexTransport) => {
    tp.onopen = () => {
      opened = true
      if (openTimer) { clearTimeout(openTimer); openTimer = 0 }
      ;(proxy as { kind: DuplexTransport['kind'] }).kind = tp.kind
      proxy.onopen()
    }
    tp.onmessage = (d) => proxy.onmessage(d)
    tp.onclose = () => {
      // DC 意外 close（非消费者主动关且未回退过）→ 切 frp；否则如常向上抛 close。
      if (!userClosed && !switched) {
        dlog(`[p2p-ice media] business dc '${service}' closed unexpectedly; falling back to frp`)
        toFrp()
        return
      }
      proxy.onclose()
    }
  }
  const bindWs = (tp: DuplexTransport) => {
    tp.onopen = () => { (proxy as { kind: DuplexTransport['kind'] }).kind = tp.kind; proxy.onopen() }
    tp.onmessage = (d) => proxy.onmessage(d)
    tp.onclose = () => proxy.onclose()
  }

  // 切到 frp WS（幂等）。消费者主动 close 时不切。
  function toFrp() {
    if (switched || userClosed) return
    switched = true
    if (openTimer) { clearTimeout(openTimer); openTimer = 0 }
    forceWsServices.add(service) // 该服务下次 connect 直接走 WS
    try { current.close() } catch { /* ignore */ }
    if (!frpUrl) { proxy.onclose(); return } // 无回退目标：按断开处理，让消费者走自身重连
    current = wrapWebSocket(new WebSocket(frpUrl))
    bindWs(current)
  }

  bindDc(current)

  // open 超时：DC 迟迟不 open（SCTP 抖动/后端没接线）→ 判 DC 层坏，切 frp。
  if (!opened) {
    openTimer = window.setTimeout(() => {
      if (opened || switched || userClosed) return
      dlog(`[p2p-ice media] business dc '${service}' open timeout (${MEDIA_DC_OPEN_TIMEOUT_MS}ms); falling back to frp`)
      toFrp()
    }, MEDIA_DC_OPEN_TIMEOUT_MS)
  }

  return proxy
}

// connect() 选项：不同服务的回退目标 / 通道语义。
export interface ConnectOptions {
  // frp 回退用的 WebSocket URL（P2P 不可用时直接连它，行为=迁移前的裸 WS）。
  frpUrl?: string
  // p2p DataChannel 打开后要先发的握手载荷（把原本编在 WS query 里的 params 带给后端）。
  // 仅 p2p 分支使用；frp 分支 params 已在 frpUrl 的 query string 里，无需重复。
  initParams?: Record<string, string>
}

// connect(service, opts)：
//   - 'screencast' / 'phone'：media PC 已连 → 开一条【不可靠·无序】DataChannel(label=`<service>#<id>`)，
//     入参编进 label 的 query（随通道建立可靠送达）；否则/失败 → 回退到 opts.frpUrl 的 frp
//     WebSocket（kind='frp'）。两者都是高带宽、可丢帧的镜像流，共用 media PC + 引用计数。
//   - 其它服务：control PC 已连 → 开一条【可靠·有序】DataChannel；否则 → frp 占位。
// 后端按 label 前缀分派回原 handler（screencast→浏览器镜像；phone→手机镜像）。
export function connect(service: Service, opts: ConnectOptions = {}): DuplexTransport {
  if (service === 'screencast' || service === 'phone') {
    // 引用计数 +1：只要有镜像视图打开，media PC 就该在（哪怕本次调用回退 frp，也让它持续
    // 重连，下次 connect 可升级到 p2p）。close() 时经 withRelease 归还，计数归零才拆 media PC。
    ensureMediaLink()
    const frp = () => (opts.frpUrl ? wrapWebSocket(new WebSocket(opts.frpUrl)) : frpPlaceholder())
    // P1-6：该服务上一次 media DataChannel open 失败/意外断过 → 本次直接走 frp，别再赌坏 DC。
    // media PC 完整重协商（下一次 connected）会清空该标记，给 p2p 再一次机会。
    if (forceWsServices.has(service)) return withRelease(frp())
    if (isMediaConnected() && mediaPc) {
      const id = crypto.randomUUID().slice(0, 8)
      try {
        // 入参（target/control/auto/q/...）编进 DataChannel label 的 query（原本靠 WS query 传）。
        // 关键：镜像通道是【不可靠·无序】的，绝不能把 control/auto 这类一次性关键入参放进业务
        // 消息里发——会丢帧或乱序（实测首帧常抢在 init 前到，且 init 可能整包丢失）。
        // 放 label 里则随 DataChannel 建立可靠送达，后端按前缀解析，无需握手。
        const qs = opts.initParams ? new URLSearchParams(opts.initParams).toString() : ''
        const label = qs ? `${service}#${id}?${qs}` : `${service}#${id}`
        // 镜像：丢帧优于阻塞 → 不可靠·无序（maxRetransmits:0, ordered:false），与 control/file 隔离。
        const dc = mediaPc.createDataChannel(label, { ordered: false, maxRetransmits: 0 })
        // P1-6：media PC 已连但业务 DataChannel 迟迟不 open / 中途意外 close → 无感切到 frpUrl。
        const tp = mediaDcWithFallback(dc, service, opts.frpUrl)
        return withRelease(tp)
      } catch { /* 建通道失败 → 落到下面 frp 回退 */ }
    }
    return withRelease(frp()) // media 未连/建通道失败：本次走 frp，但保留 media 引用继续重连
  }
  // 其余服务走 control PC 的可靠通道。
  if (!isControlConnected() || !pc) return opts.frpUrl ? wrapWebSocket(new WebSocket(opts.frpUrl)) : frpPlaceholder()
  const id = crypto.randomUUID().slice(0, 8)
  try {
    const dc = pc.createDataChannel(`${service}#${id}`, { ordered: true })
    return wrapChannel(dc)
  } catch {
    return opts.frpUrl ? wrapWebSocket(new WebSocket(opts.frpUrl)) : frpPlaceholder()
  }
}

// 给 screencast transport 的 close() 挂上 releaseMedia：消费者关闭时归还 media 引用计数，
// 计数归零则拆 media PC。无论走 p2p 还是 frp 分支都要释放（ensureMediaLink 已计过数）。
function withRelease(tp: DuplexTransport): DuplexTransport {
  const origClose = tp.close.bind(tp)
  let released = false
  tp.close = () => { if (!released) { released = true; releaseMedia() } origClose() }
  return tp
}

// ============================ echo 验证钩子（dev/temp） ============================ //
// [临时/仅开发] Phase 1a transport 自测：经 connect('echo') 开一条 DataChannel，
// 发个带时间戳的 ping，后端回显同帧 → 算往返毫秒并 console.log。
// 挂在 window.roamP2PEcho（不接产品 UI，避免触发 i18n 规范）。
// 前提：control PC 已连（左边栏显示「直连」）；未连返回 kind='frp' 占位，本阶段 echo 无 frp 实现。
export function roamP2PEcho(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const tp = connect('echo')
    if (tp.kind === 'frp') {
      console.warn('[p2p-echo] control PC not connected (kind=frp placeholder); echo unavailable this phase')
      resolve(undefined)
      return
    }
    const sentAt = performance.now()
    const timer = window.setTimeout(() => {
      console.warn('[p2p-echo] timeout: no echo within 5s')
      try { tp.close() } catch { /* ignore */ }
      resolve(undefined)
    }, 5_000)
    tp.onmessage = () => {
      const rtt = performance.now() - sentAt
      window.clearTimeout(timer)
      console.log(`[p2p-echo] round-trip via ${tp.kind} = ${rtt.toFixed(1)}ms`)
      try { tp.close() } catch { /* ignore */ }
      resolve(rtt)
    }
    tp.onclose = () => { window.clearTimeout(timer) }
    tp.send(JSON.stringify({ t: 'ping', ts: Date.now() }))
  })
}
