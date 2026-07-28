// Package sessmeta 是通用 SessionMeta 数据层：meta.db 的 sessions 表。
// 只存「创建关系」等通用信息（parent/created_by/created_at/initial_cwd），
// 不存 worktree 字段——session↔worktree 归属由上层现算（设计 07 §2.1/§2.4）。
// parent 即 subSession 的 PPID：tmux 会话表保持平坦，树是本表的投影。
//
// 主键是 **tmux 自己的 `#{session_id}`（$3）**，不是会话名：它改名不变、server 内
// 唯一、生命周期天然等于会话。于是改名不再需要「主键 + 所有 parent 外键一起搬家」，
// 「同名复用 = 旧会话已死」也不再是靠约定，而是天然成立（新会话 = 新 id）。
// **对外 API 仍然全部收发会话名**——名字是用户和 CLI 的 handle，id 只是内部键。
//
// 老库（v1：session 名当主键）在首次打开时自动迁移：先整库备份一份 meta.db.bak-<时间>，
// 把老表改名 sessions_legacy，建空的 v2 表，再按「名字 → 现行 session_id」把行搬过去；
// 解析不出 id 的行（会话早没了）直接丢，与 Reconcile 的收敛口径一致。tmux 一时问不出
// 会话列表时不搬（宁可下次再来），sessions_legacy 原样留着，绝不在盲态下丢用户数据。
package sessmeta

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	HomeDir string
	Now     func() time.Time
	// IDs 返回 {会话名 → tmux session_id}；nil 时用默认实现（直接问 tmux）。
	// 注入点主要给测试用：真实运行里默认实现就够，任何构造 Store 的地方都能正确工作。
	IDs func() map[string]string

	names map[string]string // 本进程内的 name→id 备忘（写操作后失效）
}

