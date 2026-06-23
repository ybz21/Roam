// Roam PWA service worker —— 目标是「可安装 + 离线能打开外壳」，不缓存实时数据。
// 设计原则：
//  - /api/**（含 WebSocket 升级）一律直连网络，绝不拦截/缓存（终端、实时接口不能走缓存）。
//  - 导航请求(index.html) 网络优先，断网时回退到缓存的外壳，避免部署后拿到旧页面。
//  - 静态构建产物（带 hash 的 js/css/图标）缓存优先 + 后台更新（内容寻址、永不串版本）。
const SHELL = 'roam-shell-v1'

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
  if (url.pathname.startsWith('/api')) return          // 实时接口/WS：直连网络

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
