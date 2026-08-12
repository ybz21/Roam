package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// linkFixture 造一个 transcript 目录，并允许「在某个时刻之后写出一份新对话」。
type linkFixture struct {
	t    *testing.T
	dirs map[string]string // 会话归属目录 → 该目录的 transcript 目录
	got  map[string]string // 会话 → 认到的 uuid
}

func newLinkFixture(t *testing.T) *linkFixture {
	return &linkFixture{t: t, dirs: map[string]string{}, got: map[string]string{}}
}

// project 注册一个工作目录，返回它的 transcript 目录。
func (f *linkFixture) project(home string) string {
	f.t.Helper()
	dir := f.t.TempDir()
	f.dirs[home] = dir
	return dir
}

func (f *linkFixture) homeOf(sess string) string {
	for home := range f.dirs {
		if sess == "" {
			continue
		}
		// 测试里会话名以其归属目录为前缀，简单映射即可
		if len(sess) > len(home) && sess[:len(home)] == home {
			return home
		}
	}
	return ""
}

func (f *linkFixture) link(sess, uuid string) { f.got[sess] = uuid }

// writeTranscript 在某工作目录的 transcript 目录里写一份对话。
func (f *linkFixture) writeTranscript(home, uuid string) {
	f.t.Helper()
	p := filepath.Join(f.dirs[home], uuid+".jsonl")
	if err := os.WriteFile(p, []byte(`{"sessionId":"`+uuid+`"}`+"\n"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	// 确保 mtime 严格晚于上一轮扫描时刻
	now := time.Now().Add(time.Second)
	_ = os.Chtimes(p, now, now)
}

// linkerWith 把 claudeProjectDir 换成 fixture 的映射（生产里它算的是 ~/.claude/projects）。
func (f *linkFixture) run(l *agentLinker, running map[string]string) {
	orig := projectDirFor
	projectDirFor = func(dir string) string { return f.dirs[dir] }
	defer func() { projectDirFor = orig }()
	l.note(running, f.homeOf, f.link)
}

// 正常路径，且**对话是迟到的**：Claude Code 要等第一条消息才把对话落盘，
// 中间隔多久取决于人什么时候开口。所以不能只看跃迁后那一轮。
func TestLinksWhenTranscriptArrivesLate(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()

	// 第一轮只建基线：此刻在跑的会话可能早就跑着了，认不得
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("第一轮不该认任何东西: %v", f.got)
	}

	// 第二轮：另一个会话刚起来，但用户还没开口，目录里什么都没多
	f.run(l, map[string]string{"/repo/a-1": "claude", "/repo/a-2": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("对话还没出现时不该认: %v", f.got)
	}

	// 又过了几轮，用户开口了，对话这才落盘
	f.writeTranscript("/repo/a", "uuid-new")
	f.run(l, map[string]string{"/repo/a-1": "claude", "/repo/a-2": "claude"})
	if f.got["/repo/a-2"] != "uuid-new" {
		t.Fatalf("迟到的对话也该认到: %v", f.got)
	}
	if _, ok := f.got["/repo/a-1"]; ok {
		t.Fatal("上一轮就在跑的会话不该被认（它的对话早写完了）")
	}
}

// 同目录里**别的会话**继续说话会刷新它自己那份的 mtime——那不算「新出现」。
// 判据必须是文件名集合的差集，不是 mtime。
func TestOtherSessionsWritesDoNotCountAsNew(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	// 目录里先有一份别人的对话
	f.writeTranscript("/repo/a", "uuid-someone-else")
	f.run(l, map[string]string{})

	// 我们的会话起来了；随后那份**旧**对话被刷新（别人在说话）
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	f.writeTranscript("/repo/a", "uuid-someone-else") // 重写 = mtime 变新
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("别人那份被刷新不该被当成我们的: %v", f.got)
	}

	// 真正属于我们的那份出现了，才认
	f.writeTranscript("/repo/a", "uuid-ours")
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if f.got["/repo/a-1"] != "uuid-ours" {
		t.Fatalf("该认 uuid-ours: %v", f.got)
	}
}

// 等太久就放弃：隔了半小时才冒出来的那份更可能是用户自己另开的。
func TestGivesUpAfterWindow(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	base := time.Now()
	linkNow = func() time.Time { return base }
	defer func() { linkNow = time.Now }()

	f.run(l, map[string]string{})
	f.run(l, map[string]string{"/repo/a-1": "claude"}) // 进入等待

	linkNow = func() time.Time { return base.Add(linkWindow + time.Minute) }
	f.writeTranscript("/repo/a", "uuid-late")
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("超窗之后不该再认: %v", f.got)
	}
}

// 同一目录同时起了两个会话 → 分不清谁是谁，一个都不认。
func TestSkipsWhenTwoSessionsStartInSameDir(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	f.run(l, map[string]string{})

	f.run(l, map[string]string{"/repo/a-1": "claude", "/repo/a-2": "claude"})
	f.writeTranscript("/repo/a", "uuid-x")
	f.run(l, map[string]string{"/repo/a-1": "claude", "/repo/a-2": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("同目录两个会话同时起来时不该认: %v", f.got)
	}
}

// 一轮里冒出好几份对话 → 同样不敢认。
func TestSkipsWhenSeveralTranscriptsAppear(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	f.run(l, map[string]string{})

	f.run(l, map[string]string{"/repo/a-1": "claude"})
	f.writeTranscript("/repo/a", "uuid-1")
	f.writeTranscript("/repo/a", "uuid-2")
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("一次冒出多份对话时不该认: %v", f.got)
	}
}

// 没有新对话（会话跑的不是 claude，或对话还没落盘）→ 不认，下一轮再说。
func TestSkipsWhenNoNewTranscript(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	f.run(l, map[string]string{})
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("没有新对话时不该认: %v", f.got)
	}
}

// codex 不走这条路（它没有 --session-id，对话也不在 ~/.claude/projects）。
func TestIgnoresCodex(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	f.run(l, map[string]string{"/repo/a-1": "codex"})
	f.writeTranscript("/repo/a", "uuid-1")
	f.run(l, map[string]string{"/repo/a-1": "codex"})
	if len(f.got) != 0 {
		t.Fatalf("codex 不该被认: %v", f.got)
	}
}

// 认过一次就不再重复 exec CLI（台账那边也只记一次，这里少走一趟子进程）。
func TestLinksOnlyOncePerSession(t *testing.T) {
	f := newLinkFixture(t)
	f.project("/repo/a")
	l := newAgentLinker()
	f.run(l, map[string]string{})

	f.run(l, map[string]string{"/repo/a-1": "claude"})
	f.writeTranscript("/repo/a", "uuid-1")
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if f.got["/repo/a-1"] != "uuid-1" {
		t.Fatalf("首次该认到: %v", f.got)
	}
	// 会话停了又起，目录里再冒出一份——已经认过就不再改
	delete(f.got, "/repo/a-1")
	f.run(l, map[string]string{})
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	f.writeTranscript("/repo/a", "uuid-2")
	f.run(l, map[string]string{"/repo/a-1": "claude"})
	if len(f.got) != 0 {
		t.Fatalf("同一会话不该认第二次: %v", f.got)
	}
}
