// 底部状态条的**纯逻辑**：阈值判等级、按宽度挑格、按单位格式化。
// 设计见 docs/design/web/20-status-bar/index.html（§08 静默与上色 / §09 折叠）。
//
// 全部是纯函数，没有 DOM、没有请求——因为这三件事都难在边界上：
// CPU 的 60s 滞后、告警格跳过丢弃顺序、临界宽度不许抖，靠单测钉住比靠肉眼看靠谱。

export type Severity = 'ok' | 'warn' | 'danger'
export type CellAlign = 'left' | 'right'
export type CellRender = 'text' | 'gauge' | 'dot' | 'progress'
/** 折叠档位：1 最晚被丢（永不丢），4 最先丢 */
export type CellTier = 1 | 2 | 3 | 4
export type CellUnit = 'percent' | 'bytes' | 'bytesPerSec' | 'celsius' | 'count' | 'text'

export type Thresholds = {
  warn?: number
  danger?: number
  /** 要求连续越线这么久才升级；0/缺省=立刻。降级永远是立刻的 */
  sustainSec?: number
  /** 值越小越糟（剩余空间那类）。缺省 false */
  invert?: boolean
}

export type StatusAction =
  | { kind: 'pluginView'; id: string }
  | { kind: 'route'; id: string }

/** 一格的**静态声明**：来自系统 provider 或插件 manifest，运行期不变 */
export type CellSpec = {
  /** 全局唯一：`<providerId>/<itemId>` */
  id: string
  provider: string
  /** 系统格占固定槽位、第一帧就有值；插件格落尾段、可装可卸 */
  kind: 'system' | 'plugin'
  /** 插件格：随二进制走的 builtin，还是用户装的第三方 */
  builtin?: boolean
  label: string
  align: CellAlign
  /** 段内从大到小排；同分按 id 字典序（稳定，不因装插件顺序抖动） */
  priority: number
  tier: CellTier
  render: CellRender
  /** icons.tsx 的导出名；不认识的名字忽略，不报错 */
  icon?: string
  unit?: CellUnit
  thresholds?: Thresholds
  onClick?: StatusAction
}

/** 一格的**当前值**：由 provider 每帧给出 */
export type CellValue = {
  value?: number
  /** 给了就直接用，不再按 unit 格式化 */
  text?: string
  /** 第二行/悬停里的补充，如「16 核 · 负载 5.3」 */
  detail?: string
  /** 取不到——整格不渲染，不画「—」占位（§12） */
  missing?: boolean
  /** 有这一格，但此刻的数字过期了——变暗置 `--`（§08 ④） */
  stale?: boolean
  /** 由 provider 直接给的等级（系统格用，如「离线」）；插件格一律由阈值判 */
  severity?: Severity
}

export type Cell = CellSpec & { val: CellValue; severity: Severity; width: number }

// ── 阈值 → 等级 ──────────────────────────────────────────────────────────

/** 不带滞后的瞬时判定 */
export function rawSeverity(value: number | undefined, thr?: Thresholds): Severity {
  if (value == null || !Number.isFinite(value) || !thr) return 'ok'
  const over = (limit?: number) =>
    limit != null && (thr.invert ? value <= limit : value >= limit)
  if (over(thr.danger)) return 'danger'
  if (over(thr.warn)) return 'warn'
  return 'ok'
}

/**
 * 滞后判定的跨帧记账。`shown` 是当前显示的等级，`raw`/`rawSince` 是「越到这一档
 * 有多久了」——显示还停在 ok 的时候，表已经在走了，两者不是一回事。
 */
export type SustainTracker = { shown: Severity; raw: Severity; rawSince: number }

/**
 * 带滞后的判定。**升级要熬满 sustainSec，降级立刻**。
 *
 * CPU 天天冲 100%——编译、build、agent 跑测试，都是正常干活。按瞬时值上色，
 * 这一格每分钟黄好几次，两天之内所有人都学会无视它，连带旁边那格真的内存告警
 * 也一起被无视。所以升级要熬；而降级不熬——已经不烧了就别再红着。
 */
export function trackSustain(
  prev: SustainTracker | undefined,
  raw: Severity,
  nowMs: number,
  sustainSec = 0,
): SustainTracker {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, danger: 2 }
  const shown = prev?.shown ?? 'ok'
  const rawSince = prev && prev.raw === raw ? prev.rawSince : nowMs
  if (rank[raw] <= rank[shown]) return { shown: raw, raw, rawSince }
  if (!sustainSec || nowMs - rawSince >= sustainSec * 1000) {
    return { shown: raw, raw, rawSince }
  }
  return { shown, raw, rawSince }
}

