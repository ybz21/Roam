// Package id 生成 Roam 的可读实例 id：`YYYY-MMDD-HHMM-<rand4>`（如 2026-0728-1113-asbd）。
// 蜂群 id 一直是这个格式，抽出来给全 CLI 共用，别再各写各的。
//
// 后端 backend/internal/id 有一份同格式实现（两个 Go module，不跨模块 import——
// 见那边的包注释），两边各有一条格式断言测试防漂。
package id

import (
	"crypto/rand"
	"regexp"
	"time"
)

const charset = "abcdefghijklmnopqrstuvwxyz0123456789"

var re = regexp.MustCompile(`^[0-9]{4}-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$`)

// NewAt 用给定时刻生成 id（调用方通常传 rt.Now，测试可注入固定时钟）。
func NewAt(now time.Time) string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err == nil {
		for i := range b {
			b[i] = charset[int(b[i])%len(charset)]
		}
	} else {
		for i := range b {
			b[i] = 'a'
		}
	}
	return now.Format("2006-0102-1504") + "-" + string(b)
}

// New 用当前时刻生成 id。
func New() string { return NewAt(time.Now()) }

// Valid 判断字符串是否本格式的 id。
func Valid(s string) bool { return re.MatchString(s) }