// Row 一行会话元数据。Session/Parent 都是**会话名**（对外口径）。
type Row struct {
	Session    string `json:"session"`
	Parent     string `json:"parent,omitempty"`
	CreatedBy  string `json:"created_by,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	InitialCwd string `json:"initial_cwd,omitempty"`
}

func New(homeDir string) *Store { return &Store{HomeDir: homeDir, Now: time.Now} }

// WithIDs 注入会话名→id 解析器（测试用；生产用默认的 tmux 实现）。
func (s *Store) WithIDs(f func() map[string]string) *Store {
	s.IDs, s.names = f, nil
	return s
}

func (s *Store) path() string { return filepath.Join(s.HomeDir, "meta.db") }

func tmuxBin() string {
	if b := os.Getenv("TMUX_BIN"); b != "" {
		return b
	}
	return "tmux"
}

// tmuxNameToID 问 tmux 要 {会话名 → session_id}。tmux 没起/出错返回 nil——
// 调用方据此进入「盲态」：不迁移、不收敛、不写解析不出 id 的行。
func tmuxNameToID() map[string]string {
	out, err := exec.Command(tmuxBin(), "list-sessions", "-F", "#{session_name}\t#{session_id}").Output()
	if err != nil {
		return nil
	}
	m := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, id, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if ok && name != "" && id != "" {
			m[name] = id
		}
	}
	return m
}

// nameToID 取（并在本进程内缓存）会话名→id 映射。
func (s *Store) nameToID() map[string]string {
	if s.names != nil {
		return s.names
	}
	f := s.IDs
	if f == nil {
		f = tmuxNameToID
	}
	s.names = f()
	return s.names
}

// idToName 反向映射（供对外返回会话名）。盲态（问不出 tmux）返回 nil，
// 调用方据此退回表里的名字快照，而不是把「查不到」当成「会话已死」。
func (s *Store) idToName() map[string]string {
	m := s.nameToID()
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for name, id := range m {
		out[id] = name
	}
	return out
}

func (s *Store) idOf(name string) string {
	if name == "" {
		return ""
	}
	return s.nameToID()[name]
}

// invalidate 写操作后丢掉备忘（改名/新建会让映射变）。
func (s *Store) invalidate() { s.names = nil }

const createV2 = `CREATE TABLE IF NOT EXISTS sessions(
	id TEXT PRIMARY KEY,
	name TEXT,
	parent_id TEXT,
	created_by TEXT,
	created_at TEXT,
	initial_cwd TEXT
)`

func (s *Store) open() (*sql.DB, error) {
	if err := os.MkdirAll(s.HomeDir, 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+s.path()+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// ensureSchema 建 v2 表，并（在能问出会话列表时）把 v1 老行搬过来。
func (s *Store) ensureSchema(db *sql.DB) error {
	legacy, err := isLegacySchema(db)
	if err != nil {
		return err
	}
	if legacy {
		s.backup() // 迁移前整库备份一次，出岔子还能捞回来
		if _, err := db.Exec(`ALTER TABLE sessions RENAME TO sessions_legacy`); err != nil {
			return err
		}
	}
	if _, err := db.Exec(createV2); err != nil {
		return err
	}
	if hasTable(db, "sessions_legacy") {
		s.importLegacy(db)
	}
	return nil
}

func isLegacySchema(db *sql.DB) (bool, error) {
	if !hasTable(db, "sessions") {
		return false, nil
	}
	rows, err := db.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == "session" { // v1 的主键列
			return true, nil
		}
	}
	return false, nil
}

func hasTable(db *sql.DB, name string) bool {
	var n string
	err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&n)
	return err == nil
}

// backup 整库拷一份 meta.db.bak-<时间>（meta.db 里还有蜂群注册表，一起备了更安全）。
func (s *Store) backup() {
	src, err := os.Open(s.path())
	if err != nil {
		return
	}
	defer src.Close()
	dst, err := os.Create(s.path() + ".bak-" + s.Now().Format("20060102-150405"))
	if err != nil {
		return
	}
	defer dst.Close()
	_, _ = io.Copy(dst, src)
}

// importLegacy 把 v1 老行按「名字 → 现行 id」搬进 v2；成功后删掉老表。
// 问不出会话列表（tmux 没起/出错）时**什么都不做**，老表留着下次再搬。
func (s *Store) importLegacy(db *sql.DB) {
	ids := s.nameToID()
	if ids == nil {
		return // 盲态：不搬，也不删
	}
	rows, err := db.Query(`SELECT session, IFNULL(parent,''), IFNULL(created_by,''), IFNULL(created_at,''), IFNULL(initial_cwd,'') FROM sessions_legacy`)
	if err != nil {
		return
	}
	var legacy []Row
	for rows.Next() {
		var r Row
		if rows.Scan(&r.Session, &r.Parent, &r.CreatedBy, &r.CreatedAt, &r.InitialCwd) == nil {
			legacy = append(legacy, r)
		}
	}
	rows.Close()
	for _, r := range legacy {
		id := ids[r.Session]
		if id == "" {
			continue // 会话早没了：本来 Reconcile 也要删
		}
		_, _ = db.Exec(`INSERT OR IGNORE INTO sessions(id,name,parent_id,created_by,created_at,initial_cwd)
			VALUES(?,?,?,?,?,?)`,
			id, r.Session, nullable(ids[r.Parent]), r.CreatedBy, r.CreatedAt, r.InitialCwd)
	}
	_, _ = db.Exec(`DROP TABLE sessions_legacy`)
}

// Put 落一行会话元数据（按 session_id 覆盖）。解析不出 id（会话不在了/tmux 盲态）
// 就报错不写——宁可这次不记，也不能写一行对不上任何会话的垃圾。
func (s *Store) Put(r Row) error {
	s.invalidate()
	id := s.idOf(r.Session)
	if id == "" {
		return fmt.Errorf("sessmeta: 无法解析会话 %q 的 session_id", r.Session)
	}
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	if r.CreatedAt == "" {
		r.CreatedAt = s.Now().Format(time.RFC3339)
	}
	_, err = db.Exec(`INSERT OR REPLACE INTO sessions(id,name,parent_id,created_by,created_at,initial_cwd)
		VALUES(?,?,?,NULLIF(?,''),?,?)`,
		id, r.Session, nullable(s.idOf(r.Parent)), r.CreatedBy, r.CreatedAt, r.InitialCwd)
	return err
}

// SetParent 设置/清空 parent；设置前做环检测（沿新父链上溯不得遇到 child）。
func (s *Store) SetParent(child, parent string) error {
	s.invalidate()
	childID := s.idOf(child)
	if childID == "" {
		return fmt.Errorf("sessmeta: 无法解析会话 %q 的 session_id", child)
	}
	parentID := s.idOf(parent)
	if parent != "" && parentID == "" {
		return fmt.Errorf("sessmeta: 无法解析父会话 %q 的 session_id", parent)
	}
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	for cur, depth := parentID, 0; cur != "" && depth < 100; depth++ {
		if cur == childID {
			return fmt.Errorf("parent cycle: %s is an ancestor of itself", child)
		}
		var next sql.NullString
		if err := db.QueryRow(`SELECT parent_id FROM sessions WHERE id=?`, cur).Scan(&next); err != nil {
			break // 无记录 = 顶层，链到头
		}
		cur = next.String
	}
	// child 可能还没有行（tmux 直建的会话被收编）：UPSERT
	_, err = db.Exec(`INSERT INTO sessions(id,name,parent_id,created_by,created_at) VALUES(?,?,?,'adopt',?)
		ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name`,
		childID, child, nullable(parentID), s.Now().Format(time.RFC3339))
	return err
}

// Parent 返回会话的父**会话名**（无记录/无父返回空串）。
func (s *Store) Parent(session string) string {
	id := s.idOf(session)
	if id == "" {
		return ""
	}
	db, err := s.open()
	if err != nil {
		return ""
	}
	defer db.Close()
	var pid sql.NullString
	if db.QueryRow(`SELECT parent_id FROM sessions WHERE id=?`, id).Scan(&pid) != nil || pid.String == "" {
		return ""
	}
	return s.nameOf(db, pid.String)
}

// nameOf id → 会话名：以 tmux 实况为准（改名后立即正确；查不到 = 会话已死，返回
// 空串让调用方跳过这行，等 Reconcile 清）。只有盲态才退回表里的名字快照。
func (s *Store) nameOf(db *sql.DB, id string) string {
	if names := s.idToName(); names != nil {
		return names[id]
	}
	var n sql.NullString
	_ = db.QueryRow(`SELECT name FROM sessions WHERE id=?`, id).Scan(&n)
	return n.String
}

// Children 返回直接子会话名。
func (s *Store) Children(parent string) []string {
	id := s.idOf(parent)
	if id == "" {
		return nil
	}
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id FROM sessions WHERE parent_id=?`, id)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cid string
		if rows.Scan(&cid) == nil {
			if n := s.nameOf(db, cid); n != "" {
				out = append(out, n)
			}
		}
	}
	sortStrings(out)
	return out
}

