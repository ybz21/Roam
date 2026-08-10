// hash 路由的读写：整站只有这一处碰 location.hash 的格式。
// 终端标签（terms/active）也挂在 hash 的 query 上——刷新后要还原开着的会话。


// 旧链接兼容：/#/env → /#/settings，/#/overview → /#/projects（概览并进项目页，18 设计）
export function normalizeRoute(raw: string): string {
  const route = raw.split('?')[0]
  if (route === 'env' || route.startsWith('env/')) return 'settings' + route.slice(3)
  if (route === 'overview' || route.startsWith('overview/')) return 'projects'
  if (route === 'about') return 'settings/about'  // 关于页并进设置（18 设计：设置页收下版本与安装）
  return route
}

export function getHashParams(): URLSearchParams {
  const h = location.hash
  const qi = h.indexOf('?')
  return new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '')
}

export function setHashParams(params: Record<string, string>) {
  const h = location.hash
  const base = (h.split('?')[0]) || '#/projects'
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) { if (v) sp.set(k, v) }
  const qs = sp.toString()
  const next = qs ? base + '?' + qs : base
  if (h !== next) history.replaceState(history.state, '', next)
}

// URL 上的终端标签参数（terms=打开的标签、active=当前标签）。
// 现在写进去的是会话 id；老链接里存的是会话名，两者都能读——还原时按 id 表判别（见 resolveToken）。
export function readTermTokens(): { terms: string[]; active: string } {
  const p = getHashParams()
  const t = p.get('terms')
  const a = p.get('active')
  return {
    terms: t ? t.split(',').map(decodeURIComponent).filter(Boolean) : [],
    active: a ? decodeURIComponent(a) : '',
  }
}
