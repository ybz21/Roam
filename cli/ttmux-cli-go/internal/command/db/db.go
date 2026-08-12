// Package db 是 meta.db 的运维入口：看状态、显式跑迁移、落备份、改会话归属。
//
// 结构性迁移本身不靠这些命令——metadb.Open 里就做完了，任何代码路径都拿不到
// 未迁移的库。这里存在的意义是**可观测**（停在哪一版、各表多少行）与**可显式触发**
// （旧台账收编要 DataDir，某些入口开库时给不全，用 migrate 补一刀）。
package db

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"

	"ttmux-cli-go/internal/metadb"
	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/sessmeta"
	"ttmux-cli-go/internal/ui"
)

// Run 分发 `ttmux db <子命令>`。
func Run(rt runtime.Runtime, args []string, w io.Writer) error {
	sub := "status"
	if len(args) > 0 {
		sub = args[0]
		args = args[1:]
	}
	asJSON := false
	var rest []string
	for _, a := range args {
		if a == "--json" {
			asJSON = true
			continue
		}
		rest = append(rest, a)
	}
	switch sub {
	case "status":
		return status(rt, asJSON, w)
	case "migrate":
		return migrate(rt, asJSON, w)
	case "backup":
		return backup(rt, rest, asJSON, w)
	case "set-home":
		return setHome(rt, rest, w)
	default:
		return fmt.Errorf("未知子命令 %q（可用：status | migrate | backup | set-home）", sub)
	}
}

func open(rt runtime.Runtime) (*metadb.DB, error) {
	return metadb.Open(rt.HomeDir, metadb.Options{
		DataDir: rt.DataDir, HomeDir: rt.HomeDir, Now: rt.Now,
	})
}

// Info 是 `db status --json` 的输出。**后端靠它握手**：库的路径只能从这里拿，
// 绝不能由后端自己 filepath.Join —— ROAM_DATA 与 ROAM_HOME 可以指到不同地方，
// 自己拼会静悄悄开出一个空库。
type Info struct {
	Path      string         `json:"path"`
	Version   int            `json:"schemaVersion"`
	MinCompat int            `json:"minCompatible"`
	Journal   string         `json:"journalMode"`
	CLI       string         `json:"cliVersion"`
	Rows      map[string]int `json:"rows,omitempty"`
}

// minCompatible 是「读得懂本库的最低后端版本」。schema 只增不改，所以老读者
// 永远读得懂新库；真出现破坏性变更时把这个数字顶上去，后端会自己退到只读。
const minCompatible = 1

var countedTables = []string{
	"sessions", "projects", "project_aliases", "races", "session_homes",
	"swarms", "swarm_members", "swarm_cards", "plugin_sessions", "tmux_epochs",
}

func status(rt runtime.Runtime, asJSON bool, w io.Writer) error {
	d, err := open(rt)
	if err != nil {
		return err
	}
	v, err := d.Version()
	if err != nil {
		return err
	}
	var journal string
	_ = d.QueryRow(`PRAGMA journal_mode`).Scan(&journal)

	info := Info{Path: d.Path(), Version: v, MinCompat: minCompatible,
		Journal: journal, CLI: runtime.Version, Rows: map[string]int{}}
	for _, t := range countedTables {
		var n int
		if d.QueryRow(`SELECT COUNT(*) FROM `+t).Scan(&n) == nil {
			info.Rows[t] = n
		}
	}
	if asJSON {
		return json.NewEncoder(w).Encode(info)
	}
	fmt.Fprintf(w, "\n  %s %s\n", ui.Bold("库"), info.Path)
	fmt.Fprintf(w, "  %s schema v%d · journal %s\n\n", ui.Bold("版本"), v, journal)
	names := make([]string, 0, len(info.Rows))
	for t := range info.Rows {
		names = append(names, t)
	}
	sort.Strings(names)
	for _, t := range names {
		fmt.Fprintf(w, "    %-18s %d\n", t, info.Rows[t])
	}
	fmt.Fprintln(w)
	return nil
}

func migrate(rt runtime.Runtime, asJSON bool, w io.Writer) error {
	d, err := open(rt)
	if err != nil {
		return err
	}
	v, _ := d.Version()
	rep := metadb.LastReport()
	if asJSON {
		return json.NewEncoder(w).Encode(map[string]any{
			"schemaVersion": v, "report": rep,
		})
	}
	ui.Ok(w, "schema 已在 v%d", v)
	if rep.Projects+rep.Races+rep.Homes+rep.Members+rep.Cards > 0 {
		ui.Info(w, "收编：%s", rep)
	}
	for _, sid := range rep.SkippedSwarms {
		ui.Warn(w, "跳过孤儿蜂群目录 %s（swarms 表里没有登记）", sid)
	}
	return nil
}

func backup(rt runtime.Runtime, rest []string, asJSON bool, w io.Writer) error {
	dest := ""
	for i, a := range rest {
		if a == "--out" && i+1 < len(rest) {
			dest = rest[i+1]
		}
	}
	d, err := open(rt)
	if err != nil {
		return err
	}
	path, err := d.Backup(dest)
	if err != nil {
		return err
	}
	if asJSON {
		return json.NewEncoder(w).Encode(map[string]string{"path": path})
	}
	ui.Ok(w, "已备份到 %s", ui.Bold(path))
	return nil
}

// setHome 记会话归属的**台账事实**。后端事后改钉（cdInto 之后、fork 继承父归属）
// 走这里，因为 sessions 表归 CLI 写——后端自己那张 session_homes 只管运行时绑定。
func setHome(rt runtime.Runtime, rest []string, w io.Writer) error {
	if len(rest) < 2 {
		return fmt.Errorf("用法：ttmux db set-home <会话> <目录>")
	}
	sess := rt.Resolve(rest[0])
	if sess == "" {
		sess = rest[0] // 会话可能已经没了，台账照记
	}
	meta := sessmeta.New(rt.HomeDir)
	meta.DataDir = rt.DataDir
	return meta.SetHome(sess, rest[1], "")
}
