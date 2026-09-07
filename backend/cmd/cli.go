// roam 的子命令层：把散在各处的命令收进**一个**入口。
//
// 在这之前，同一件事有三种叫法：给自己发条消息是
// `ttmux plugin run im-bridge.send --text …`，看定时任务是
// `ttmux plugin run cron.list`，开会话又是 `ttmux ls`——插件名、命令名、
// 前缀各记一套，谁也记不住。现在统一成：
//
//	roami <插件> <命令> [--k v]   任何已装插件都自动是一组（im / cron / host / review…）
//	roami ttmux <参数...>          会话、蜂群、窗格：原样转发给 ttmux
//	roami <其它>                   也转发给 ttmux（它自己再兜底给 tmux），所以 roami ls 照用
//	roami [flags]                  没有子命令时照旧启动 Web 服务，一个字都没变
//
// 改名前叫 roam，装的时候留了一条同名软链，老脚本照跑。
//
// 插件那一组不是硬编码的清单：装了什么就有什么，名字按**唯一前缀**认——
// `roam im send` 对应 roam.im-bridge，`roam host stats` 对应 roam.host-monitor。
// 短名是插件自己 manifest 里的 name，这一层不替它起别名。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// pluginInfo 是 `ttmux plugin ls --json` 里我们用得上的那几项。
type pluginInfo struct {
	ID       string // roam.im-bridge
	Name     string // im-bridge
	Enabled  bool
	Commands []string // im-bridge.send …
	Summary  string
}

// resolveGroup 把用户敲的词认成插件：全名 > 短名 > 唯一前缀。
// 认不出返回空（调用方据此转发给 ttmux）；前缀撞了要报错——
// 猜一个跑出去比说不认识危险得多。
func resolveGroup(plugins []pluginInfo, word string) (*pluginInfo, error) {
	var hits []int
	for i, p := range plugins {
		if p.ID == word || p.Name == word {
			return &plugins[i], nil
		}
		if strings.HasPrefix(p.Name, word) {
			hits = append(hits, i)
		}
	}
	switch len(hits) {
	case 0:
		return nil, nil
	case 1:
		return &plugins[hits[0]], nil
	default:
		names := make([]string, 0, len(hits))
		for _, i := range hits {
			names = append(names, plugins[i].Name)
		}
		sort.Strings(names)
		return nil, fmt.Errorf("%q 对得上好几个插件：%s——写全一点", word, strings.Join(names, " / "))
	}
}

// pluginRunArgs 拼出转发给 ttmux 的参数。命令用 id 限定形式（roam.cron:list），
// 归属由注册表按全 id 精确判定，不会落到短名撞名的另一个插件上。
func pluginRunArgs(p pluginInfo, cmd string, rest []string) []string {
	return append([]string{"plugin", "run", p.ID + ":" + cmd}, rest...)
}

// shortCmd 把 contributes 里的 "cron.list" 剥成 "list"。
func shortCmd(id string) string {
	if _, after, ok := strings.Cut(id, "."); ok {
		return after
	}
	return id
}

func loadPlugins(ttmuxBin string) []pluginInfo {
	out, err := exec.Command(ttmuxBin, "plugin", "ls", "--json").Output()
	if err != nil {
		return nil
	}
	var raw []struct {
		Enabled  bool `json:"enabled"`
		Manifest struct {
			ID          string            `json:"id"`
			Name        string            `json:"name"`
			Description map[string]string `json:"description"`
			Contributes struct {
				Commands []struct {
					ID string `json:"id"`
				} `json:"commands"`
			} `json:"contributes"`
		} `json:"manifest"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	list := make([]pluginInfo, 0, len(raw))
	for _, r := range raw {
		p := pluginInfo{ID: r.Manifest.ID, Name: r.Manifest.Name, Enabled: r.Enabled,
			Summary: r.Manifest.Description["zh-CN"]}
		for _, c := range r.Manifest.Contributes.Commands {
			p.Commands = append(p.Commands, shortCmd(c.ID))
		}
		list = append(list, p)
	}
	return list
}

// runCLI 处理子命令。返回 false 表示「这不是子命令」，main 照旧启动服务。
func runCLI(args []string, ttmuxBin string) (handled bool, code int) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return false, 0
	}
	// PATH 上没有 ttmux 时用内嵌那份（单一二进制发行）：子命令层比 main 里那段
	// 解压逻辑更早跑，不在这儿解一次，`roam cron list` 在干净机器上就直接找不到命令。
	if _, err := exec.LookPath(ttmuxBin); err != nil {
		if p := embeddedBin(); p != "" {
			ttmuxBin = p
			_ = os.Setenv("TTMUX_BIN", p)
		}
	}
	word, rest := args[0], args[1:]

	if word == "help" || word == "commands" {
		printHelp(loadPlugins(ttmuxBin))
		return true, 0
	}
	if word == "ttmux" {
		return true, forward(ttmuxBin, rest)
	}

	plugins := loadPlugins(ttmuxBin)
	p, err := resolveGroup(plugins, word)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return true, 2
	}
	if p == nil {
		// 不是插件组：转发给 ttmux（它认会话/蜂群，还会把没见过的命令再兜给 tmux）
		return true, forward(ttmuxBin, args)
	}
	if len(rest) == 0 || rest[0] == "help" {
		printGroup(*p)
		return true, 0
	}
	if !p.Enabled {
		fmt.Fprintf(os.Stderr, "插件 %s 已停用：先 roami ttmux plugin enable %s\n", p.Name, p.ID)
		return true, 2
	}
	return true, forward(ttmuxBin, pluginRunArgs(*p, rest[0], rest[1:]))
}

func forward(bin string, args []string) int {
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if ok := asExitError(err, &ee); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "调用 %s 失败: %v\n", bin, err)
		return 1
	}
	return 0
}

func printHelp(plugins []pluginInfo) {
	fmt.Printf("  roami %s — 一个入口\n\n", displayVersion())
	fmt.Println("  roami <插件> <命令> [--k v]   插件命令（装了什么就有什么，名字可写唯一前缀）")
	fmt.Println("  roami ttmux <参数...>          会话 / 蜂群 / 窗格（转发给 ttmux）")
	fmt.Println("  roami <会话命令>               同上，roami ls / roami a <名> 直接用")
	fmt.Println("  roami [flags]                 不带子命令＝启动 Web 服务（roami -h 看 flags）")
	if len(plugins) == 0 {
		return
	}
	fmt.Println("\n  已装插件：")
	for _, p := range plugins {
		state := ""
		if !p.Enabled {
			state = "（已停用）"
		}
		fmt.Printf("    %-14s %s%s\n", p.Name, firstLine(p.Summary), state)
	}
	fmt.Println("\n  例：roami im send --text '跑完了'   roami cron list   roami host stats")
	fmt.Println("  （改名前叫 roam，那个名字留了软链，老脚本照跑）")
}

func printGroup(p pluginInfo) {
	fmt.Printf("  %s — %s\n\n", p.Name, firstLine(p.Summary))
	for _, c := range p.Commands {
		fmt.Printf("    roami %s %s\n", p.Name, c)
	}
}

// displayVersion 保证只有一个 v：注入的 tag 本身就带（v0.1.0-rc.2-…），
// 开发构建是裸的 "dev"。
func displayVersion() string {
	if strings.HasPrefix(version, "v") {
		return version
	}
	return "v" + version
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\n;"); i > 0 {
		return s[:i]
	}
	return s
}