// ── 格式化 ───────────────────────────────────────────────────────────────

const UNITS = ['B', 'K', 'M', 'G', 'T']

export function humanBytes(n: number): string {
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return (v >= 100 || i === 0 ? Math.round(v) : Number(v.toFixed(1))) + UNITS[i]
}

export function formatValue(v: CellValue, unit?: CellUnit): string {
  if (v.text) return v.text
  if (v.stale || v.value == null || !Number.isFinite(v.value)) return '--'
  switch (unit) {
    case 'percent': return Math.round(v.value) + '%'
    case 'celsius': return Math.round(v.value) + '°C'
    case 'bytes': return humanBytes(v.value)
    case 'bytesPerSec': return humanBytes(v.value) + '/s'
    default: return String(Math.round(v.value))
  }
}

/**
 * 估算一格的像素宽度。**故意不量真实 DOM**：量→删→变宽→加回来会在临界宽度上
 * 抖成无限循环（§09）。估宽偏大几个像素无所谓，宁可早丢一格也不要抖。
 */
export function estimateWidth(spec: CellSpec, text: string): number {
  const chars = (s: string) => {
    let w = 0
    for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 12 : 7
    return w
  }
  // 26 = 左右 padding 18 + 子元素之间那两个 6px gap 的余量。
  // 实测（1440 桌面）估值比真实宽度大 5–15px：**宁可估大**。估小了那一格会被
  // overflow:hidden 裁掉半个字，而估大只是早丢一格。
  let w = 26
  if (spec.icon) w += 19
  if (spec.render === 'dot' || spec.render === 'progress') w += 17
  if (spec.render === 'gauge') w += 42 // 迷你条 30 + 两侧间距
  if (spec.label) w += chars(spec.label) + 6
  w += chars(text)
  return Math.ceil(w)
}

// ── 折叠 ─────────────────────────────────────────────────────────────────

/** 左右两半之间那根撑开的弹簧，至少留这么宽，否则两组会贴在一起 */
export const SPRING_MIN = 24

function ordered(cells: Cell[]): Cell[] {
  // 段内从大到小；同分按 id 字典序 —— 稳定排序，不因装插件的顺序抖动
  return [...cells].sort((a, b) =>
    a.align !== b.align ? (a.align === 'left' ? -1 : 1)
      : b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 按可用宽度挑出要渲染的格。
 *
 * 规则（§09）：
 * - 档位从 4 往 1 丢；**同档内右半先于左半**——右半描述「你在动的东西」，
 *   而那个东西本身就在屏幕正中央摆着；左半描述你看不见的东西。
 * - 档 1 永不丢。
 * - 任何 warn/danger 的格被**钉住**，跳过丢弃顺序；只有在它本来会被丢掉时
 *   才提前到左半第二位（宽屏里就地上色，不挪位——挪位会让格子在眼皮底下跑）。
 */
export function pickCells(cells: Cell[], availableWidth: number): Cell[] {
  const all = ordered(cells)
  const pinned = (c: Cell) => c.tier === 1 || c.severity !== 'ok'
  const total = (list: Cell[]) => list.reduce((s, c) => s + c.width, 0) + SPRING_MIN

  const keep = new Set(all.map((c) => c.id))
  const fits = () => total(all.filter((c) => keep.has(c.id))) <= availableWidth

  // 丢弃顺序：档位大的先丢；同档右半先于左半；同半从右往左（即 priority 小的先丢）
  const droppable = all
    .filter((c) => !pinned(c))
    .sort((a, b) =>
      b.tier - a.tier ||
      (a.align !== b.align ? (a.align === 'right' ? -1 : 1) : 0) ||
      a.priority - b.priority ||
      (a.id < b.id ? -1 : 1))

  for (const c of droppable) {
    if (fits()) break
    keep.delete(c.id)
  }

  const visible = all.filter((c) => keep.has(c.id))
  // 有格子被丢掉，说明位置紧张：把上色的格提到左半第二位（机器格右边）
  const dropped = visible.length < all.length
  if (!dropped) return visible
  const hoist = visible.filter((c) => c.severity !== 'ok' && c.align === 'left')
  if (!hoist.length) return visible
  const rest = visible.filter((c) => !hoist.includes(c))
  const head = rest.slice(0, 1)
  return [...head, ...hoist, ...rest.slice(1)]
}
