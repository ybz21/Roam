// 模糊打分：**子序列匹配 + 位置奖励 + 间隔惩罚**（backend/search/score.go 的等价实现）。
//
// 为什么前端也要有一份：结果分两路来（本地内存里的页面/已开会话，后端来的项目/
// 会话/文件），两路必须用同一套规则打分，否则合并后的排序自相矛盾——同样叫
// `overview` 的两条，一条排第一、一条排第七。
//
// 改这里就要同步改 Go 那份，两边的用例钉在 score.test.ts 与 score_test.go。
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 14 // 词首：分隔符之后
const BONUS_CAMEL = 10 // 驼峰拐点、字母后接数字
const BONUS_CONSECUTIVE = 12 // 与上一个命中字符相邻
const BONUS_FIRST_CHAR = 12 // 整串第一个字符就命中
const PENALTY_GAP_START = 3 // 跳过一段的起步惩罚
const PENALTY_GAP_EXTEND = 1 // 跳过的每个额外字符
const PENALTY_LATE_START = 12 // 首个命中离串首越远越弱，封顶
const MAX_TARGET = 256 // 单个目标参与打分的长度上限
const NEG = -1e9

export type ScoreResult = { score: number; positions: number[] }

const SEP = new Set(['/', '\\', '_', '-', '.', ' ', ':', '@', '(', '['])
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase()
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase()
const isDigit = (c: string) => c >= '0' && c <= '9'

function boundaryBonuses(t: string[]): number[] {
  return t.map((c, i) => {
    if (i === 0) return BONUS_BOUNDARY
    const p = t[i - 1]
    if (SEP.has(p)) return BONUS_BOUNDARY
    if (isLower(p) && isUpper(c)) return BONUS_CAMEL
    if (isDigit(c) && !isDigit(p)) return BONUS_CAMEL
    return 0
  })
}

/**
 * 单个词的 DP：cur[j] = 「词的第 i 个字符落在目标第 j 位」时的最高分。
 * 前驱只有两种来源——紧邻的上一位（连续，加奖励）或更早的位置（跳过，按间隔扣分），
 * 后者用一个随 j 衰减的滑动最大值维护，整体 O(词长 × 目标长)。
 */
function scoreTerm(q: string[], tLower: string[], bonus: number[]): ScoreResult | null {
  const n = tLower.length, m = q.length
  if (m === 0 || m > n) return null
  const back: Int32Array[] = []
  let prev = new Float64Array(n).fill(NEG)
  let cur = new Float64Array(n).fill(NEG)
  for (let i = 0; i < m; i++) {
    const row = new Int32Array(n).fill(-1)
    back.push(row)
    let gap = NEG, gapIdx = -1
    for (let j = 0; j < n; j++) {
      // 位置 j 的「间隔候选」只能来自 k <= j-2（k = j-1 属于连续那一支）
      if (i > 0 && j >= 2) {
        if (gap > NEG) gap -= PENALTY_GAP_EXTEND
        if (prev[j - 2] > NEG / 2 && prev[j - 2] - PENALTY_GAP_START > gap) {
          gap = prev[j - 2] - PENALTY_GAP_START
          gapIdx = j - 2
        }
      }
      cur[j] = NEG
      if (q[i] !== tLower[j]) continue
      if (i === 0) {
        let s = SCORE_MATCH + bonus[j]
        if (j === 0) s += BONUS_FIRST_CHAR
        s -= Math.min(j, PENALTY_LATE_START)
        cur[j] = s
        continue
      }
      let best = NEG, bestIdx = -1
      if (j > 0 && prev[j - 1] > NEG / 2) { best = prev[j - 1] + BONUS_CONSECUTIVE; bestIdx = j - 1 }
      if (gapIdx >= 0 && gap > best) { best = gap; bestIdx = gapIdx }
      if (bestIdx < 0) continue
      cur[j] = best + SCORE_MATCH + bonus[j]
      row[j] = bestIdx
    }
    const swap = prev; prev = cur; cur = swap
  }
  let bestScore = NEG, bestEnd = -1
  for (let j = 0; j < n; j++) if (prev[j] > bestScore) { bestScore = prev[j]; bestEnd = j }
  if (bestEnd < 0 || bestScore <= NEG / 2) return null
  const positions = new Array<number>(m)
  let j = bestEnd
  for (let i = m - 1; i >= 0; i--) { positions[i] = j; j = back[i][j] }
  return { score: bestScore, positions }
}

/** 模糊打分：查询按空白切词做 AND，返回总分与命中位置（不匹配返回 null） */
export function fuzzyScore(query: string, target: string): ScoreResult | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length || !target) return null
  const t = Array.from(target).slice(0, MAX_TARGET)
  const lower = t.map((c) => c.toLowerCase())
  const bonus = boundaryBonuses(t)
  let total = 0
  const hit = new Set<number>()
  for (const term of terms) {
    const r = scoreTerm(Array.from(term), lower, bonus)
    if (!r) return null
    total += r.score
    r.positions.forEach((p) => hit.add(p))
  }
  return { score: total, positions: [...hit].sort((a, b) => a - b) }
}

/**
 * 多字段取最高分；副字段（下标 > 0）打 75 折——名字命中永远比路径命中更相关，
 * 不打折的话搜 `api` 会让一堆路径里带 api 的文件压过真叫 api 的那个。
 * 位置只在主字段命中时给：在标题上标出根本没匹配的字符比不标更糊涂。
 */
export function fuzzyBest(query: string, fields: string[]): { score: number; positions?: number[] } | null {
  let best: { score: number; positions?: number[] } | null = null
  fields.forEach((f, i) => {
    const r = fuzzyScore(query, f)
    if (!r) return
    const score = i === 0 ? r.score : Math.floor((r.score * 3) / 4)
    if (!best || score > best.score) best = { score, positions: i === 0 ? r.positions : undefined }
  })
  return best
}
