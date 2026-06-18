// 检测到前端有新构建（index-<hash>.js 变了）就提示刷新，省得每次手动硬刷新。
// index.html 由后端以 no-cache 提供，所以轮询它拿到的就是最新 hash。
import { useEffect, useState } from 'react'

const RE = /assets\/index-([A-Za-z0-9_-]+)\.js/

function currentHash(): string {
  for (const s of Array.from(document.scripts)) {
    const m = s.src && s.src.match(RE)
    if (m) return m[1]
  }
  return ''
}

export default function UpdateBanner() {
  const [stale, setStale] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const cur = currentHash()
    if (!cur) return
    let stop = false
    const check = async () => {
      try {
        const r = await fetch('/', { cache: 'no-store' })
        const html = await r.text()
        const m = html.match(RE)
        if (!stop && m && m[1] !== cur) setStale(true)
      } catch {}
    }
    const t = setInterval(check, 60000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  if (!stale || dismissed) return null
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)', zIndex: 2000, display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', boxShadow: 'var(--elevated-shadow)', color: 'var(--text-bright)', fontSize: 13 }}>
      <span>🔄 有新版本</span>
      <a onClick={() => location.reload()} style={{ color: '#58a6ff', fontWeight: 600 }}>刷新</a>
      <a onClick={() => setDismissed(true)} style={{ color: 'var(--text-dim)' }}>稍后</a>
    </div>
  )
}
