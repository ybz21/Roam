// 跨页意图。
//
// 点顶栏「＋ 新建」时，要弹窗的那个页面往往**还没挂载**：先切路由 → React 渲染 →
// 懒加载 chunk 落地 → 组件挂载并注册监听。这中间隔了好几帧，纯发事件必然打空
// （实测点完只跳了路由，弹窗没出来）。
//
// 所以事件之外再留一个标记：页面挂载时自己来取。取走即清，5 秒过期——否则一个
// 没被消费的意图会在用户十分钟后偶然逛到那一页时突然弹出来。
const TTL = 5000
let pending: { name: string; at: number; data?: unknown } | null = null

export const INTENT_EVENT = 'tt-intent'
/** 「打开这个文件」：⌘K 搜到文件后切到文件页，由文件工作区接手开标签页 */
export const OPEN_FILE_INTENT = 'open-file'

/** data 给带参数的意图用（如「打开这个文件」要把路径捎过去） */
export function requestIntent(name: string, data?: unknown) {
  pending = { name, at: Date.now(), data }
  window.dispatchEvent(new Event(INTENT_EVENT))
}

/** 目标页面调用：是我的意图就消费掉，把随行数据一起取走；没有我的意图返回 null（无参意图返回 true） */
export function takeIntentData<T = unknown>(name: string): T | true | null {
  if (!pending || pending.name !== name) return null
  const fresh = Date.now() - pending.at < TTL
  const data = pending.data
  pending = null
  if (!fresh) return null
  return (data === undefined ? true : (data as T))
}
