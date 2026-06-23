package swarm

import (
	"crypto/rand"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// Store is the swarm data layer: meta.db registry + per-swarm swarm.db.
// It replaces the sqlite3-CLI calls in lib/store.sh / lib/swarm.sh with the
// pure-Go driver and parameterized queries (no shell escaping, no injection).
type Store struct {
	opt Options
}

func NewStore(opt Options) *Store { return &Store{opt: opt.withDefaults()} }

// Options returns the resolved options backing this store.
func (s *Store) Options() Options { return s.opt }

func (s *Store) metaPath() string { return filepath.Join(s.opt.HomeDir, "meta.db") }
func (s *Store) swarmHome(id string) string {
	return filepath.Join(s.opt.HomeDir, "swarms", id)
}
func (s *Store) swarmDBPath(id string) string {
	return filepath.Join(s.swarmHome(id), "swarm.db")
}

var idRe = regexp.MustCompile(`^[0-9]{4}-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$`)

func isID(s string) bool { return idRe.MatchString(s) }

// NewID generates an instance id YYYY-MMDD-HHMM-<rand4> (mirrors _id_new).
func (s *Store) NewID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 4)
	if _, err := rand.Read(b); err == nil {
		for i := range b {
			b[i] = charset[int(b[i])%len(charset)]
		}
	}
	return s.opt.Now().Format("2006-0102-1504") + "-" + string(b)
}

// MetaInit ensures meta.db and the swarms table exist.
func (s *Store) MetaInit() error {
	if err := os.MkdirAll(s.opt.HomeDir, 0o755); err != nil {
		return err
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS swarms(
		id TEXT PRIMARY KEY, name TEXT UNIQUE, goal TEXT,
		status TEXT, supervisor TEXT, created TEXT)`)
	return err
}

// ResolveID maps a name-or-id to its id ("" if unknown).
func (s *Store) ResolveID(nameOrID string) string {
	if isID(nameOrID) {
		return nameOrID
	}
	if _, err := os.Stat(s.metaPath()); err != nil {
		return ""
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return ""
	}
	defer db.Close()
	var id string
	_ = db.QueryRow(`SELECT id FROM swarms WHERE name=? LIMIT 1`, nameOrID).Scan(&id)
	return id
}

// Name returns the canonical swarm name for a name-or-id.
func (s *Store) Name(nameOrID string) string {
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return ""
	}
	defer db.Close()
	var name string
	_ = db.QueryRow(`SELECT name FROM swarms WHERE name=? OR id=? LIMIT 1`, nameOrID, nameOrID).Scan(&name)
	return name
}

func (s *Store) Exists(nameOrID string) bool { return s.ResolveID(nameOrID) != "" }

// MetaGet/MetaSet read/write a swarm-level column in meta.db.
func (s *Store) MetaGet(nameOrID, col string) string {
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return ""
	}
	defer db.Close()
	var v string
	// Column name cannot be a placeholder; it is constrained to a known set.
	q := fmt.Sprintf(`SELECT IFNULL(%s,'') FROM swarms WHERE name=? OR id=? LIMIT 1`, metaCol(col))
	_ = db.QueryRow(q, nameOrID, nameOrID).Scan(&v)
	return v
}

func (s *Store) MetaSet(nameOrID, col, val string) error {
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return err
	}
	defer db.Close()
	q := fmt.Sprintf(`UPDATE swarms SET %s=? WHERE name=? OR id=?`, metaCol(col))
	_, err = db.Exec(q, val, nameOrID, nameOrID)
	return err
}

// metaCol whitelists the swarm columns to keep MetaGet/Set injection-safe.
func metaCol(col string) string {
	switch col {
	case "goal", "status", "supervisor", "created", "name", "id":
		return col
	}
	return "status"
}

// openSwarmDB opens (initializing/migrating) a swarm's per-swarm db.
func (s *Store) openSwarmDB(nameOrID string) (*sql.DB, error) {
	id := s.ResolveID(nameOrID)
	if id == "" {
		return nil, fmt.Errorf("swarm not found: %s", nameOrID)
	}
	if err := os.MkdirAll(filepath.Join(s.swarmHome(id), "logs"), 0o755); err != nil {
		return nil, err
	}
	db, err := openSQLite(s.swarmDBPath(id))
	if err != nil {
		return nil, err
	}
	if err := initSwarmDB(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSwarmDB(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func initSwarmDB(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS members(
			name TEXT PRIMARY KEY, type TEXT, task TEXT, workdir TEXT,
			status TEXT, deps TEXT, done INT DEFAULT 0, pending INT DEFAULT 0,
			model TEXT, perm TEXT,
			kind TEXT DEFAULT 'claude', role TEXT DEFAULT 'member');
		CREATE TABLE IF NOT EXISTS posts(
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT, author TEXT, kind TEXT, re INTEGER, text TEXT);
		CREATE TABLE IF NOT EXISTS cards(
			id TEXT PRIMARY KEY, title TEXT, descr TEXT, assignee TEXT,
			col TEXT DEFAULT 'backlog', deps TEXT, created TEXT, updated TEXT);`)
	return err
}

// RoleNorm normalizes role aliases (mirrors _swarm_role_norm).
func RoleNorm(role string) string {
	switch role {
	case "leader", "lead", "master":
		return "leader"
	case "member", "worker":
		return "member"
	case "":
		return ""
	default:
		return role
	}
}
