package cron

import (
	"testing"
	"time"
)

func TestValidateSchedule(t *testing.T) {
	cases := []struct {
		every, at string
		ok        bool
	}{
		{"5m", "", true},
		{"30s", "", true},
		{"", "09:30", true},
		{"", "23:59", true},
		{"5m", "09:30", false}, // 两个都给
		{"", "", false},        // 都不给
		{"3s", "", false},      // 小于最小间隔
		{"abc", "", false},     // 非法 duration
		{"", "24:00", false},   // 小时越界
		{"", "9:99", false},    // 分钟越界
		{"", "0930", false},    // 缺冒号
	}
	for _, c := range cases {
		err := validateSchedule(c.every, c.at)
		if c.ok && err != nil {
			t.Errorf("validateSchedule(%q,%q) 应通过,却报错: %v", c.every, c.at, err)
		}
		if !c.ok && err == nil {
			t.Errorf("validateSchedule(%q,%q) 应报错,却通过", c.every, c.at)
		}
	}
}

func TestNextAfterInterval(t *testing.T) {
	from := time.Date(2026, 7, 16, 10, 0, 0, 0, time.Local)
	next, err := nextAfter(Job{Every: "5m"}, from)
	if err != nil {
		t.Fatal(err)
	}
	if want := from.Add(5 * time.Minute); !next.Equal(want) {
		t.Errorf("间隔型下次触发 = %v,想要 %v", next, want)
	}
}

func TestNextAfterDaily(t *testing.T) {
	// 当天时刻已过 → 顺延到明天
	from := time.Date(2026, 7, 16, 10, 0, 0, 0, time.Local)
	next, err := nextAfter(Job{At: "09:30"}, from)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 7, 17, 9, 30, 0, 0, time.Local)
	if !next.Equal(want) {
		t.Errorf("每日型(已过)下次触发 = %v,想要 %v", next, want)
	}

	// 当天时刻未到 → 就在今天
	next2, err := nextAfter(Job{At: "15:30"}, from)
	if err != nil {
		t.Fatal(err)
	}
	want2 := time.Date(2026, 7, 16, 15, 30, 0, 0, time.Local)
	if !next2.Equal(want2) {
		t.Errorf("每日型(未到)下次触发 = %v,想要 %v", next2, want2)
	}
}

func TestAdvancePastCatchesUp(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.Local)
	// 排期停在 30 分钟前,间隔 5m:应快进到 now 之后的第一个整点,而不是补跑 6 次
	j := Job{Every: "5m", NextRun: now.Add(-30 * time.Minute).Unix()}
	next, err := advancePast(j, now)
	if err != nil {
		t.Fatal(err)
	}
	if !next.After(now) {
		t.Errorf("advancePast 应快进到 now 之后,得到 %v", next)
	}
	if d := next.Sub(now); d <= 0 || d > 5*time.Minute {
		t.Errorf("快进后应落在下一个 <=5m 的间隔点内,得到间隔 %v", d)
	}
}

func TestAdvancePastFreshInterval(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.Local)
	j := Job{Every: "1h", NextRun: 0}
	next, err := advancePast(j, now)
	if err != nil {
		t.Fatal(err)
	}
	if want := now.Add(time.Hour); !next.Equal(want) {
		t.Errorf("首次排期应为 now+1h = %v,得到 %v", want, next)
	}
}
