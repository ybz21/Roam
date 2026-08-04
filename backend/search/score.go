// Package search 是全局搜索的内核：模糊打分（score.go）与项目文件名索引（index.go）。
//
// 打分照 fzf 的思路做了一版小的：**子序列匹配 + 位置奖励 + 间隔惩罚**。纯子串包含
// 不够用——`ovw` 要能命中 `Overview.tsx`、`src/ap.go` 要能命中 `backend/api/api.go`；
// 而纯子序列又会把 `a...b...c` 这种跨半个路径的巧合排到真正的词首命中前面，所以
// 命中在词首（`/ _ - . 空格`之后）、驼峰拐点、连续命中都要加分，中间跳过的字符要
// 扣分。返回命中位置是为了让 UI 把匹配的字符加粗——搜索结果不标出「为什么它匹配」，
// 用户就只能靠猜。
package search

import (
	"sort"
	"strings"
	"unicode"
)

const (
	scoreMatch       = 16 // 每命中一个字符的底分
	bonusBoundary    = 14 // 词首：分隔符之后（路径段开头、下划线/连字符后）
	bonusCamel       = 10 // 驼峰拐点 aB、字母后接数字
	bonusConsecutive = 12 // 与上一个命中字符相邻
	bonusFirstChar   = 12 // 整串的第一个字符就命中
	penaltyGapStart  = 3  // 跳过一段的起步惩罚
	penaltyGapExtend = 1  // 跳过的每个额外字符
	penaltyLateStart = 12 // 首个命中离串首越远越弱，封顶这个数

	// maxTargetRunes 单个目标参与打分的长度上限。路径再长也只看前 256 个字符：
	// DP 是 O(词长 × 目标长)，不封顶的话一条超长路径就能把一次搜索拖慢一个量级。
	maxTargetRunes = 256

	negInf = -1 << 30
)

// Match 是一次匹配的结果。Positions 是命中字符在**原始目标串**上的 rune 下标（升序），
// 给 UI 高亮用；多词查询时是各词命中位置的并集。
type Match struct {
	Score     int   `json:"score"`
	Positions []int `json:"positions,omitempty"`
}

// Query 是编译好的查询：按空白切成若干词，每个词预先转成小写 rune。
// 一次搜索要拿同一个查询去打几万个候选，切词和转 rune 只该做一次。
type Query struct {
	terms [][]rune
}

// Compile 把查询串编译成 Query。多个词是 AND 关系——「api search」要求两个词都命中。
func Compile(query string) Query {
	fields := strings.Fields(strings.ToLower(query))
	terms := make([][]rune, 0, len(fields))
	for _, f := range fields {
		terms = append(terms, []rune(f))
	}
	return Query{terms: terms}
}

// Empty 报告查询是否为空（空查询一律不匹配，由调用方决定要不要给「全部」）。
func (q Query) Empty() bool { return len(q.terms) == 0 }

// CouldMatch 是廉价预筛：只做「每个词都是目标的子序列」的判断，不进 DP、不分配。
// 打几万个候选时先过这一关，真正进 DP 的通常只剩百分之几。
func (q Query) CouldMatch(target string) bool {
	if len(q.terms) == 0 {
		return false
	}
	for _, term := range q.terms {
		i := 0
		for _, r := range target {
			if unicode.ToLower(r) == term[i] {
				i++
				if i == len(term) {
					break
				}
			}
		}
		if i < len(term) {
			return false
		}
	}
	return true
}

// Score 给 query 对 target 的匹配打分。query 按空白切词做 AND：每个词都要命中，
// 总分相加——这样「roam 概览」「api search」这种两段式查询才有意义。
// 不匹配返回 ok=false（0 分和「勉强匹配」要能区分开）。
func Score(query, target string) (Match, bool) { return Compile(query).Score(target) }

// Score 用已编译的查询打分，语义同包级 Score。
func (q Query) Score(target string) (Match, bool) {
	if len(q.terms) == 0 || target == "" {
		return Match{}, false
	}
	// 先做零分配的预筛。一次搜索要打几十万个候选，其中 99% 连子序列都不是；
	// 不先挡一道的话，光是「转 rune + 算位置奖励」两次分配就够把延迟拖到半秒。
	if !q.CouldMatch(target) {
		return Match{}, false
	}
	runes := []rune(target)
	if len(runes) > maxTargetRunes {
		runes = runes[:maxTargetRunes]
	}
	lower := make([]rune, len(runes))
	for i, r := range runes {
		lower[i] = unicode.ToLower(r)
	}
	bonus := boundaryBonuses(runes)

	total := 0
	hit := map[int]bool{}
	for _, term := range q.terms {
		s, pos, ok := scoreTerm(term, lower, bonus)
		if !ok {
			return Match{}, false
		}
		total += s
		for _, p := range pos {
			hit[p] = true
		}
	}
	positions := make([]int, 0, len(hit))
	for p := range hit {
		positions = append(positions, p)
	}
	sort.Ints(positions)
	return Match{Score: total, Positions: positions}, true
}