// All 返回全表（key = 会话名，供 ls --tree 投影）。
func (s *Store) All() map[string]Row {
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id, IFNULL(parent_id,''), IFNULL(created_by,''), IFNULL(created_at,''), IFNULL(initial_cwd,'') FROM sessions`)
	if err != nil {
		return nil
	}
	type raw struct {
		id, parentID string
		r            Row
	}
	var all []raw
	for rows.Next() {
		var x raw
		if rows.Scan(&x.id, &x.parentID, &x.r.CreatedBy, &x.r.CreatedAt, &x.r.InitialCwd) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	out := map[string]Row{}
	for _, x := range all {
		name := s.nameOf(db, x.id)
		if name == "" {
			continue // 会话已不在（Reconcile 会清），不投影
		}
		x.r.Session = name
		if x.parentID != "" {
			x.r.Parent = s.nameOf(db, x.parentID)
		}
		out[name] = x.r
	}
	return out
}

// OnRename 会话改名：主键是 session_id，改名不需要搬家，只刷新名字快照。
func (s *Store) OnRename(old, neu string) error {
	s.invalidate()
	id := s.idOf(neu)
	if id == "" {
		return nil // 会话没了/盲态：没什么可刷的
	}
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`UPDATE sessions SET name=? WHERE id=?`, neu, id)
	return err
}

// OnKill 会话死亡：直接孩子孤儿收养（parent 置 NULL），删除本行。
// 调用时会话通常**已经被杀**，tmux 里查不到 id 了 → 退回按名字快照定位。
func (s *Store) OnKill(session string) error {
	id := s.idOf(session)
	s.invalidate()
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	if id == "" {
		_ = db.QueryRow(`SELECT id FROM sessions WHERE name=? ORDER BY created_at DESC LIMIT 1`, session).Scan(&id)
	}
	if id == "" {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE sessions SET parent_id=NULL WHERE parent_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// Reconcile 收敛残行：删除已不在 alive（会话名集合）里的行，并把指向死会话的
// parent 置 NULL（裸 tmux kill-session 绕过 OnKill 留下的）；顺带刷新名字快照。
// alive 为空（tmux 盲态）时一行不动——宁可留残行，也不能把活会话的关系抹掉。
func (s *Store) Reconcile(alive map[string]bool) {
	if len(alive) == 0 {
		return
	}
	ids := s.nameToID()
	if len(ids) == 0 {
		return
	}
	db, err := s.open()
	if err != nil {
		return
	}
	defer db.Close()
	aliveID := map[string]string{} // id → 现名
	for name, id := range ids {
		if alive[name] {
			aliveID[id] = name
		}
	}
	rows, err := db.Query(`SELECT id, IFNULL(name,'') FROM sessions`)
	if err != nil {
		return
	}
	var dead []string
	var rename [][2]string
	for rows.Next() {
		var id, name string
		if rows.Scan(&id, &name) != nil {
			continue
		}
		live, ok := aliveID[id]
		if !ok {
			dead = append(dead, id)
		} else if live != name {
			rename = append(rename, [2]string{id, live})
		}
	}
	rows.Close()
	for _, r := range rename { // 名字快照对齐实况（OnKill 的按名兜底靠它）
		_, _ = db.Exec(`UPDATE sessions SET name=? WHERE id=?`, r[1], r[0])
	}
	for _, id := range dead {
		_, _ = db.Exec(`UPDATE sessions SET parent_id=NULL WHERE parent_id=?`, id)
		_, _ = db.Exec(`DELETE FROM sessions WHERE id=?`, id)
	}
}

func sortStrings(a []string) {
	for i := 1; i < len(a); i++ { // 规模是「一个会话的直接子会话数」，插入排序足够
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
