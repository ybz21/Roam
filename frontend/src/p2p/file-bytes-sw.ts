// 页面这一侧的接线：Service Worker 拦到 /api/file/raw 就问这里要字节。
//
// 为什么要分两处：SW 在另一个上下文里，碰不到 RTCPeerConnection；页面拿得到直连，
// 但拦不住 `<img src>`。所以 SW 负责拦、页面负责取，中间走 MessageChannel。
import { readFileRange } from './file-bytes'
import { getPreferences } from '../preferences'
import { currentNodeId } from '../components/cluster/node-url'

/** 直连还没建起来时，为一次字节请求最多等多久 */
const WAIT_LINK_MS = 2500
/** 小于这个大小的东西不值得等直连：几十 KB 的图标，等建链还不如直接走 HTTP 拿回来 */
const WORTH_IT_BYTES = 256 * 1024

type SwRequest = { type: string; url: string; range: string }

/** 解析 Range 头。只认单段的 `bytes=start-` / `bytes=start-end`；其余（多段、后缀）返回 null 让它走 HTTP。 */
export function parseRange(h: string): { offset: number; length: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec((h || '').trim())
  if (!m) return null
  const offset = Number(m[1])
  const end = m[2] ? Number(m[2]) : -1
  if (!Number.isFinite(offset) || offset < 0) return null
  if (end >= 0 && end < offset) return null
  return { offset, length: end >= 0 ? end - offset + 1 : 0 }
}

/** 从 /api/file/raw?path=... 里取出那个绝对路径 */
export function pathOf(url: string): string {
  try { return new URL(url).searchParams.get('path') || '' } catch { return '' }
}

/**
 * 这条 URL 要的是不是**当前这台机器**上的文件。
 *
 * 多机模式下地址形如 `/n/<nodeId>/api/file/raw`，而我们的直连只通向当前机器。
 * 不比这一下，在中心里翻别的机器的文件时会拿本机同路径的文件顶上去——
 * 那不是慢一点的问题，是给错文件。
 */
export function isCurrentNode(url: string): boolean {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { return false }
  const m = /^\/n\/([^/]+)\//.exec(pathname)
  if (!m) return true // 没有 /n/ 前缀 = 直连这台机器的地址（单机，或本机直通口）
  return decodeURIComponent(m[1]) === (currentNodeId() || '')
}

function headers(meta: { size: number; offset: number; length: number; contentType: string }, ranged: boolean) {
  const h: Record<string, string> = {
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.length),
    // 不报 Accept-Ranges，`<video>` 就不给拖进度条
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    // 标记这一条是从直连来的：出问题时「到底走了哪条路」不该靠猜（DevTools 里直接看得见）
    'X-Roam-Transport': 'p2p',
  }
  if (ranged) h['Content-Range'] = `bytes ${meta.offset}-${meta.offset + meta.length - 1}/${meta.size}`
  return h
}

async function serve(req: SwRequest, port: MessagePort) {
  const path = pathOf(req.url)
  const range = req.range ? parseRange(req.range) : { offset: 0, length: 0 }
  // 偏好关着、路径解析不出、Range 是我们不认的花样、要的是别的机器上的文件 → 让 SW 走网络
  if (!path || !range || !getPreferences().p2pEnabled || !isCurrentNode(req.url)) {
    port.postMessage({ type: 'net' })
    return
  }

  const ac = new AbortController()
  port.onmessage = (e) => { if (e.data?.type === 'cancel') ac.abort() }
  // 先应一声「我试」：直连可能还在建，SW 那边等首帧的耐心要放宽，
  // 否则第一枪永远是 HTTP —— 而第一枪往往正是最大的那一枪（整段视频）。
  port.postMessage({ type: 'try' })

  try {
    // 只有「要的量够大」才值得等直连建起来：请求带 Range 的基本都是视频/大文件，
    // 不带 Range 的第一枪不知道多大，也给它等——真小文件也就多等一次，之后链路就在了。
    const waitMs = range.length === 0 || range.length >= WORTH_IT_BYTES ? WAIT_LINK_MS : 0
    const { meta, stream } = await readFileRange(path, { ...range, waitMs, signal: ac.signal })
    port.postMessage({
      type: 'head',
      status: req.range ? 206 : 200,
      headers: headers(meta, !!req.range),
    })
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // buffer 转移所有权：几 MB 的视频段来回拷贝会把主线程拖出可见卡顿
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      port.postMessage({ type: 'chunk', buf }, [buf])
    }
    port.postMessage({ type: 'end' })
  } catch (e) {
    // 头还没发出去 → SW 会退回网络；已经发了 → 只能把这条流判失败（浏览器自己会重试）
    port.postMessage({ type: 'error', msg: String((e as Error)?.message || e) })
  }
}

let wired = false

/** 挂上监听。多调用几次无所谓（幂等），SW 没注册成功时什么也不做。 */
export function wireFileBytesToServiceWorker() {
  if (wired || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  wired = true
  navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as SwRequest | undefined
    if (!data || data.type !== 'roam-file-bytes') return
    const port = ev.ports?.[0]
    if (!port) return
    void serve(data, port)
  })
}
