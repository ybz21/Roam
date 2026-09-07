package cron

import "testing"

func TestValidateAction(t *testing.T) {
	cases := []struct {
		job Job
		ok  bool
	}{
		{Job{Action: "agent", Prompt: "跑一遍测试"}, true},
		{Job{Action: "agent"}, false}, // 缺 prompt
		{Job{Action: "exec", Command: "npm test"}, true},
		{Job{Action: "exec"}, false},                // 缺 command
		{Job{Action: "exec", Command: "  "}, false}, // 空白 command
		{Job{Action: "notify"}, false},              // notify 动作已移除,视为未知
		{Job{Action: "send"}, false},                // send 动作已移除,视为未知
		{Job{Action: "bogus"}, false},               // 未知动作
	}
	for i, c := range cases {
		err := validateAction(c.job)
		if c.ok && err != nil {
			t.Errorf("case %d 应通过,却报错: %v", i, err)
		}
		if !c.ok && err == nil {
			t.Errorf("case %d 应报错,却通过", i)
		}
	}
}

// jobView 必须回带原始可编辑字段——设置页的「编辑」表单靠它回填,少一个
// 用户就得从头填一遍(尤其 cron / prompt / interactive)。
func TestJobViewCarriesEditableFields(t *testing.T) {
	j := Job{
		Name: "nightly", Cron: "0 9 */3 * *", Action: "agent", Enabled: true,
		Provider: "claude", Prompt: "跑测试并总结", Workdir: "/repo", Interactive: true,
	}
	v := jobView(j)
	for k, want := range map[string]any{
		"name": "nightly", "cron": "0 9 */3 * *", "schedule": "0 9 */3 * *",
		"action": "agent", "provider": "claude", "prompt": "跑测试并总结",
		"workdir": "/repo", "interactive": true, "enabled": true,
	} {
		if v[k] != want {
			t.Errorf("jobView[%q] = %v(%T), want %v", k, v[k], v[k], want)
		}
	}
	// exec 的字段键即使当前动作用不到也应存在(前端按 action 取用,不能缺键)
	if _, ok := v["command"]; !ok {
		t.Errorf("jobView 缺少键 command(前端回填会拿到 undefined)")
	}
}

func TestTailStr(t *testing.T) {
	if got := tailStr("short", 100); got != "short" {
		t.Errorf("不超长应原样返回, got %q", got)
	}
	if got := tailStr("abcdefghij", 4); got != "…ghij" {
		t.Errorf("超长应取末尾 4 字节并加省略号, got %q", got)
	}
}

// 执行记录是整表读写的，必须自己封顶：一条每 15 分钟跑的任务，一个月就是 2880 条。
func TestTrimRuns(t *testing.T) {
	var runs []Run
	for i := 0; i < maxRunsPerJob+10; i++ {
		runs = append(runs, Run{Name: "a", At: int64(i)})
	}
	runs = append(runs, Run{Name: "b", At: 1})
	kept := trimRuns(runs)

	countA := 0
	for _, r := range kept {
		if r.Name == "a" {
			countA++
		}
	}
	if countA != maxRunsPerJob {
		t.Errorf("任务 a 留了 %d 条，想要 %d", countA, maxRunsPerJob)
	}
	// 另一个任务不该被挤掉：上限是「每任务」，不是先来后到
	if len(kept) != maxRunsPerJob+1 {
		t.Errorf("总共留了 %d 条，想要 %d", len(kept), maxRunsPerJob+1)
	}
	// 新的在前：裁掉的必须是尾巴上那些旧的
	if kept[0].At != 0 {
		t.Errorf("头一条 at=%d，顺序被动过了", kept[0].At)
	}
}

func TestWithoutJob(t *testing.T) {
	runs := []Run{{Name: "a"}, {Name: "b"}, {Name: "a"}}
	got := withoutJob(runs, "a")
	if len(got) != 1 || got[0].Name != "b" {
		t.Errorf("删完剩 %+v，想要只剩 b", got)
	}
}
