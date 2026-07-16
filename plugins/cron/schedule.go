package cron

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// minInterval 是 every 型任务的最小间隔:调度循环本身按 tickInterval 巡检,
// 再密的间隔只会空转,且容易把通知/会话刷爆。
const minInterval = 10 * time.Second

// parseInterval 解析 every 字段(Go duration:如 30s / 5m / 1h30m / 24h)。
func parseInterval(s string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("interval %q 非法(用 30s / 5m / 1h30m / 24h 这种写法)", s)
	}
	if d < minInterval {
		return 0, fmt.Errorf("interval %s 太小,最少 %s", d, minInterval)
	}
	return d, nil
}

// parseDaily 解析 at 字段("HH:MM",24 小时制,本机时区),返回时、分。
func parseDaily(s string) (hh, mm int, err error) {
	parts := strings.SplitN(strings.TrimSpace(s), ":", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("at %q 非法(用 HH:MM,如 09:30)", s)
	}
	hh, err = strconv.Atoi(parts[0])
	if err != nil || hh < 0 || hh > 23 {
		return 0, 0, fmt.Errorf("at %q 的小时非法(0-23)", s)
	}
	mm, err = strconv.Atoi(parts[1])
	if err != nil || mm < 0 || mm > 59 {
		return 0, 0, fmt.Errorf("at %q 的分钟非法(0-59)", s)
	}
	return hh, mm, nil
}

// validateSchedule 校验 every / at 恰有一个且格式合法(cron.add 入口用)。
func validateSchedule(every, at string) error {
	switch {
	case every != "" && at != "":
		return fmt.Errorf("--every 与 --at 只能给一个")
	case every != "":
		_, err := parseInterval(every)
		return err
	case at != "":
		_, _, err := parseDaily(at)
		return err
	default:
		return fmt.Errorf("需要 --every <间隔> 或 --at <HH:MM> 指定排期")
	}
}

// nextAfter 计算 from 之后该任务的下一次触发时刻(严格晚于 from)。
//   - every 型:from + 间隔;若排期落后于 now(调度器停过一阵),快进到未来的
//     下一个整点间隔,避免一次性补跑一堆积压。
//   - at 型:今天的 HH:MM,已过则顺延到明天。
func nextAfter(j Job, from time.Time) (time.Time, error) {
	if j.Every != "" {
		d, err := parseInterval(j.Every)
		if err != nil {
			return time.Time{}, err
		}
		return from.Add(d), nil
	}
	hh, mm, err := parseDaily(j.At)
	if err != nil {
		return time.Time{}, err
	}
	next := time.Date(from.Year(), from.Month(), from.Day(), hh, mm, 0, 0, from.Location())
	if !next.After(from) {
		next = next.Add(24 * time.Hour)
	}
	return next, nil
}

// advancePast 把 every 型任务的下次触发推到严格晚于 now,吞掉调度器停摆期间
// 积压的多个到期点(只补最后一次,不逐个补跑)。at 型直接算下一个当日时刻。
func advancePast(j Job, now time.Time) (time.Time, error) {
	if j.Every == "" {
		return nextAfter(j, now)
	}
	d, err := parseInterval(j.Every)
	if err != nil {
		return time.Time{}, err
	}
	next := time.Unix(j.NextRun, 0)
	if j.NextRun == 0 || !next.After(now) {
		// 从当前的排期点起步,快进整数个间隔到未来
		if j.NextRun == 0 {
			next = now
		}
		for !next.After(now) {
			next = next.Add(d)
		}
	}
	return next, nil
}
