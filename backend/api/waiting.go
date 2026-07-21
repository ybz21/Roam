package api

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// 移植前端 prompt.tsx 的 detectPrompt 布尔判定：从一屏 capture 纯文本里看是否有
// 等待用户输入的交互框（Claude/Codex 的权限确认 / 编号选择菜单 / y-n）。列表绿点
// 语义（设计 W2）里的「黄=待输入」用它，务必与前端解析口径一致，避免列表/详情打架。
var (
	waitANSI   = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]")
	waitCtrl   = regexp.MustCompile("[\x00-\x08\x0b-\x1f\x7f]")
	waitCursor = regexp.MustCompile(`[❯➤▶►▸→›»☞◉●>]`)
	waitLead   = regexp.MustCompile(`^[\s│┃|╎┆┊╭╰├╞┝─━═]+`)
	waitTail   = regexp.MustCompile(`[\s│┃|╎┆┊╮╯┤╡┥─━═]+$`)
	waitOpt    = regexp.MustCompile(`^(?:[❯➤▶►▸→›»☞◉●>]\s*)?(\d+)[.)]\s+(\S.*)$`)
	waitKW     = regexp.MustCompile(`(?i)(would you like|proceed|allow|continue|overwrite|apply|approve|trust|run|command|是否|确认|继续|允许|要不要|执行|命令)`)
	waitYesNo  = regexp.MustCompile(`(?i)\((?:y/n|yes/no)\)|\[y/n\]`)
)

func waitStripCtl(s string) string {
	return waitCtrl.ReplaceAllString(waitANSI.ReplaceAllString(s, ""), "")
}

func waitClean(s string) string {
	s = waitStripCtl(s)
	s = waitLead.ReplaceAllString(s, "")
	s = waitTail.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// sessionCapture 抓会话当前屏纯文本（=name 精确匹配，避开 tmux -t 前缀匹配 footgun）。
func sessionCapture(name string, lines int) string {
	out, err := exec.Command("tmux", "capture-pane", "-t", "="+name, "-p", "-J", "-S", "-"+strconv.Itoa(lines)).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// sessionWaiting 判断一屏 capture 是否有等待输入的交互框（detectPrompt 的布尔版）。
func sessionWaiting(capture string) bool {
	lines := strings.Split(strings.ReplaceAll(waitStripCtl(capture), "\r", ""), "\n")
	type opt struct {
		num, idx int
		selected bool
	}
	var opts []opt
	for idx, raw := range lines {
		if m := waitOpt.FindStringSubmatch(waitClean(raw)); m != nil {
			n, _ := strconv.Atoi(m[1])
			opts = append(opts, opt{num: n, idx: idx, selected: waitCursor.MatchString(raw)})
		}
	}
	// 取最后一组相邻选项（允许 ≤3 行间隔，兼容 Codex 长选项换行）
	var g []opt
	for i := len(opts) - 1; i >= 0; i-- {
		if len(g) == 0 || g[0].idx-opts[i].idx <= 3 {
			g = append([]opt{opts[i]}, g...)
		} else {
			break
		}
	}
	// 必须从 1 起连续编号、至少两项，否则当普通编号列表不误判
	sequential := len(g) >= 2
	for k, o := range g {
		if o.num != k+1 {
			sequential = false
			break
		}
	}
	if sequential {
		var qlines []string
		for i := g[0].idx - 1; i >= 0 && g[0].idx-i <= 6; i-- {
			c := waitClean(lines[i])
			if c == "" {
				if len(qlines) > 0 {
					break
				}
				continue
			}
			if waitOpt.MatchString(c) {
				continue
			}
			qlines = append([]string{c}, qlines...)
			if len(qlines) >= 3 {
				break
			}
		}
		question := strings.TrimSpace(strings.Join(qlines, " "))
		lo := g[0].idx - 8
		if lo < 0 {
			lo = 0
		}
		hi := g[len(g)-1].idx + 3
		if hi > len(lines) {
			hi = len(lines)
		}
		var win []string
		for _, l := range lines[lo:hi] {
			win = append(win, waitClean(l))
		}
		windowText := strings.Join(win, " ")
		anySel := false
		for _, o := range g {
			if o.selected {
				anySel = true
				break
			}
		}
		if anySel || waitKW.MatchString(question) || waitKW.MatchString(windowText) {
			return true
		}
	}
	// y/n 兜底
	for i := len(lines) - 1; i >= 0 && len(lines)-i <= 12; i-- {
		if waitYesNo.MatchString(waitClean(lines[i])) {
			return true
		}
	}
	return false
}
