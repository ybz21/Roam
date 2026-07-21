package cron

import (
	"testing"
	"time"
)

func TestParseCronValid(t *testing.T) {
	valid := []string{
		"* * * * *",
		"*/5 * * * *",
		"30 9 * * *",
		"0 9 */3 * *",
		"0 18 * * 1-5",
		"0 0 1,15 * *",
		"15,45 8-18 * * 0,6",
		"0 0 * * 7", // 7=周日
	}
	for _, e := range valid {
		if err := validateCron(e); err != nil {
			t.Errorf("%q 应合法,却报错: %v", e, err)
		}
	}
}

func TestParseCronInvalid(t *testing.T) {
	bad := []string{
		"",
		"* * * *",     // 段数不足
		"* * * * * *", // 段数过多
		"60 * * * *",  // 分越界
		"* 24 * * *",  // 时越界
		"* * 0 * *",   // 日下界越界(dom 从 1)
		"* * * 13 *",  // 月越界
		"* * * * 8",   // 周越界(0-7)
		"5-2 * * * *", // 区间反了
		"*/0 * * * *", // 步进为 0
		"abc * * * *", // 非数值
	}
	for _, e := range bad {
		if err := validateCron(e); err == nil {
			t.Errorf("%q 应报错,却通过", e)
		}
	}
}

func TestCronNextDaily(t *testing.T) {
	loc := time.Local
	// 每天 09:30;当前 08:00 → 今天 09:30
	from := time.Date(2026, 7, 17, 8, 0, 0, 0, loc)
	s, _ := parseCron("30 9 * * *")
	got, _ := s.next(from)
	want := time.Date(2026, 7, 17, 9, 30, 0, 0, loc)
	if !got.Equal(want) {
		t.Errorf("每天09:30(08:00起)= %v, 想要 %v", got, want)
	}
	// 当前 10:00(已过)→ 明天 09:30
	got2, _ := s.next(time.Date(2026, 7, 17, 10, 0, 0, 0, loc))
	want2 := time.Date(2026, 7, 18, 9, 30, 0, 0, loc)
	if !got2.Equal(want2) {
		t.Errorf("每天09:30(10:00起)= %v, 想要 %v", got2, want2)
	}
}

func TestCronNextInterval(t *testing.T) {
	loc := time.Local
	// 每 5 分钟;08:02 → 08:05
	s, _ := parseCron("*/5 * * * *")
	got, _ := s.next(time.Date(2026, 7, 17, 8, 2, 30, 0, loc))
	want := time.Date(2026, 7, 17, 8, 5, 0, 0, loc)
	if !got.Equal(want) {
		t.Errorf("每5分钟(08:02:30起)= %v, 想要 %v", got, want)
	}
}

func TestCronNextWeekday(t *testing.T) {
	loc := time.Local
	// 工作日 18:00;2026-07-17 是周五 19:00 → 顺延到周一(07-20)18:00
	s, _ := parseCron("0 18 * * 1-5")
	from := time.Date(2026, 7, 17, 19, 0, 0, 0, loc) // 周五晚
	got, _ := s.next(from)
	want := time.Date(2026, 7, 20, 18, 0, 0, 0, loc) // 下周一
	if !got.Equal(want) {
		t.Errorf("工作日18:00(周五19:00起)= %v, 想要 %v", got, want)
	}
}

func TestCronDomDowOr(t *testing.T) {
	loc := time.Local
	// 日=1 或 周=0(周日):都受限 → OR。2026-07-01 是周三(命中 dom=1)
	s, _ := parseCron("0 0 1 * 0")
	from := time.Date(2026, 6, 30, 12, 0, 0, 0, loc)
	got, _ := s.next(from)
	want := time.Date(2026, 7, 1, 0, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Errorf("dom=1|dow=0(6-30起)= %v, 想要 %v", got, want)
	}
}

func TestCronNextStrictlyAfter(t *testing.T) {
	loc := time.Local
	// from 恰好是触发点 → 返回下一个,不是自己
	s, _ := parseCron("*/5 * * * *")
	from := time.Date(2026, 7, 17, 8, 5, 0, 0, loc)
	got, _ := s.next(from)
	if !got.After(from) {
		t.Errorf("next 应严格晚于 from,得到 %v", got)
	}
}
