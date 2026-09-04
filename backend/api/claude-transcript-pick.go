// 给一个正在跑的 claude 进程挑它自己的对话文件。
//
// 从前一律取目录下最新的 .jsonl：会话重开、在同一个 worktree 里重新起一个 claude，
// 它还没说过话、没写文件，目录里最新的那份是**上一段**对话——对话视图里就显示着上一段的
// 记忆，终端里却是一个空白的新 Claude（「一个显示记忆，点一下又没有记忆了」）。
//
// 规则按进程自己的命令行来：
//
//	--resume <id> / -r <id>：就是那一份；
//	--continue / -c：目录里最新的那份（Claude Code 自己也是这么选的）；
//	其它（新开）：只认进程启动之后写过的文件，一个都没有就是「还没有对话」。
package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var uuidLike = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// pickTranscript 在 pdir（~/.claude/projects/<cwd 转义>）里挑 argv 这个进程的对话文件；start 是进程启动时刻。
func pickTranscript(pdir string, argv []string, start time.Time) string {
	for i, a := range argv {
		switch a {
		case "--resume", "-r":
			// 跨目录 resume（会话重开时 cwd 变了）：Claude Code 继续写**原来**那份文件，
			// 它躺在原目录的项目夹里，不在当前 cwd 的夹里——按 id 全盘找
			if i+1 < len(argv) && uuidLike.MatchString(argv[i+1]) {
				if p := findTranscript(filepath.Dir(pdir), pdir, argv[i+1]); p != "" {
					return p
				}
			}
			// 没带 id 的 --resume 是交互选单，选了哪段只能等它写文件：按「新开」处理
		case "--continue", "-c":
			return newestJSONL(pdir)
		}
	}
	// 新开：只认启动之后动过的文件。留 3s 余量：文件系统时间戳和进程启动时刻不是一个钟
	return newestJSONLSince(pdir, start.Add(-3*time.Second))
}

// findTranscript 先看 pdir，再扫 ~/.claude/projects 下所有项目夹找 <id>.jsonl。
func findTranscript(root, pdir, id string) string {
	if p := filepath.Join(pdir, id+".jsonl"); fileExists(p) {
		return p
	}
	ents, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		if p := filepath.Join(root, e.Name(), id+".jsonl"); fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func newestJSONLSince(dir string, since time.Time) string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	best, bestMod := "", time.Time{}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		fi, err := e.Info()
		if err != nil || fi.ModTime().Before(since) {
			continue
		}
		if fi.ModTime().After(bestMod) {
			bestMod, best = fi.ModTime(), filepath.Join(dir, e.Name())
		}
	}
	return best
}

// processStart 进程启动时刻：/proc/<pid> 目录的 ctime 就是它出生那一刻（Linux）；拿不到给零值，
// 零值让 pickTranscript 退回「取最新」。
func processStart(pid int) time.Time {
	fi, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

// treeFind 从 pid 起 DFS 子进程树，返回第一个命中 match 的进程 pid；没有返回 0。
func treeFind(pid int, children map[int][]int, depth int, match func(int) bool) int {
	if depth > 12 {
		return 0
	}
	if match(pid) {
		return pid
	}
	for _, ch := range children[pid] {
		if got := treeFind(ch, children, depth+1, match); got != 0 {
			return got
		}
	}
	return 0
}
