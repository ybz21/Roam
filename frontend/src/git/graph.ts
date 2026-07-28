// 提交树的泳道（lane）布局：把 git log 的线性序列 + parents 关系算成可画的连线段。
// 后端只保证 --date-order 的顺序，拓扑连线全在这里算，换搜索/过滤条件也不用后端配合。
//
// 每行拆成上下两个半格：上半格收「从上面下来的线」，下半格发「往下面父提交去的线」，
// 节点画在半格交界处。这样任意交叉/汇合都能用同一套规则画出来，不用维护跨行状态。

export interface RawRef { name: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash' | string }

export interface RawCommit {
  hash: string
  short: string
  parents: string[]
  subject: string
  author: string
  email: string
  date: string
  when: string
  refs: RawRef[]
}

export interface Segment { from: number; to: number; color: string }

export interface GraphRow {
  commit: RawCommit
  lane: number
  color: string
  top: Segment[]    // 上半格：上一行延续下来的线
  bottom: Segment[] // 下半格：往父提交去的线
  merge: boolean    // 多父 → 合并提交，节点画空心
}

export interface GraphLayout { rows: GraphRow[]; lanes: number }

// 泳道配色：中等饱和度 + 中等亮度，深色底(#0d1117)与浅色底(#ffffff)上都够清楚。
export const LANE_COLORS = [
  'hsl(212, 78%, 58%)',
  'hsl(150, 52%, 44%)',
  'hsl(280, 60%, 63%)',
  'hsl(32, 85%, 52%)',
  'hsl(348, 68%, 60%)',
  'hsl(190, 68%, 44%)',
  'hsl(258, 62%, 66%)',
  'hsl(88, 45%, 45%)',
]
export const laneColor = (i: number) => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]

export function layoutGraph(commits: RawCommit[]): GraphLayout {
  let lanes: (string | null)[] = [] // 每条泳道正在等待的提交 hash
  const rows: GraphRow[] = []
  let maxLanes = 1

  for (const commit of commits) {
    const before = lanes.slice()

    // 1) 本提交落在哪条道：优先接住正在等它的那条，否则占一个空位
    let lane = before.indexOf(commit.hash)
    if (lane < 0) {
      lane = before.indexOf(null)
      if (lane < 0) lane = before.length
    }

    // 2) 算出这一行之后的泳道状态：等待本提交的道全部释放（它们在这里汇合）
    const after = before.slice()
    for (let i = 0; i < after.length; i++) if (after[i] === commit.hash) after[i] = null
    while (after.length <= lane) after.push(null)

    // 3) 安排父提交：第一父继承本道；其余父找已有道汇合，找不到就开新道。
    //    parentLanes 要单独记——两个孩子共用一个父时，父那条道是「已存在」的，
    //    光看 before/after 差异会把第二个孩子连过去的那根线漏掉。
    const parentLanes: number[] = []
    for (let k = 0; k < commit.parents.length; k++) {
      const p = commit.parents[k]
      let idx = after.indexOf(p)
      if (idx < 0) {
        idx = k === 0 ? lane : after.indexOf(null)
        if (idx < 0 || after[idx] != null) {
          idx = after.indexOf(null)
          if (idx < 0) { idx = after.length; after.push(null) }
        }
        after[idx] = p
      }
      parentLanes.push(idx)
    }
    while (after.length && after[after.length - 1] == null) after.pop()

    // 4) 连线段
    const top: Segment[] = []
    for (let j = 0; j < before.length; j++) {
      const h = before[j]
      if (h == null) continue
      if (h === commit.hash) top.push({ from: j, to: lane, color: laneColor(j) })
      else top.push({ from: j, to: j, color: laneColor(j) })
    }
    const bottom: Segment[] = []
    const seen = new Set<string>()
    const addBottom = (from: number, to: number) => {
      const k = from + ':' + to
      if (seen.has(k)) return
      seen.add(k)
      bottom.push({ from, to, color: laneColor(to) })
    }
    for (let j = 0; j < after.length; j++) { // 与本提交无关、径直穿过这一行的道
      if (after[j] != null && before[j] === after[j]) addBottom(j, j)
    }
    for (const pl of parentLanes) addBottom(lane, pl) // 本提交发往每个父所在道

    rows.push({ commit, lane, color: laneColor(lane), top, bottom, merge: commit.parents.length > 1 })
    maxLanes = Math.max(maxLanes, before.length, after.length, lane + 1)
    lanes = after
  }

  return { rows, lanes: maxLanes }
}

// 相对时间：优先用浏览器本地化，拿不到就退回 git 给的英文相对时间。
export function relTime(iso: string, fallback: string, locale: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return fallback
  const diff = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(diff)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60], ['minute', 3600], ['hour', 86400], ['day', 604800], ['week', 2629800], ['month', 31557600],
  ]
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    let prev = 1
    for (const [unit, limit] of units) {
      if (abs < limit) return rtf.format(Math.round(diff / prev), unit)
      prev = limit
    }
    return rtf.format(Math.round(diff / 31557600), 'year')
  } catch {
    return fallback
  }
}

export function absTime(iso: string, locale: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}
