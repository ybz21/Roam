package search

import (
	"context"
	"testing"
)

func docSource(kind string, max int, docs ...Doc) Source {
	return FuncSource{KindName: kind, Max: max, List: func(context.Context) []Doc { return docs }}
}

func TestRunMatchesAcrossSources(t *testing.T) {
	res := Run(context.Background(), "cron", []Source{
		docSource("project", 5, Doc{ID: "p1", Title: "roam"}),
		docSource("plugin", 5, Doc{ID: "roam.cron", Title: "定时任务", Aliases: []string{"roam.cron", "cron"}}),
	}, 10)
	if len(res.Hits) != 1 {
		t.Fatalf("应只命中插件那条，得到 %+v", res.Hits)
	}
	if res.Hits[0].Kind != "plugin" || res.Hits[0].ID != "roam.cron" {
		t.Fatalf("命中的不是插件：%+v", res.Hits[0])
	}
}

// 用户搜「定时」要能找到「定时任务」插件——中文显示名是 Title，不是别名
func TestRunMatchesChineseTitle(t *testing.T) {
	res := Run(context.Background(), "定时", []Source{
		docSource("plugin", 5, Doc{ID: "roam.cron", Title: "定时任务", Subtitle: "按间隔或每天定点触发"}),
	}, 10)
	if len(res.Hits) != 1 || len(res.Hits[0].Positions) == 0 {
		t.Fatalf("中文标题命中应有高亮位置：%+v", res.Hits)
	}
}

func TestRunPositionsOnlyForTitle(t *testing.T) {
	res := Run(context.Background(), "zzz", []Source{
		docSource("session", 5, Doc{ID: "s1", Title: "会话", Aliases: []string{"zzz-session"}}),
	}, 10)
	if len(res.Hits) != 1 {
		t.Fatalf("别名命中应算命中：%+v", res.Hits)
	}
	if len(res.Hits[0].Positions) != 0 {
		t.Fatalf("命中在别名上时不该给标题高亮位置：%+v", res.Hits[0])
	}
}

func TestRunPerSourceLimit(t *testing.T) {
	docs := []Doc{}
	for _, n := range []string{"api.go", "api2.go", "api3.go", "api4.go"} {
		docs = append(docs, Doc{ID: n, Title: n})
	}
	res := Run(context.Background(), "api", []Source{docSource("file", 2, docs...)}, 10)
	if len(res.Hits) != 2 {
		t.Fatalf("每类应按 Limit 截断，得到 %d", len(res.Hits))
	}
	if !res.Truncated {
		t.Fatal("截断了就要如实标记")
	}
}

func TestRunTotalLimitAndOrder(t *testing.T) {
	res := Run(context.Background(), "api", []Source{
		docSource("file", 9, Doc{ID: "a", Title: "notes-api-old.md"}),
		docSource("project", 9, Doc{ID: "b", Title: "api"}),
	}, 10)
	if len(res.Hits) != 2 {
		t.Fatalf("应有两条：%+v", res.Hits)
	}
	if res.Hits[0].ID != "b" {
		t.Fatalf("整串完全命中的应排最前：%+v", res.Hits)
	}
}

func TestRunCarriesAction(t *testing.T) {
	want := Action{Type: "route", Target: "#/plugins"}
	res := Run(context.Background(), "cron", []Source{
		docSource("plugin", 5, Doc{ID: "roam.cron", Title: "cron", Action: want}),
	}, 10)
	if len(res.Hits) != 1 || res.Hits[0].Action != want {
		t.Fatalf("动作要原样带给前端：%+v", res.Hits)
	}
}

func TestRunEmptyQuery(t *testing.T) {
	res := Run(context.Background(), "   ", []Source{docSource("project", 5, Doc{ID: "p", Title: "roam"})}, 10)
	if len(res.Hits) != 0 {
		t.Fatalf("空查询不该有结果：%+v", res.Hits)
	}
}

// 文件源那类要走一遍才知道自己齐不齐，所以 Ready 必须在 Each 之后问
type lateReadySource struct{ ran bool }

func (s *lateReadySource) Kind() string { return "file" }
func (s *lateReadySource) Limit() int   { return 5 }
func (s *lateReadySource) Ready() bool  { return s.ran }
func (s *lateReadySource) Each(_ context.Context, emit func(Doc) bool) {
	s.ran = true
	emit(Doc{ID: "a", Title: "api.go"})
}

func TestRunAsksReadyAfterEach(t *testing.T) {
	res := Run(context.Background(), "api", []Source{&lateReadySource{}}, 10)
	if res.Indexing {
		t.Fatal("源在 Each 里已经就绪，不该报「还在建索引」")
	}
	if len(res.Hits) != 1 {
		t.Fatalf("结果丢了：%+v", res.Hits)
	}
}
