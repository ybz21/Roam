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
  /** 原因码 → 那条曲线这半小时从多少涨到了多少（报警文案里带出来，好核对） */
  span?: Record<string, { from: number; to: number }>
}

/** 连续爬多少个采样点才算数。5 分钟一采 → 6 点 ≈ 半小时，够长到排除抖动，短到还来得及救。 */
const RUN = 6

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/**
 * 一个序列是不是「在持续爬」。三个条件缺一不可：
 *
 *   ① 不许回落   —— 中途下降就不是泄漏，是波动
 *   ② 后半段的**中位数**至少是前半段的两倍 —— 涨幅得摊在窗口里
 *   ③ 末尾还在涨 —— 最后一点要高于后半段的头一点
 *
 * 为什么不是「单调 + 末点翻倍」（上一版就是这么写的）：那条规则把
 * **一条平线末尾跳一下**判成泄漏。中心上真实发生过：goroutine 稳在 19 好几个小时，
 * 我一登录变成 40 —— 前 5 点全相等（相等满足「不下降」），末点刚好 ≥ 2×19，于是红灯。
 * 而这既不是泄漏，也不是任何需要人动手的事。
 *
 * ②③ 一起还挡住了另一类：**跳上新台阶后稳住**（19,19,19,40,40,40，比如多接了一台机器
 * 或起了一条隧道）。中位数看得见台阶，但「末尾还在涨」不成立 —— 它已经稳了。
 * 真泄漏是不会停的，下一个采样点它自己会再触发。
 *
 * 事故当天那条曲线（1518 → 2667 → 7126 → … → 18298）三条全中。
 */
function climbing(series: number[]): boolean {
  if (series.length < RUN) return false
  const tail = series.slice(-RUN)
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] < tail[i - 1]) return false
  }
  const half = RUN / 2
  const early = median(tail.slice(0, half))
  const late = tail.slice(half)
  if (!(early > 0 && median(late) >= early * 2)) return false
  return late[late.length - 1] > late[0]
}

/** 报警里带上「从多少涨到多少」：一个能自己核对的数字，比一句形容词有用 */
function span(series: number[]): { from: number; to: number } {
  const tail = series.slice(-RUN)
  return { from: tail[0], to: tail[tail.length - 1] }
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
  const span_: Record<string, { from: number; to: number }> = {}
  const g = samples.map((s) => s.goroutines)
  const m = samples.map((s) => s.rss)
  if (climbing(g)) { reasons.push('goroutineClimb'); span_.goroutineClimb = span(g) }
  if (climbing(m)) { reasons.push('memClimb'); span_.memClimb = span(m) }
  // 泄漏是 bad：它不会自己好，而且撑到最后是整台机器被拖进换页颠簸（今早就是）
  if (reasons.length) return { level: 'bad', reasons, span: span_ }
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

/**
 * 报警的一句话。带上「从多少涨到多少」——只说「持续增长」的话，人第一反应是
 * 「真的吗」，然后得自己翻到中心页去看曲线；带上数字就地可核对。
 */
export function hubReasonText(h: HubHealth, t: (k: string, v?: Record<string, unknown>) => string): string {
  const code = h.reasons[0] || 'unknown'
  const s = h.span?.[code]
  if (!s) return t('hub.why.' + code)
  const fmt = (n: number) => (code === 'memClimb' ? `${Math.round(n / 1048576)}MB` : String(n))
  // 带数字那版是**另一个 key**（不在代码里拼括号）：标点属于文案，各语言不一样
  return t('hub.why.' + code + 'Span', { from: fmt(s.from), to: fmt(s.to) })
}

/** 中心健康。单机恒为 ok，界面上什么都不多画。 */
export function useHubHealth(): HubHealth {
  return useSyncExternalStore(subscribe, () => health, () => health)
}
