// Package ttmux 是 ttmux CLI 的封装层 —— 唯一接触子进程的地方。
// 读 = 调 `ttmux <cmd> --json`；写 = 调对应子命令。所有参数独立传入，杜绝命令注入。
package ttmux

import (
	"bytes"
	"os/exec"
	"regexp"
)

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

type Client struct {
	Bin string
}

func New(bin string) *Client { return &Client{Bin: bin} }

// Run 执行 ttmux 子命令，返回合并的 stdout/stderr。
func (c *Client) Run(args ...string) (string, error) {
	cmd := exec.Command(c.Bin, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// StripANSI 去除文本中的 ANSI 颜色转义。
func StripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }
