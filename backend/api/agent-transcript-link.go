package api

import (
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"ttmux-web/ttmux"
)

// 把会话和它那段 agent 对话对应起来。
//
// ttmux 自己拉起的 agent（spawn / 蜂群成员）走 `claude --session-id`，关联由构造
// 保证。但日常用法是「`ttmux new` 建个会话，然后自己在里面敲 claude」——那条路
// 我们插不进参数，只能从外面认。
//
// 认法：**会话开始跑 claude 的那一刻，先把它工作目录下已有的对话文件名记下来；
// 之后哪一份是新冒出来的，哪一份就是它的。**
//
// 两个细节是踩出来的：
//
//   - 不能只看跃迁后那一轮。Claude Code 要等**第一条消息**才把对话落盘，中间隔多久
//     取决于人什么时候开口——可能几秒，也可能几分钟。所以要一直等到它出现为止
//     （或者超时放弃）。
//   - 不能用 mtime 判「新」。同目录里别的会话继续说话时，它自己那份的 mtime 也会
//     被刷新，于是看起来像是「新出现的」。比的必须是**文件名集合的差集**。
//
// 只在完全无歧义时才认：同一目录里同时有两个会话在等着认，就一个都不认
// （本机 13 个活会话挤在 7 个目录里，这种情况是常态）。空着顶多是重开时给个空壳，
// 认错了却是把别人的对话摆到你面前。

// linkWindow 等对话出现的最长时间。超过就放弃——隔了半小时才冒出来的那份，
// 更可能是这期间用户自己另开的，不该硬认到这个会话头上。
const linkWindow = 30 * time.Minute

// pendingLink 一个「已经开始跑 claude、还没认到对话」的会话。
type pendingLink struct {
	dir   string
	kind  string // 跑的是哪一型：认到对话时一起落台账，恢复时靠它选命令
	since time.Time
	// seen 是跃迁那一刻该目录下已有的对话；之后的新面孔才算候选。
	seen map[string]bool
}

// agentLinker 记住上一轮谁在跑 agent，以及还在等着认的那些会话。
type agentLinker struct {
	mu      sync.Mutex
	prev    map[string]string // 会话 → 上一轮在跑的 agent
	pending map[string]*pendingLink
	linked  map[string]bool // 本进程内已认过，别反复 exec CLI
	primed  bool            // 第一轮只建基线
}

func newAgentLinker() *agentLinker {
	return &agentLinker{
		prev:    map[string]string{},
		pending: map[string]*pendingLink{},
		linked:  map[string]bool{},
	}
}

// projectDirFor 给出某工作目录对应的 Claude Code 对话目录
// （~/.claude/projects/<cwd 转义>）。做成变量是留给测试注入的。
var projectDirFor = func(dir string) string {
	home, err := os.UserHomeDir()
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects", encodeProject(dir))
}

var linkNow = time.Now // 测试注入时钟

// note 吃下这一轮的 agent 扫描结果：登记新开始跑 claude 的会话，并给还在等的那些
// 尝试认领。homeOf 给出会话的归属目录，link 落地关联。
func (l *agentLinker) note(running map[string]string, homeOf func(string) string, link func(sess, uuid, kind string)) {
	l.mu.Lock()
	defer l.mu.Unlock()

	prev := l.prev
	l.prev = map[string]string{}
	for s, a := range running {
		l.prev[s] = a
	}
	if !l.primed {
		l.primed = true
		return // 第一轮只建基线：此刻在跑的会话可能已经跑了几小时，认不得
	}

	now := linkNow()
	// 1) 新开始跑 claude 的会话进入等待，并记下此刻该目录已有哪些对话
	for sess, kind := range running {
		if kind != "claude" || prev[sess] == "claude" || l.linked[sess] || l.pending[sess] != nil {
			continue
		}
		dir := homeOf(sess)
		if dir == "" {
			continue
		}
		l.pending[sess] = &pendingLink{dir: dir, kind: kind, since: now, seen: transcriptSet(projectDirFor(dir))}
	}

	// 2) 会话不跑 claude 了（关了/退出了），或等太久 → 放弃。
	//    退出的同时把「已认领」也清掉：下次在这个会话里再起一个 claude 就是一段新对话，
	//    台账得跟着换——否则重启后接回的是上一段，用户看到的就是「记忆串了」
	for sess, p := range l.pending {
		if running[sess] != "claude" || now.Sub(p.since) > linkWindow {
			delete(l.pending, sess)
		}
	}
	for sess := range prev {
		if prev[sess] == "claude" && running[sess] != "claude" {
			delete(l.linked, sess)
		}
	}

	// 3) 同一目录有多个在等 → 谁都认不准，这一轮都不认（等到只剩一个再说）
	perDir := map[string]int{}
	for _, p := range l.pending {
		perDir[p.dir]++
	}
	for sess, p := range l.pending {
		if perDir[p.dir] != 1 {
			continue
		}
		fresh := newTranscripts(projectDirFor(p.dir), p.seen)
		if len(fresh) != 1 {
			continue // 还没出现，或一次冒出好几份：都不敢认
		}
		l.linked[sess] = true
		delete(l.pending, sess)
		link(sess, fresh[0], p.kind)
	}
}

// transcriptSet 列出目录下现有的对话 uuid。
func transcriptSet(dir string) map[string]bool {
	out := map[string]bool{}
	if dir == "" {
		return out
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range ents {
		if name := e.Name(); !e.IsDir() && filepath.Ext(name) == ".jsonl" {
			out[name[:len(name)-len(".jsonl")]] = true
		}
	}
	return out
}

// newTranscripts 返回 seen 之外新出现的对话 uuid。
// 比的是**文件名集合**而不是 mtime：别的会话继续说话也会刷新它自己那份的 mtime。
func newTranscripts(dir string, seen map[string]bool) []string {
	var out []string
	for uuid := range transcriptSet(dir) {
		if !seen[uuid] {
			out = append(out, uuid)
		}
	}
	return out
}

// linkAgentSession 把关联落进台账。sessions 表归 CLI 写（单写者），所以走子命令。
// 记不上不是错误：空着顶多重开时给个空壳。
func (a *API) linkAgentSession(sess, uuid, kind string) {
	if out, err := a.TT.Run("db", "link-agent", sess, uuid, kind); err != nil {
		log.Printf("关联会话对话失败 %s → %s (%s): %s", sess, uuid, kind, ttmux.StripANSI(out))
	}
}
