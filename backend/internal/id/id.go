// Package id 生成 Roam 的可读实例 id：`YYYY-MMDD-HHMM-<rand4>`（如 2026-0728-1113-asbd）。
// 可排序（前缀就是创建时刻）、能人肉看出是什么时候的东西、放进 URL 也不难看。
//
// 格式与 CLI 侧 cli/ttmux-cli-go/internal/id 保持一致（蜂群 id 早就是这个格式）。
// 两个 Go module 各留一份：ttmux-cli-go 的 go.mod require 了 roam-plugins/* v0.0.0，
// 只能靠它自身的 replace 解析（依赖模块的 replace 会被忽略），后端要 import 就得把那
// 几条 replace 抄进 backend/go.mod——为十几行生成器不值得。两边各有一条格式断言测试防漂。
package id

import (
	"crypto/rand"
	"regexp"
	"time"
)

const charset = "abcdefghijklmnopqrstuvwxyz0123456789"

var re = regexp.MustCompile(`^[0-9]{4}-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$`)

// New 生成一个新 id。随机源失败时退化为全 'a' 后缀——同一分钟内可能撞，
// 调用方（台账/记录）本就按 map key 去重，撞了也只是极小概率合并，不会崩。
func New() string {
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
	return time.Now().Format("2006-0102-1504") + "-" + string(b)
}

// Valid 判断字符串是否本格式的 id（用于区分「新 id」与「历史遗留的派生 key」）。
func Valid(s string) bool { return re.MatchString(s) }
