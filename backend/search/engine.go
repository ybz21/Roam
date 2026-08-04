package search

import (
	"context"
	"sort"
)

// 搜索引擎的骨架：**数据源（Source）→ 打分 → 排序**，三步都不认识具体业务。
//
// 第一版把项目/会话/文件三类写死在 handler 里，于是「插件也想能搜」就得再改一遍
// handler、再改一遍前端的 switch。现在换成注册制：任何模块只要能把自己描述成
// Doc（标题 + 副标题 + 一个「点开要干什么」的 Action），就自动可搜，前端一行不用改。
//
// 配套的两条约束让这件事成立：
//   · 排序规则在引擎里，不在数据源里——各源自己排会互相打架；
//   · 「点开做什么」由 Action 表达（route / session / file 三种），
//     前端只认这三种动作，不认它背后是项目还是插件。

// Action 告诉前端点开一条结果要做什么。
type Action struct {
	// Type: route（切页面 / 深链）| session（打开终端）| file（打开文件）
	Type string `json:"type"`
	// Target: route → hash 路由（如 `#/projects/xxx`）；session → 会话名；file → 绝对路径
	Target string `json:"target"`
}

// Doc 是一个可被搜到的东西。Title 是主字段（命中打满分并高亮），
// Subtitle 与 Aliases 是副字段（命中打折，不高亮）。
type Doc struct {
	ID       string
	Title    string
	Subtitle string
	Path     string
	Project  string
	ProjKey  string
	// Aliases 参与匹配但不显示：会话 id、插件 id、英文名、所属项目名…
	Aliases []string
	Action  Action
	// Boost 额外加分：用来表达「这条更贴近你现在在做的事」（如当前项目下的文件），
	// 与「名字有多像」是两件事，所以分开给。
	Boost int
}

// Source 是一类可搜的东西（项目 / 会话 / 项目文件 / 插件 / 蜂群…）。
//
// Each 是推的不是拉的：文件源一次要吐几万条，先攒成切片再返回等于每次按键多分配
// 几 MB。emit 返回 false 表示引擎不要了（够了/超时），源应当立刻停下。
type Source interface {
	Kind() string
	// Limit 本类最多进多少条结果——各类都要露脸，文件不能把项目和会话挤出视野
	Limit() int
	Each(ctx context.Context, emit func(Doc) bool)
	// Ready 报告这一路数据是否就绪（如文件索引还在后台建）。前端据此提示一句。
	// **引擎在 Each 之后才问**：源往往要走一遍才知道自己齐不齐。
	Ready() bool
}

// Hit 是一条结果。JSON 形状与前端 SearchHit 一一对应。
type Hit struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Title      string `json:"title"`
	Subtitle   string `json:"subtitle,omitempty"`
	Path       string `json:"path,omitempty"`
	Project    string `json:"project,omitempty"`
	ProjectKey string `json:"projectKey,omitempty"`
	Action     Action `json:"action"`
	Score      int    `json:"score"`
	// Positions 是命中字符在 Title 上的下标，供高亮；命中发生在副字段时不给——
	// 在标题上标出根本没匹配的字符比不标更糊涂。
	Positions []int `json:"positions,omitempty"`
}

// Result 是一次搜索的全部产出。
type Result struct {
	Hits []Hit
	// Truncated 结果被某处上限截断了（条数 / 索引没走完）
	Truncated bool
	// Indexing 有数据源还没就绪（文件索引在后台建），这一批可能不全
	Indexing bool
}

// Run 拿一个查询过一遍所有数据源。各源内部按分数取前 Limit() 条，再统一排序、
// 按 total 截断。
func Run(ctx context.Context, query string, sources []Source, total int) Result {
	q := Compile(query)
	res := Result{Hits: []Hit{}}
	if q.Empty() {
		return res
	}
	if total <= 0 {
		total = 40
	}
	for _, src := range sources {
		if ctx.Err() != nil {
			res.Truncated = true
			break
		}
		kind := src.Kind()
		var hits []Hit
		src.Each(ctx, func(d Doc) bool {
			if ctx.Err() != nil {
				res.Truncated = true
				return false
			}
			m, primary, ok := scoreDoc(q, d)
			if !ok {
				return true
			}
			h := Hit{
				Kind: kind, ID: d.ID, Title: d.Title, Subtitle: d.Subtitle, Path: d.Path,
				Project: d.Project, ProjectKey: d.ProjKey, Action: d.Action, Score: m.Score + d.Boost,
			}
			if primary {
				h.Positions = m.Positions
			}
			hits = append(hits, h)
			return true
		})
		// Ready 在 Each 之后问：文件源要走一遍才知道各个根建好了没有，
		// 先问必然拿到零值（这条踩过一次——面板一直挂着「正在建索引」）。
		if !src.Ready() {
			res.Indexing = true
		}
		sortHits(hits)
		if lim := src.Limit(); lim > 0 && len(hits) > lim {
			hits = hits[:lim]
			res.Truncated = true
		}
		res.Hits = append(res.Hits, hits...)
	}
	sortHits(res.Hits)
	if len(res.Hits) > total {
		res.Hits = res.Hits[:total]
		res.Truncated = true
	}
	return res
}

// scoreDoc 主字段（Title）优先，副字段（Subtitle / Aliases）打折，见 Query.Best。
func scoreDoc(q Query, d Doc) (Match, bool, bool) {
	fields := make([]string, 0, 2+len(d.Aliases))
	fields = append(fields, d.Title, d.Subtitle)
	fields = append(fields, d.Aliases...)
	m, idx, ok := q.Best(fields...)
	return m, idx == 0, ok
}

// sortHits 分数高的在前；同分时短标题在前（`api.go` 该排在 `apiClient.go` 前）。
func sortHits(h []Hit) {
	sort.SliceStable(h, func(i, j int) bool {
		if h[i].Score != h[j].Score {
			return h[i].Score > h[j].Score
		}
		if len(h[i].Title) != len(h[j].Title) {
			return len(h[i].Title) < len(h[j].Title)
		}
		return h[i].Title < h[j].Title
	})
}

// FuncSource 是最省事的一种源：给一个「列出候选」的函数就行（项目、插件、蜂群
// 这类几十条的列表都用它）。文件那种要边走边吐的，自己实现 Source。
type FuncSource struct {
	KindName string
	Max      int
	List     func(ctx context.Context) []Doc
}

func (s FuncSource) Kind() string { return s.KindName }
func (s FuncSource) Limit() int   { return s.Max }
func (s FuncSource) Ready() bool  { return true }
func (s FuncSource) Each(ctx context.Context, emit func(Doc) bool) {
	if s.List == nil {
		return
	}
	for _, d := range s.List(ctx) {
		if !emit(d) {
			return
		}
	}
}
