// 中心健康判据。
//
// 2026-08-11 中心因 goroutine 泄漏卡死十几个小时，无人发现。事后加了中心页（#199），
// 但**光有页面救不了这种事**：你只有在「发现打不开」之后才会想起有那么一页。
// 所以异常必须自己冒到眼前——侧栏那枚按钮上的红点是唯一常驻、一定会被看见的位置。
//
// 关键设计：**不用绝对阈值**。
//   「内存 > 300MB」在那台 1.6G 的机器上合理，换台 16G 的就是误报；
//   「goroutine > 1000」在两台节点时合理，接了二十台就不一定。
// 误报一次，这个红点以后就再没人信了。所以这里只认**形状**：单调增长且翻倍。
// 形状与机器大小、集群规模都无关，而今早那条曲线正是教科书式的形状——
//   09:50 1518 → 09:55 2667 → 10:00 7126 → 10:20 18298
// 而正常波动（18 → 50 → 18）不单调，一次性尖峰也不单调，两者都不会触发。

import { useSyncExternalStore } from 'react'
import { isHubMode } from './node-url'

export type HubSample = { at: number; rss: number; goroutines: number; heap: number; tunnels: number; requests: number }

export type HubHealth = {
  level: 'ok' | 'warn' | 'bad'
  /** 机器可读的原因码，文案交给 i18n（hub.why.*） */
  reasons: string[]
}

/** 连续爬多少个采样点才算数。5 分钟一采 → 6 点 ≈ 半小时，够长到排除抖动，短到还来得及救。 */
const RUN = 6

/**
 * 一个序列是不是「在持续爬」：**每一步都不下降**，且末尾至少是开头的两倍。
 *
 * 两个条件缺一不可：
 *   只要「翻倍」——一次尖峰（18 → 50）就会误报；
 *   只要「单调」——从 18 慢慢挪到 21 也会误报。
 */
function climbing(series: number[]): boolean {
  if (series.length < RUN) return false
  const tail = series.slice(-RUN)
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] < tail[i - 1]) return false
  }
  const first = tail[0], last = tail[tail.length - 1]
  return first > 0 && last >= first * 2
}

/**
 * 评估中心健康。samples 按时间升序；nodesOffline 是掉线机器数。
 *
 * 只报**能行动**的事：曲线在爬（多半是泄漏）、机器掉了。
 * 「中心刚重启过」不进红点——它值得知道，但不是需要你现在做点什么的事，
 * 那种事写在事件流里就够了。
 */
export function assessHub(samples: HubSample[], nodesOffline = 0): HubHealth {
  const reasons: string[] = []
  if (climbing(samples.map((s) => s.goroutines))) reasons.push('goroutineClimb')
  if (climbing(samples.map((s) => s.rss))) reasons.push('memClimb')
  // 泄漏是 bad：它不会自己好，而且撑到最后是整台机器被拖进换页颠簸（今早就是）
  if (reasons.length) return { level: 'bad', reasons }
  if (nodesOffline > 0) return { level: 'warn', reasons: ['nodeOffline'] }
  return { level: 'ok', reasons: [] }
}

// ── 全局订阅：侧栏那枚按钮要常驻显示健康，所以轮询放在这里，页面之外也在跑 ──────
//
// 60 秒一次：中心的采样本来就是 5 分钟一次，问得再勤也不会更新鲜；而这是每个页面
// 都在跑的后台请求，能省则省。单机（没连中心）时一次都不发。
let health: HubHealth = { level: 'ok', reasons: [] }
let started = false
const subs = new Set<() => void>()

function emit() { subs.forEach((f) => f()) }

async function poll() {
  if (!isHubMode()) return
  try {
    const r = await fetch('/api/hub/self', { cache: 'no-store' })
    if (!r.ok) return
    const d = (await r.json())?.data
    if (!d) return
    const offline = Math.max(0, (d.nodes || 0) - (d.nodesOnline || 0))
    const next = assessHub(d.samples || [], offline)
    if (next.level !== health.level || next.reasons.join() !== health.reasons.join()) {
      health = next
      emit()
    }
  } catch { /* 网络抖动：保持上一次结论，别闪成正常也别闪成告警 */ }
}

function ensure() {
  if (started) return
  started = true
  poll()
  setInterval(poll, 60000)
}

function subscribe(f: () => void) {
  ensure()
  subs.add(f)
  return () => { subs.delete(f) }
}

/** 中心健康。单机恒为 ok，界面上什么都不多画。 */
export function useHubHealth(): HubHealth {
  return useSyncExternalStore(subscribe, () => health, () => health)
}
