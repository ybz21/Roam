// Pane 级操作：关闭 pane 这类危险操作要能定位到具体窗格（几何 + cwd + 前台进程），
// 而不是像工具栏 tmux 菜单那样盲发 Ctrl-b x 字节——那样只会撞上 tmux 出厂默认的
// `confirm-before` 绑定，在终端最底部弹一个不透明的 "pane 1" 编号，跟用户点的是哪个
// 窗格毫无关系。这里给前端一个「先看清楚要关的是谁，再结构化执行」的路径。
package api

import (
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

var paneIDPattern = regexp.MustCompile(`^%\d+$`)

// tmuxBinary 同 worktree.tmuxBin()：TMUX_BIN 可指向一个转发到隔离 socket 的 wrapper 脚本，
// 测试借此在真实 tmux 上跑，不会碰到用户自己的 tmux server。生产环境不设该变量，行为不变。
func tmuxBinary() string {
	if b := os.Getenv("TMUX_BIN"); b != "" {
		return b
	}
	return "tmux"
}

type paneInfo struct {
	PaneID        string `json:"paneId"`
	Left          int    `json:"left"`
	Top           int    `json:"top"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	Cwd           string `json:"cwd"`
	Cmd           string `json:"cmd"`
	PanesInWindow int    `json:"panesInWindow"`
}

const listPanesFormat = "#{pane_id}\t#{pane_active}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_current_command}\t#{window_id}"

// parsePanes 解析 listPanesFormat 的输出：只留活动 pane 所在窗口的那一组（tmuxMenu 的
// 「关闭当前窗格」概念上就是「当前窗口里被选中的那个」），panesInWindow 就是这一组的长度，
// 供前端判断「关了会不会连窗口一起没」。纯函数、不碰子进程，方便直接灌固定文本测试。
func parsePanes(raw string) ([]paneInfo, string) {
	type row struct {
		info   paneInfo
		window string
		active bool
	}
	var rows []row
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) != 9 {
			continue
		}
		left, e1 := strconv.Atoi(parts[2])
		top, e2 := strconv.Atoi(parts[3])
		width, e3 := strconv.Atoi(parts[4])
		height, e4 := strconv.Atoi(parts[5])
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
			continue
		}
		rows = append(rows, row{
			info: paneInfo{
				PaneID: parts[0], Left: left, Top: top, Width: width, Height: height,
				Cwd: parts[6], Cmd: parts[7],
			},
			window: parts[8],
			active: parts[1] == "1",
		})
	}
	var activeWindow string
	for _, r := range rows {
		if r.active {
			activeWindow = r.window
			break
		}
	}
	count := 0
	for _, r := range rows {
		if r.window == activeWindow {
			count++
		}
	}
	var out []paneInfo
	for _, r := range rows {
		if activeWindow == "" || r.window == activeWindow {
			p := r.info
			p.PanesInWindow = count
			out = append(out, p)
		}
	}
	return out, activeWindow
}

// listPanes 列出某会话全部 pane 的几何/cwd/前台进程，见 parsePanes。
func listPanes(name string) ([]paneInfo, string) {
	out, err := exec.Command(tmuxBinary(), "list-panes", "-t", name, "-F", listPanesFormat).Output()
	if err != nil {
		return nil, ""
	}
	return parsePanes(string(out))
}

// ActivePane GET /sessions/:name/panes/active —— 当前活动 pane 的几何 + cwd + 前台进程，
// 供前端把高亮框套在正确的屏幕矩形上、确认卡上显示人话信息（而不是 "pane 1"）。
func (a *API) ActivePane(c *gin.Context) {
	name := a.sessionTarget(c)
	out, err := exec.Command(tmuxBinary(), "display-message", "-t", "="+name+":", "-p", "#{pane_id}").Output()
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "SESSION_NOT_FOUND"}})
		return
	}
	activeID := strings.TrimSpace(string(out))
	panes, _ := listPanes(name)
	for _, p := range panes {
		if p.PaneID == activeID {
			c.JSON(http.StatusOK, gin.H{"data": p})
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "PANE_NOT_FOUND"}})
}

// ClosePane POST /sessions/:name/panes/:paneId/close —— 结构化关闭：直接 kill-pane，
// 不发送 x 按键，因此不会触发 tmux 出厂的 confirm-before 底部提示。执行后重新点名
// 确认目标真的消失了（若连同 session 一起没了也算成功），失败原样报错，不吞掉。
func (a *API) ClosePane(c *gin.Context) {
	name := a.sessionTarget(c)
	paneID := c.Param("paneId")
	if !paneIDPattern.MatchString(paneID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PANE_ID"}})
		return
	}
	if out, err := exec.Command(tmuxBinary(), "kill-pane", "-t", paneID).CombinedOutput(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "KILL_PANE_FAILED", "message": strings.TrimSpace(string(out))}})
		return
	}
	panes, _ := listPanes(name)
	for _, p := range panes {
		if p.PaneID == paneID {
			c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "PANE_STILL_ALIVE"}})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"closed": paneID}})
}