// Best 在多个字段里取最高分，返回命中的字段下标。副字段（下标 > 0）打折：
// 名字命中永远比路径命中更相关，不打折的话搜 `api` 会让一堆路径里带 api 的文件
// 压过真叫 api 的那个。
func Best(query string, fields ...string) (Match, int, bool) {
	return Compile(query).Best(fields...)
}

// Best 用已编译的查询在多个字段里取最高分，语义同包级 Best。
func (q Query) Best(fields ...string) (Match, int, bool) {
	best, bestIdx, found := Match{}, -1, false
	for i, f := range fields {
		m, ok := q.Score(f)
		if !ok {
			continue
		}
		if i > 0 {
			m.Score = m.Score * 3 / 4
		}
		if !found || m.Score > best.Score {
			best, bestIdx, found = m, i, true
		}
	}
	return best, bestIdx, found
}

// boundaryBonuses 预先算好每个位置的「位置奖励」：整串开头、分隔符之后、驼峰拐点。
func boundaryBonuses(t []rune) []int {
	b := make([]int, len(t))
	for i, r := range t {
		if i == 0 {
			b[i] = bonusBoundary
			continue
		}
		p := t[i-1]
		switch {
		case isSep(p):
			b[i] = bonusBoundary
		case unicode.IsLower(p) && unicode.IsUpper(r):
			b[i] = bonusCamel
		case unicode.IsDigit(r) && !unicode.IsDigit(p):
			b[i] = bonusCamel
		}
	}
	return b
}

func isSep(r rune) bool {
	switch r {
	case '/', '\\', '_', '-', '.', ' ', ':', '@', '(', '[':
		return true
	}
	return false
}

// scoreTerm 是单个词的 DP：cur[j] = 「词的第 i 个字符落在目标第 j 位」时的最高分。
// 前驱只有两种来源——紧邻的上一位（连续，加奖励）或更早的位置（跳过，按间隔扣分），
// 后者用一个随 j 衰减的滑动最大值维护，整体 O(词长 × 目标长)。
func scoreTerm(q, tLower []rune, bonus []int) (int, []int, bool) {
	n, m := len(tLower), len(q)
	if m == 0 || m > n {
		return 0, nil, false
	}
	if !isSubsequence(q, tLower) {
		return 0, nil, false // 连子序列都不是，不必进 DP
	}

	back := make([][]int32, m) // back[i][j] = 第 i-1 个字符落在哪一位，回溯高亮位置用
	prev := make([]int, n)
	cur := make([]int, n)

	for i := 0; i < m; i++ {
		back[i] = make([]int32, n)
		gap, gapIdx := negInf, -1 // 「跳过一段后接上」的最优前驱
		for j := 0; j < n; j++ {
			// 位置 j 的间隔候选只能来自 k <= j-2（k = j-1 属于连续那一支）
			if i > 0 && j >= 2 {
				if gap != negInf {
					gap -= penaltyGapExtend
				}
				if prev[j-2] > negInf/2 && prev[j-2]-penaltyGapStart > gap {
					gap, gapIdx = prev[j-2]-penaltyGapStart, j-2
				}
			}
			cur[j] = negInf
			back[i][j] = -1
			if q[i] != tLower[j] {
				continue
			}
			if i == 0 {
				s := scoreMatch + bonus[j]
				if j == 0 {
					s += bonusFirstChar
				}
				if j < penaltyLateStart {
					s -= j
				} else {
					s -= penaltyLateStart
				}
				cur[j] = s
				continue
			}
			best, bestIdx := negInf, -1
			if j > 0 && prev[j-1] > negInf/2 {
				best, bestIdx = prev[j-1]+bonusConsecutive, j-1
			}
			if gapIdx >= 0 && gap > best {
				best, bestIdx = gap, gapIdx
			}
			if bestIdx < 0 {
				continue
			}
			cur[j] = best + scoreMatch + bonus[j]
			back[i][j] = int32(bestIdx)
		}
		prev, cur = cur, prev
	}

	bestScore, bestEnd := negInf, -1
	for j := 0; j < n; j++ {
		if prev[j] > bestScore {
			bestScore, bestEnd = prev[j], j
		}
	}
	if bestEnd < 0 || bestScore <= negInf/2 {
		return 0, nil, false
	}
	pos := make([]int, m)
	j := bestEnd
	for i := m - 1; i >= 0; i-- {
		pos[i] = j
		j = int(back[i][j])
	}
	return bestScore, pos, true
}

func isSubsequence(q, t []rune) bool {
	i := 0
	for _, r := range t {
		if r == q[i] {
			i++
			if i == len(q) {
				return true
			}
		}
	}
	return false
}
