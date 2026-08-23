package session

import (
	"strconv"
	"strings"

	"ttmux-cli-go/internal/memguard"
	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/sessmeta"
)

// 会话集合的**唯一出处**。
//
// 从前 `ls --json`（ListJSON）和 `ls --tree`（buildTree）各自跑一遍 list-sessions、
// 各自解析同样那 8 个字段。加一类新会话就得在两处都补一遍，漏一处就是「概览里有、
// 点进项目又没了」——用户看到的数据不一致，根子在这儿。
//
// 现在两个出口都基于 Collect，休眠会话只在这里合并一次。
// 见 docs/design/reliability/session-restore.html。

// sessionListFormat 一次问齐列表要用的字段。两个出口共用同一份格式串，
// 免得字段顺序在两边悄悄分叉。
const sessionListFormat = "#{session_name}\t#{session_windows}\t#{session_created}\t" +
	"#{session_attached}\t#{session_activity}\t#{window_activity}\t#{session_id}\t#{" + runtime.LabelOption + "}"

// Collect 返回本机所有会话：tmux 里活着的，加上台账里**休眠**的
// （机器重启带走了 tmux 那一半，点开即恢复）。
//
// 顺带做一次 Reconcile：这是台账收敛「谁还活着」的地方，而列会话正是最自然的时机。
func Collect(rt runtime.Runtime, meta *sessmeta.Store, exclude map[string]bool) []sessionInfo {
	out, err := rt.TmuxOutput("list-sessions", "-F", sessionListFormat)
	live := []sessionInfo{}
	if err == nil {
		live = parseSessionLines(out, exclude)
	}
	// tmux 盲态（server 没起）时 alive 为空，Reconcile 内部会一行不动——
	// 「看不见的时候不下判断」。这里照常调用，让它自己决定。
	if meta != nil {
		alive := make(map[string]bool, len(live))
		for _, s := range live {
			alive[s.Name] = true
		}
		// 把「这个会话吃了多少内存」接给台账。cgroup 按 pane 分好了，
		// 一次读两个文件，比轮询 ps 聚合整棵进程树便宜也准。
		meta.MemStat = func(sess string) (int64, int64, bool) { return sessionMem(rt, sess) }
		meta.Reconcile(alive)
	}
	return appendDormant(live, meta, exclude)
}

// sessionMem 一个会话的峰值内存与 cgroup OOM 次数。
//
// 一个会话可能有多个 pane，各在自己的 scope 里：峰值取最大的那个（谁涨谁是主因），
// OOM 次数求和（任一 pane 撞顶都算这个会话撞了顶）。
func sessionMem(rt runtime.Runtime, sess string) (peak, ooms int64, ok bool) {
	for _, pid := range rt.PanePIDs(sess) {
		if _, p, got := memguard.Current(pid); got {
			ok = true
			if p > peak {
				peak = p
			}
		}
		ooms += memguard.OOMKilled(pid)
	}
	return peak, ooms, ok
}

// parseSessionLines 解析 list-sessions 的输出。
func parseSessionLines(out string, exclude map[string]bool) []sessionInfo {
	sessions := []sessionInfo{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 || exclude[parts[0]] {
			continue
		}
		windows, _ := strconv.Atoi(parts[1])
		attached, _ := strconv.Atoi(parts[3])
		lastActivity := ""
		if len(parts) > 4 {
			lastActivity = parts[4]
		}
		if len(parts) > 5 {
			// window_activity 补 session_activity 的盲区：tmux 只在 attach/输入/焦点变化时
			// 刷新 session_activity，后台无人 attach 的会话即便一直有输出（agent 干活）也不动。
			lastActivity = maxNumeric(lastActivity, parts[5])
		}
		tmuxID := ""
		if len(parts) > 6 {
			tmuxID = parts[6]
		}
		label := ""
		if len(parts) > 7 {
			label = strings.TrimSpace(parts[7])
		}
		created, _ := strconv.ParseInt(parts[2], 10, 64)
		row := runtime.SessionRow{Name: parts[0], Label: label, TmuxID: tmuxID, Created: created}
		sessions = append(sessions, sessionInfo{
			Name:         row.Name,
			Label:        row.DisplayLabel(),
			ID:           row.ID(),
			TmuxID:       tmuxID,
			Windows:      windows,
			Created:      parts[2],
			Attached:     attached,
			LastActivity: lastActivity,
			State:        "live",
		})
	}
	return sessions
}

// appendDormant 把「机器重启带走、但点开就能回来」的会话并进列表。
//
// 会话的「在」由台账说了算，「活」由 tmux 说了算；列表要显示的是「在」的全集。
// 少了这一步，前端 App.tsx 的 dropDeadTokens 会按这份 id 表把上次开着的终端标签
// 全部丢掉——用户连点击的机会都没有，更谈不上懒恢复。
func appendDormant(sessions []sessionInfo, meta *sessmeta.Store, exclude map[string]bool) []sessionInfo {
	if meta == nil {
		return sessions
	}
	live := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		live[s.Name] = true
	}
	for _, r := range meta.Dormant() {
		if live[r.Session] || exclude[r.Session] {
			continue
		}
		dir := r.Dir()
		sessions = append(sessions, sessionInfo{
			Name:         r.Session,
			Label:        r.DisplayLabel(),
			ID:           r.Session,
			Created:      r.CreatedAt,
			LastActivity: r.DiedAt,
			State:        "dormant",
			Agent:        r.AgentKind,
			Resumable:    r.AgentUUID != "" && r.AgentKind != "codex",
			Dir:          dir,
			Repo:         r.RepoRoot,
			CreatedBy:    r.CreatedBy,
			Parent:       r.Parent,
		})
	}
	return sessions
}
