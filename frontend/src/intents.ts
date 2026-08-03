// 跨页意图。
//
// 点顶栏「＋ 新建」时，要弹窗的那个页面往往**还没挂载**：先切路由 → React 渲染 →
// 懒加载 chunk 落地 → 组件挂载并注册监听。这中间隔了好几帧，纯发事件必然打空
// （实测点完只跳了路由，弹窗没出来）。
//
// 所以事件之外再留一个标记：页面挂载时自己来取。取走即清，5 秒过期——否则一个
// 没被消费的意图会在用户十分钟后偶然逛到那一页时突然弹出来。
const TTL = 5000
let pending: { name: string; at: number } | null = null

export const INTENT_EVENT = 'tt-intent'

export function requestIntent(name: string) {
  pending = { name, at: Date.now() }
  window.dispatchEvent(new Event(INTENT_EVENT))
}

/** 目标页面调用：是我的意图就消费掉并返回 true */
export function takeIntent(name: string): boolean {
  if (!pending || pending.name !== name) return false
  const fresh = Date.now() - pending.at < TTL
  pending = null
  return fresh
}
