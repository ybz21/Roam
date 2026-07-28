package sessmeta

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestStore 造一个带假 tmux 映射的 store；改 ids 即模拟建/杀/改名会话。
func newTestStore(t *testing.T, ids map[string]string) (*Store, func(map[string]string)) {
	t.Helper()
	dir := t.TempDir()
	cur := ids
	s := New(dir)
	s.Now = func() time.Time { return time.Date(2026, 7, 28, 11, 13, 0, 0, time.UTC) }
	s.WithIDs(func() map[string]string { return cur })
	return s, func(next map[string]string) { cur = next; s.invalidate() }
}

func TestPutParentChildren(t *testing.T) {
	s, _ := newTestStore(t, map[string]string{"dad": "$1", "kid": "$2"})
	if err := s.Put(Row{Session: "kid", Parent: "dad", CreatedBy: "fork", InitialCwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Parent("kid"); got != "dad" {
		t.Fatalf("Parent = %q, want dad", got)
	}
	if got := s.Children("dad"); len(got) != 1 || got[0] != "kid" {
		t.Fatalf("Children = %v, want [kid]", got)
	}
	all := s.All()
	if r, ok := all["kid"]; !ok || r.Parent != "dad" || r.InitialCwd != "/repo" || r.CreatedBy != "fork" {
		t.Fatalf("All = %+v", all)
	}
}

// 会话不在（或 tmux 盲态）→ 不写垃圾行，报错让调用方知道。
func TestPutRejectsUnknownSession(t *testing.T) {
	s, _ := newTestStore(t, map[string]string{})
	if err := s.Put(Row{Session: "ghost"}); err == nil {
		t.Fatal("解析不出 session_id 时必须报错不写")
	}
}

// 改名：主键是 session_id，父子树一点不受影响（v1 要靠 OnRename 搬主键+外键）。
func TestRenameKeepsTree(t *testing.T) {
	s, setIDs := newTestStore(t, map[string]string{"dad": "$1", "kid": "$2"})
	if err := s.Put(Row{Session: "kid", Parent: "dad"}); err != nil {
		t.Fatal(err)
	}
	setIDs(map[string]string{"dad-v2": "$1", "kid": "$2"}) // 用户 rename dad → dad-v2
	if got := s.Parent("kid"); got != "dad-v2" {
		t.Fatalf("改名后 Parent = %q, want dad-v2", got)
	}
	if got := s.Children("dad-v2"); len(got) != 1 || got[0] != "kid" {
		t.Fatalf("改名后 Children = %v", got)
	}
	if err := s.OnRename("dad", "dad-v2"); err != nil { // 只刷新名字快照
		t.Fatal(err)
	}
	if got := s.All()["kid"].Parent; got != "dad-v2" {
		t.Fatalf("All 投影 Parent = %q", got)
	}
}

// 同名复用：老会话死了、新会话叫同一个名字（新 id）→ 不继承任何旧关系。
func TestSameNameReuseDoesNotInherit(t *testing.T) {
	s, setIDs := newTestStore(t, map[string]string{"dad": "$1", "kid": "$2"})
	if err := s.Put(Row{Session: "kid", Parent: "dad"}); err != nil {
		t.Fatal(err)
	}
	setIDs(map[string]string{"dad": "$1", "kid": "$9"}) // kid 被杀后同名重建
	if got := s.Parent("kid"); got != "" {
		t.Fatalf("新会话不该继承旧 parent，got %q", got)
	}
	if got := s.Children("dad"); len(got) != 0 {
		t.Fatalf("旧行不该再算作 dad 的孩子，got %v", got)
	}
}

// OnKill 通常在会话已经被杀之后调用（tmux 里查不到 id）→ 按名字快照兜底，
// 直接孩子转为孤儿。
func TestOnKillAfterSessionGone(t *testing.T) {
	s, setIDs := newTestStore(t, map[string]string{"dad": "$1", "kid": "$2"})
	if err := s.Put(Row{Session: "kid", Parent: "dad"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(Row{Session: "dad", CreatedBy: "new"}); err != nil {
		t.Fatal(err)
	}
	setIDs(map[string]string{"kid": "$2"}) // dad 已被杀
	if err := s.OnKill("dad"); err != nil {
		t.Fatal(err)
	}
	if got := s.Parent("kid"); got != "" {
		t.Fatalf("父死后孩子应成孤儿，got %q", got)
	}
	if _, ok := s.All()["dad"]; ok {
		t.Fatal("死会话行未删除")
	}
}

func TestReconcile(t *testing.T) {
	s, setIDs := newTestStore(t, map[string]string{"dad": "$1", "kid": "$2"})
	if err := s.Put(Row{Session: "kid", Parent: "dad"}); err != nil {
		t.Fatal(err)
	}
	// tmux 盲态（alive 空）：一行不许动
	s.Reconcile(nil)
	if got := s.Parent("kid"); got != "dad" {
		t.Fatalf("盲态下不该收敛，Parent = %q", got)
	}
	// dad 被裸 tmux kill 掉：收敛后 kid 变孤儿，dad 行没了
	setIDs(map[string]string{"kid": "$2"})
	s.Reconcile(map[string]bool{"kid": true})
	if got := s.Parent("kid"); got != "" {
		t.Fatalf("收敛后 kid 应是孤儿，got %q", got)
	}
	// 名字快照跟着实况刷新（OnKill 的按名兜底依赖它）
	setIDs(map[string]string{"kid-2": "$2"})
	s.Reconcile(map[string]bool{"kid-2": true})
	db, err := sql.Open("sqlite", "file:"+s.path())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var name string
	if err := db.QueryRow(`SELECT name FROM sessions WHERE id='$2'`).Scan(&name); err != nil || name != "kid-2" {
		t.Fatalf("名字快照未刷新: %q (%v)", name, err)
	}
}

// v1 老库（会话名当主键）迁移：搬进 v2、备份留档、老表清掉；会话已消失的行丢弃。
func TestMigrateFromV1(t *testing.T) {
	dir := t.TempDir()
	writeV1(t, filepath.Join(dir, "meta.db"), []Row{
		{Session: "kid", Parent: "dad", CreatedBy: "fork", CreatedAt: "2026-07-01T00:00:00Z", InitialCwd: "/repo"},
		{Session: "dad", CreatedBy: "new", CreatedAt: "2026-07-01T00:00:00Z"},
		{Session: "ghost", CreatedBy: "fork", CreatedAt: "2026-06-01T00:00:00Z"}, // 会话早没了
	})
	s := New(dir)
	s.Now = func() time.Time { return time.Date(2026, 7, 28, 11, 13, 0, 0, time.UTC) }
	s.WithIDs(func() map[string]string { return map[string]string{"dad": "$1", "kid": "$2"} })

	all := s.All()
	if len(all) != 2 {
		t.Fatalf("迁移后应剩 2 行（ghost 丢弃）: %+v", all)
	}
	if all["kid"].Parent != "dad" || all["kid"].InitialCwd != "/repo" || all["kid"].CreatedAt != "2026-07-01T00:00:00Z" {
		t.Fatalf("迁移丢字段: %+v", all["kid"])
	}
	// 备份留档 + 老表清掉
	ents, _ := os.ReadDir(dir)
	backup := false
	for _, e := range ents {
		if len(e.Name()) > 12 && e.Name()[:12] == "meta.db.bak-" {
			backup = true
		}
	}
	if !backup {
		t.Fatalf("迁移前应备份 meta.db，目录里只有 %v", ents)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "meta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if hasTable(db, "sessions_legacy") {
		t.Fatal("迁移成功后应删掉 sessions_legacy")
	}
}

// tmux 盲态时不迁移：老数据原样留在 sessions_legacy，等下次能问出会话列表再搬。
func TestMigrateSkippedWhenBlind(t *testing.T) {
	dir := t.TempDir()
	writeV1(t, filepath.Join(dir, "meta.db"), []Row{{Session: "kid", Parent: "dad"}})
	blind := New(dir)
	blind.WithIDs(func() map[string]string { return nil })
	if got := blind.All(); len(got) != 0 {
		t.Fatalf("盲态下 v2 表应是空的: %+v", got)
	}
	db, _ := sql.Open("sqlite", "file:"+filepath.Join(dir, "meta.db"))
	if !hasTable(db, "sessions_legacy") {
		db.Close()
		t.Fatal("盲态下不许丢老数据")
	}
	db.Close()
	// tmux 恢复后自动补搬
	ok := New(dir)
	ok.WithIDs(func() map[string]string { return map[string]string{"kid": "$2", "dad": "$1"} })
	if got := ok.All(); len(got) != 1 || got["kid"].Parent != "dad" {
		t.Fatalf("恢复后应补搬: %+v", got)
	}
}

func writeV1(t *testing.T, path string, rows []Row) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE sessions(
		session TEXT PRIMARY KEY, parent TEXT, created_by TEXT, created_at TEXT, initial_cwd TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO sessions VALUES(?,?,?,?,?)`,
			r.Session, nullable(r.Parent), r.CreatedBy, r.CreatedAt, r.InitialCwd); err != nil {
			t.Fatal(err)
		}
	}
}
