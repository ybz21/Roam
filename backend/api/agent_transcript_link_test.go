package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// linkFixture：假的项目夹 + 假的进程（命令行、启动时刻），reconcile 只看这些。
type linkFixture struct {
	t     *testing.T
	dirs  map[string]string // cwd → 该 cwd 的对话目录
	argv  map[int][]string  // pid → 命令行
	start map[int]time.Time // pid → 启动时刻
	got   map[string]string // 会话 → 认到的 uuid
}

func newLinkFixture(t *testing.T) *linkFixture {
	return &linkFixture{t: t, dirs: map[string]string{}, argv: map[int][]string{}, start: map[int]time.Time{}, got: map[string]string{}}
}

func (f *linkFixture) project(cwd string) { f.dirs[cwd] = f.t.TempDir() }

// proc 造一个进程：启动于 startAgo 之前，命令行 argv
func (f *linkFixture) proc(pid int, startAgo time.Duration, argv ...string) {
	f.argv[pid] = argv
	f.start[pid] = time.Now().Add(-startAgo)
}

// transcript 在某 cwd 的对话目录里写一份，mtime = modAgo 之前
func (f *linkFixture) transcript(cwd, uuid string, modAgo time.Duration) {
	f.t.Helper()
	p := filepath.Join(f.dirs[cwd], uuid+".jsonl")
	if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	m := time.Now().Add(-modAgo)
	_ = os.Chtimes(p, m, m)
}

func (f *linkFixture) run(l *agentLinker, procs map[string]agentProc) {
	o1, o2, o3 := projectDirFor, procArgvOf, procStartOf
	projectDirFor = func(dir string) string { return f.dirs[dir] }
	procArgvOf = func(pid int) []string { return f.argv[pid] }
	procStartOf = func(pid int) time.Time { return f.start[pid] }
	defer func() { projectDirFor, procArgvOf, procStartOf = o1, o2, o3 }()
	l.reconcile(procs, func(sess, uuid, _ string) { f.got[sess] = uuid })
}

const u1, u2, u3 = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"

// 新开的 claude：对话是迟到的（等第一条消息才落盘），出现前不认、出现后认；上一段的旧文件不算
func TestLinksNewTranscriptOnlyAfterStart(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	f.transcript("/repo/a", u1, time.Hour) // 上一段
	f.proc(1, 10*time.Minute, "claude")
	l := newAgentLinker()
	procs := map[string]agentProc{"s1": {Kind: "claude", Dir: "/repo/a", Pid: 1}}
	f.run(l, procs)
	if len(f.got) != 0 {
		t.Fatalf("还没说话不该认（更不该认上一段）: %v", f.got)
	}
	f.transcript("/repo/a", u2, 0)
	f.run(l, procs)
	if f.got["s1"] != u2 {
		t.Fatalf("落盘后该认到: %v", f.got)
	}
}

// --resume <id>：命令行就是事实，文件在不在都认
func TestResumeIdWinsEvenBeforeFile(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	f.proc(1, time.Minute, "claude", "--resume", u3)
	l := newAgentLinker()
	f.run(l, map[string]agentProc{"s1": {Kind: "claude", Dir: "/repo/a", Pid: 1}})
	if f.got["s1"] != u3 {
		t.Fatalf("该认命令行里的 id: %v", f.got)
	}
}

// 同一目录同时跑两个 claude：靠文件猜不准，谁都不认；带 --resume 的那个照认
func TestSkipsAmbiguousSameDir(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	f.transcript("/repo/a", u1, 0)
	f.proc(1, time.Minute, "claude")
	f.proc(2, time.Minute, "claude", "--resume", u2)
	l := newAgentLinker()
	f.run(l, map[string]agentProc{"s1": {Kind: "claude", Dir: "/repo/a", Pid: 1}, "s2": {Kind: "claude", Dir: "/repo/a", Pid: 2}})
	if _, ok := f.got["s1"]; ok {
		t.Fatalf("同目录两个 claude 不该靠文件认: %v", f.got)
	}
	if f.got["s2"] != u2 {
		t.Fatalf("带 --resume 的照认: %v", f.got)
	}
}

// claude 停了再起，新对话换掉旧的；同一段不重复写台账
func TestRelinksAfterRestart(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	f.proc(1, 10*time.Minute, "claude")
	f.transcript("/repo/a", u1, time.Minute)
	l := newAgentLinker()
	procs := map[string]agentProc{"s1": {Kind: "claude", Dir: "/repo/a", Pid: 1}}
	f.run(l, procs)
	if f.got["s1"] != u1 {
		t.Fatalf("首次该认到: %v", f.got)
	}
	delete(f.got, "s1")
	f.run(l, procs)
	if len(f.got) != 0 {
		t.Fatalf("同一段不该重复写: %v", f.got)
	}
	// 停了
	f.run(l, map[string]agentProc{})
	// 再起，新对话
	f.proc(2, 0, "claude")
	f.transcript("/repo/a", u2, 0)
	f.run(l, map[string]agentProc{"s1": {Kind: "claude", Dir: "/repo/a", Pid: 2}})
	if f.got["s1"] != u2 {
		t.Fatalf("重开后该认新对话: %v", f.got)
	}
}

func TestIgnoresCodex(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	f.transcript("/repo/a", u1, 0)
	f.proc(1, 0, "codex")
	l := newAgentLinker()
	f.run(l, map[string]agentProc{"s1": {Kind: "codex", Dir: "/repo/a", Pid: 1}})
	if len(f.got) != 0 {
		t.Fatalf("codex 不该被认: %v", f.got)
	}
}
