// Package sessmeta 是通用 SessionMeta 数据层：meta.db 的 sessions 表。
// 只存「创建关系」等通用信息（session/parent/created_by/created_at/initial_cwd），
// 不存 worktree 字段——session↔worktree 归属由上层按 cwd 现算（设计 07 §2.1/§2.4）。
// parent 即 subSession 的 PPID：tmux 会话表保持平坦，树是本表的投影。
package sessmeta

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	HomeDir string
	Now     func() time.Time
}

type Row struct {
	Session    string `json:"session"`
	Parent     string `json:"parent,omitempty"`
	CreatedBy  string `json:"created_by,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	InitialCwd string `json:"initial_cwd,omitempty"`
}

func New(homeDir string) *Store { return &Store{HomeDir: homeDir, Now: time.Now} }

func (s *Store) path() string { return filepath.Join(s.HomeDir, "meta.db") }

func (s *Store) open() (*sql.DB, error) {
	if err := os.MkdirAll(s.HomeDir, 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+s.path()+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS sessions(
		session TEXT PRIMARY KEY,
		parent TEXT,
		created_by TEXT,
		created_at TEXT,
		initial_cwd TEXT
	)`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Put 落一行会话元数据；同名旧行整体替换（名称复用 = 旧会话已死，清历史）。
func (s *Store) Put(r Row) error {
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	if r.CreatedAt == "" {
		r.CreatedAt = s.Now().Format(time.RFC3339)
	}
	_, err = db.Exec(`INSERT OR REPLACE INTO sessions(session,parent,created_by,created_at,initial_cwd)
		VALUES(?,?,NULLIF(?,''),?,?)`,
		r.Session, nullable(r.Parent), r.CreatedBy, r.CreatedAt, r.InitialCwd)
	return err
}

// SetParent 设置/清空 parent；设置前做环检测（沿新父链上溯不得遇到 child）。
func (s *Store) SetParent(child, parent string) error {
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	if parent != "" {
		cur := parent
		for depth := 0; cur != "" && depth < 100; depth++ {
			if cur == child {
				return fmt.Errorf("parent cycle: %s is an ancestor of itself", child)
			}
			var next sql.NullString
			if err := db.QueryRow(`SELECT parent FROM sessions WHERE session=?`, cur).Scan(&next); err != nil {
				break // 无记录 = 顶层，链到头
			}
			cur = next.String
		}
	}
	// child 可能还没有行（tmux 直建的会话被收编）：UPSERT
	_, err = db.Exec(`INSERT INTO sessions(session,parent,created_by,created_at) VALUES(?,?,'adopt',?)
		ON CONFLICT(session) DO UPDATE SET parent=excluded.parent`,
		child, nullable(parent), s.Now().Format(time.RFC3339))
	return err
}

// Parent 返回会话的父（无记录/无父返回空串）。
func (s *Store) Parent(session string) string {
	db, err := s.open()
	if err != nil {
		return ""
	}
	defer db.Close()
	var p sql.NullString
	_ = db.QueryRow(`SELECT parent FROM sessions WHERE session=?`, session).Scan(&p)
	return p.String
}

// Children 返回直接子会话名。
func (s *Store) Children(parent string) []string {
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT session FROM sessions WHERE parent=? ORDER BY session`, parent)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out
}

// All 返回全表（供 ls --tree 投影）。
func (s *Store) All() map[string]Row {
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT session, IFNULL(parent,''), IFNULL(created_by,''), IFNULL(created_at,''), IFNULL(initial_cwd,'') FROM sessions`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := map[string]Row{}
	for rows.Next() {
		var r Row
		if rows.Scan(&r.Session, &r.Parent, &r.CreatedBy, &r.CreatedAt, &r.InitialCwd) == nil {
			out[r.Session] = r
		}
	}
	return out
}

// OnRename 会话改名：主键与所有引用它的 parent 外键同步更新。
func (s *Store) OnRename(old, neu string) error {
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM sessions WHERE session=?`, neu); err != nil { // 新名旧行清理
		return err
	}
	if _, err := tx.Exec(`UPDATE sessions SET session=? WHERE session=?`, neu, old); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE sessions SET parent=? WHERE parent=?`, neu, old); err != nil {
		return err
	}
	return tx.Commit()
}

// OnKill 会话死亡：直接孩子孤儿收养（parent 置 NULL），删除本行。
func (s *Store) OnKill(session string) error {
	db, err := s.open()
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE sessions SET parent=NULL WHERE parent=?`, session); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE session=?`, session); err != nil {
		return err
	}
	return tx.Commit()
}

// Reconcile 收敛残行：删除已不在 alive 集合里的会话行，并把指向死会话的
// parent 置 NULL（裸 tmux kill-session 绕过 OnKill 留下的）。
func (s *Store) Reconcile(alive map[string]bool) {
	db, err := s.open()
	if err != nil {
		return
	}
	defer db.Close()
	rows, err := db.Query(`SELECT session FROM sessions`)
	if err != nil {
		return
	}
	var dead []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil && !alive[n] {
			dead = append(dead, n)
		}
	}
	rows.Close()
	for _, n := range dead {
		_, _ = db.Exec(`UPDATE sessions SET parent=NULL WHERE parent=?`, n)
		_, _ = db.Exec(`DELETE FROM sessions WHERE session=?`, n)
	}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
