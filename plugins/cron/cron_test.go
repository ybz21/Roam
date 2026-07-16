package cron

import "testing"

func TestValidateAction(t *testing.T) {
	cases := []struct {
		job Job
		ok  bool
	}{
		{Job{Action: "notify", Title: "站会提醒"}, true},
		{Job{Action: "notify"}, false}, // 缺 title
		{Job{Action: "agent", Prompt: "跑一遍测试"}, true},
		{Job{Action: "agent"}, false}, // 缺 prompt
		{Job{Action: "send", Session: "dev", Text: "醒醒"}, true},
		{Job{Action: "send", Session: "dev"}, false}, // 缺 text
		{Job{Action: "send", Text: "醒醒"}, false},     // 缺 session
		{Job{Action: "bogus"}, false},                // 未知动作
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

func TestScheduleDesc(t *testing.T) {
	if got := scheduleDesc(Job{Every: "5m"}); got != "每隔 5m" {
		t.Errorf("scheduleDesc(every) = %q", got)
	}
	if got := scheduleDesc(Job{At: "09:30"}); got != "每天 09:30" {
		t.Errorf("scheduleDesc(at) = %q", got)
	}
}
