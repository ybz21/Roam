// Roami PWA service worker —— 目标是「可安装 + 离线能打开外壳」，不缓存实时数据。
// 设计原则：
//  - /api/**（含 WebSocket 升级）一律直连网络，绝不拦截/缓存（终端、实时接口不能走缓存）。
//  - 导航请求(index.html) 网络优先，断网时回退到缓存的外壳，避免部署后拿到旧页面。
//  - 静态构建产物（带 hash 的 js/css/图标）缓存优先 + 后台更新（内容寻址、永不串版本）。
const SHELL = 'roami-shell-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch { return }
  if (url.origin !== self.location.origin) return     // 跨域：交给浏览器
  // 文件字节（图片/视频/PDF/Office 预览）：先问页面能不能走直连。
  // 页面说不行、或者半天不答，就照常走网络——拦截只是给它一条快路，不是把路拦死。
  if (isFileBytes(url)) { event.respondWith(fileBytes(event)) ; return }
  if (url.pathname.startsWith('/api')) return          // 其余实时接口/WS：直连网络

  // 导航（打开页面）：网络优先，失败回退缓存的外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req)
        const cache = await caches.open(SHELL)
        cache.put('/index.html', net.clone())
        return net
      } catch {
        const cached = await caches.match('/index.html')
        return cached || Response.error()
      }
    })())
    return
  }

  // 带 hash 的静态资源：缓存优先，命中即返回，同时后台拉新写回
  if (/\.(?:js|css|svg|png|webp|ico|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req)
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()))
        return res
      }).catch(() => cached)
      return cached || network
    })())
  }
})

// ── 文件字节走直连（P2P）─────────────────────────────────────────────────
//
// `<img src>` / `<video src>` / iframe 要的是一个 URL，而 DataChannel 不是 URL——
// 这就是 Service Worker 在这儿的全部意义：把直连拿到的字节塞进一个 Response 里，
// 上面那些标签一行都不用改。SW 自己碰不到 RTCPeerConnection（它在另一个上下文），
// 所以真正取字节的是页面：SW 把请求转给页面，页面把 chunk 传回来。
//
// 不拦 ?dl=1：那是「下载」，有自己的一条 P2P 流程（p2p/download.ts），
// 而且要带 Content-Disposition，不该由这里合成。
const FILE_BYTES = /(^|\/)api\/file\/raw$/

function isFileBytes(url) {
  return FILE_BYTES.test(url.pathname) && url.searchParams.get('dl') !== '1'
}

/** 页面多久不答就走网络。页面主线程忙的时候不能把一张图吊死在这儿 */
const DECIDE_TIMEOUT_MS = 700
/** 页面说「我试」之后，再等首帧多久。直连可能还在建（0.7s 左右），别在这一步前功尽弃 */
const HEAD_TIMEOUT_MS = 6000

async function fileBytes(event) {
  const req = event.request
  try {
    const client = await self.clients.get(event.clientId || event.resultingClientId)
    if (!client) return fetch(req)

    const ch = new MessageChannel()
    const head = await new Promise((resolve) => {
      let timer = setTimeout(() => resolve(null), DECIDE_TIMEOUT_MS)
      ch.port1.onmessage = (e) => {
        const m = e.data
        clearTimeout(timer)
        // 'try'：页面认了这一单，但直连可能还在建——把等待放宽到首帧超时，
        // 否则第一枪永远赶不上（页面在等链路，SW 已经走了网络）。
        if (m && m.type === 'try') { timer = setTimeout(() => resolve(null), HEAD_TIMEOUT_MS); return }
        resolve(m && m.type === 'head' ? m : null)
      }
      client.postMessage({
        type: 'roam-file-bytes',
        url: req.url,
        range: req.headers.get('Range') || '',
      }, [ch.port2])
    })
    if (!head) { try { ch.port1.postMessage({ type: 'cancel' }) } catch {} ; return fetch(req) }

    const body = new ReadableStream({
      start(controller) {
        ch.port1.onmessage = (e) => {
          const m = e.data
          if (!m) return
          if (m.type === 'chunk') controller.enqueue(new Uint8Array(m.buf))
          else if (m.type === 'end') { controller.close(); ch.port1.close() }
          else if (m.type === 'error') { controller.error(new Error(m.msg || 'p2p')); ch.port1.close() }
        }
      },
      // 浏览器不要了（拖进度条、关页面）：告诉页面停，别让后端对着空气继续发
      cancel() { try { ch.port1.postMessage({ type: 'cancel' }) } catch {} ; ch.port1.close() },
    })
    return new Response(body, { status: head.status, headers: head.headers })
  } catch {
    return fetch(req)
  }
}
