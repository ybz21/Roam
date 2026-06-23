package swarm

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Options struct {
	HomeDir string
	DataDir string
	TmuxBin string
	Now     func() time.Time
}

type SwarmStatus struct {
	Name           string         `json:"name"`
	Goal           string         `json:"goal"`
	Status         string         `json:"status"`
	Supervisor     string         `json:"supervisor"`
	Created        string         `json:"created"`
	LeaderLastPost int64          `json:"leader_last_post"`
	Members        []SwarmMember  `json:"members"`
	Pending        []SwarmPending `json:"pending"`
	DoneMarked     []string       `json:"done_marked"`
}

type SwarmMember struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Task    string `json:"task"`
	Deps    string `json:"deps"`
	Done    int    `json:"done"`
	Kind    string `json:"kind"`
	Role    string `json:"role"`
	Status  string `json:"status"`
	Session string `json:"session"`
}

type SwarmPending struct {
	Name string `json:"name"`
	Deps string `json:"deps"`
}

type swarmMeta struct {
	ID         string
	Name       string
	Goal       string
	Status     string
	Supervisor string
	Created    string
}

func DefaultOptions() Options {
	home, _ := os.UserHomeDir()
	homeDir := os.Getenv("TTMUX_HOME")
	if homeDir == "" {
		homeDir = filepath.Join(home, ".ttmux")
	}
	dataDir := os.Getenv("TTMUX_DATA")
	if dataDir == "" {
		dataDir = filepath.Join(home, ".local", "share", "ttmux")
	}
	tmux := os.Getenv("TMUX_BIN")
	if tmux == "" {
		var err error
		tmux, err = exec.LookPath("tmux")
		if err != nil {
			tmux = "tmux"
		}
	}
	return Options{
		HomeDir: homeDir,
		DataDir: dataDir,
		TmuxBin: tmux,
		Now:     time.Now,
	}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.HomeDir == "" {
		o.HomeDir = d.HomeDir
	}
	if o.DataDir == "" {
		o.DataDir = d.DataDir
	}
	if o.TmuxBin == "" {
		o.TmuxBin = d.TmuxBin
	}
	if o.Now == nil {
		o.Now = d.Now
	}
	return o
}

// SessionNames returns the set of tmux session names that belong to swarms
// (swarm supervisors plus all group members), mirroring bash _is_swarm_session.
// Failures degrade silently to a smaller set, matching the shell behaviour of
// hiding swarm sessions only when the metadata is reachable.
func SessionNames(opt Options) map[string]bool {
	opt = opt.withDefaults()
	set := map[string]bool{}
	names := map[string]bool{}

	metaPath := filepath.Join(opt.HomeDir, "meta.db")
	if _, err := os.Stat(metaPath); err == nil {
		if db, err := openSQLite(metaPath); err == nil {
			if rows, err := db.Query(`SELECT name, IFNULL(supervisor,'') FROM swarms`); err == nil {
				for rows.Next() {
					var name, sup string
					if rows.Scan(&name, &sup) == nil {
						if name != "" {
							names[name] = true
						}
						if sup != "" {
							set[sup] = true
						}
					}
				}
				rows.Close()
			}
			db.Close()
		}
	}

	// Legacy layout: directories under DataDir/swarms also count as swarm names.
	if entries, err := os.ReadDir(filepath.Join(opt.DataDir, "swarms")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				names[e.Name()] = true
			}
		}
	}

	for name := range names {
		b, err := os.ReadFile(filepath.Join(opt.DataDir, "groups", name+".group"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				set[line] = true
			}
		}
	}
	return set
}

// Names returns the set of swarm names (meta.db registry plus legacy dirs
// under DataDir/swarms), mirroring _swarm_names. Used to hide swarm groups
// from the plain group listing.
func Names(opt Options) map[string]bool {
	opt = opt.withDefaults()
	names := map[string]bool{}
	metaPath := filepath.Join(opt.HomeDir, "meta.db")
	if _, err := os.Stat(metaPath); err == nil {
		if db, err := openSQLite(metaPath); err == nil {
			if rows, err := db.Query(`SELECT name FROM swarms`); err == nil {
				for rows.Next() {
					var n string
					if rows.Scan(&n) == nil && n != "" {
						names[n] = true
					}
				}
				rows.Close()
			}
			db.Close()
		}
	}
	if entries, err := os.ReadDir(filepath.Join(opt.DataDir, "swarms")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				names[e.Name()] = true
			}
		}
	}
	return names
}

func StatusJSON(name string, opt Options) ([]byte, error) {
	st, err := Status(name, opt)
	if err != nil {
		return nil, err
	}
	return json.Marshal(st)
}

func Status(name string, opt Options) (*SwarmStatus, error) {
	opt = opt.withDefaults()
	metaDB, err := openSQLite(filepath.Join(opt.HomeDir, "meta.db"))
	if err != nil {
		return nil, err
	}
	defer metaDB.Close()

	meta, err := findSwarm(metaDB, name)
	if err != nil {
		return nil, err
	}
	db, err := openSQLite(filepath.Join(opt.HomeDir, "swarms", meta.ID, "swarm.db"))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if err := migrateSwarmDB(db); err != nil {
		return nil, err
	}

	status := &SwarmStatus{
		Name:           meta.Name,
		Goal:           meta.Goal,
		Status:         meta.Status,
		Supervisor:     meta.Supervisor,
		Created:        meta.Created,
		LeaderLastPost: readLeaderLastPost(opt.HomeDir, meta.ID),
		Members:        []SwarmMember{},
		Pending:        []SwarmPending{},
		DoneMarked:     []string{},
	}

	rows, err := db.Query(`SELECT name, IFNULL(type,'agent'), IFNULL(task,''), IFNULL(deps,''), IFNULL(done,0), IFNULL(kind,'claude'),
		CASE IFNULL(role,'member') WHEN 'master' THEN 'leader' WHEN 'worker' THEN 'member' ELSE IFNULL(role,'member') END
		FROM members WHERE IFNULL(pending,0)=0 ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m SwarmMember
		if err := rows.Scan(&m.Name, &m.Type, &m.Task, &m.Deps, &m.Done, &m.Kind, &m.Role); err != nil {
			return nil, err
		}
		m.Session = meta.Name + "-" + m.Name
		if m.Done == 1 {
			m.Status = "done"
		} else {
			m.Status = liveStatus(opt, meta, m)
		}
		status.Members = append(status.Members, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	prows, err := db.Query(`SELECT name, IFNULL(deps,'') FROM members WHERE IFNULL(pending,0)=1 ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer prows.Close()
	for prows.Next() {
		var p SwarmPending
		if err := prows.Scan(&p.Name, &p.Deps); err != nil {
			return nil, err
		}
		status.Pending = append(status.Pending, p)
	}
	if err := prows.Err(); err != nil {
		return nil, err
	}

	drows, err := db.Query(`SELECT name FROM members WHERE IFNULL(done,0)=1 ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer drows.Close()
	for drows.Next() {
		var name string
		if err := drows.Scan(&name); err != nil {
			return nil, err
		}
		status.DoneMarked = append(status.DoneMarked, name)
	}
	return status, drows.Err()
}

func openSQLite(path string) (*sql.DB, error) {
	// busy_timeout lets concurrent readers (status) and writers (agents posting
	// to plaza/board) wait briefly for the lock instead of failing immediately.
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func findSwarm(db *sql.DB, name string) (swarmMeta, error) {
	var m swarmMeta
	err := db.QueryRow(`SELECT id, name, IFNULL(goal,''), IFNULL(status,''), IFNULL(supervisor,''), IFNULL(created,'')
		FROM swarms WHERE name=? OR id=? LIMIT 1`, name, name).
		Scan(&m.ID, &m.Name, &m.Goal, &m.Status, &m.Supervisor, &m.Created)
	if errors.Is(err, sql.ErrNoRows) {
		return m, fmt.Errorf("swarm not found: %s", name)
	}
	return m, err
}

func migrateSwarmDB(db *sql.DB) error {
	cols, err := tableColumns(db, "members")
	if err != nil {
		return err
	}
	if !cols["kind"] {
		if _, err := db.Exec(`ALTER TABLE members ADD COLUMN kind TEXT DEFAULT 'claude'`); err != nil {
			return err
		}
	}
	if !cols["role"] {
		if _, err := db.Exec(`ALTER TABLE members ADD COLUMN role TEXT DEFAULT 'member'`); err != nil {
			return err
		}
	}
	// Normalize legacy master/worker roles, but only when such rows exist — this
	// keeps the common status read lock-free instead of writing on every call.
	var legacy int
	if err := db.QueryRow(`SELECT COUNT(*) FROM members WHERE role IN ('master','worker') OR IFNULL(role,'')=''`).Scan(&legacy); err != nil {
		return err
	}
	if legacy == 0 {
		return nil
	}
	if _, err := db.Exec(`UPDATE members SET role='leader' WHERE role='master'`); err != nil {
		return err
	}
	_, err = db.Exec(`UPDATE members SET role='member' WHERE role='worker' OR IFNULL(role,'')=''`)
	return err
}

func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

func readLeaderLastPost(home, id string) int64 {
	b, err := os.ReadFile(filepath.Join(home, "swarms", id, "listeners", "leader.last_post"))
	if err != nil {
		return 0
	}
	var n int64
	_, _ = fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &n)
	return n
}

func liveStatus(opt Options, meta swarmMeta, m SwarmMember) string {
	if !tmuxHasSession(opt.TmuxBin, m.Session) {
		if _, err := os.Stat(filepath.Join(opt.DataDir, "logs", m.Session+".log")); err == nil {
			return "done"
		}
		return "exited"
	}
	dead := strings.TrimSpace(runTmux(opt.TmuxBin, "display-message", "-t", m.Session, "-p", "#{pane_dead}"))
	if dead == "1" {
		return "done"
	}
	recent := captureRecent(opt.TmuxBin, m.Session)
	flat := strings.ToLower(removeSpace(recent))
	if strings.Contains(flat, "pressenter") || strings.Contains(flat, "pressente") || strings.Contains(flat, "1.yes") ||
		strings.Contains(flat, "doyouwant") || strings.Contains(flat, "allow") || strings.Contains(flat, "approval") {
		return "waiting"
	}
	if strings.Contains(recent, "Cooking") || strings.Contains(recent, "Puzzling") || strings.Contains(recent, "Thinking") ||
		strings.Contains(recent, "Working") || strings.Contains(recent, "Running") || strings.Contains(recent, "Executing") {
		return "running"
	}
	if strings.Contains(recent, "✻") && !strings.Contains(recent, "Worked for") {
		return "running"
	}
	if !strings.Contains(recent, "Worked for") && busyRecent(opt, meta, m) {
		return "running"
	}
	if strings.Contains(recent, "❯") || strings.Contains(recent, "›") || strings.Contains(recent, "⏵⏵") || strings.TrimSpace(recent) == ">" {
		return "idle"
	}
	if m.Kind == "codex" {
		return "idle"
	}
	return "running"
}

func tmuxHasSession(bin, session string) bool {
	cmd := exec.Command(bin, "has-session", "-t", session)
	return cmd.Run() == nil
}

func runTmux(bin string, args ...string) string {
	var out bytes.Buffer
	cmd := exec.Command(bin, args...)
	cmd.Stdout = &out
	_ = cmd.Run()
	return out.String()
}

func captureRecent(bin, session string) string {
	out := runTmux(bin, "capture-pane", "-t", session, "-p", "-J", "-S", "-80")
	lines := strings.Split(out, "\n")
	if len(lines) > 18 {
		lines = lines[len(lines)-18:]
	}
	if len(lines) > 8 {
		lines = lines[len(lines)-8:]
	}
	return strings.Join(lines, "\n")
}

func removeSpace(s string) string {
	return strings.Join(strings.Fields(s), "")
}

func busyRecent(opt Options, meta swarmMeta, m SwarmMember) bool {
	b, err := os.ReadFile(filepath.Join(opt.HomeDir, "swarms", meta.ID, "busy", m.Name+".busy"))
	if err != nil {
		return false
	}
	var ts int64
	if _, err := fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &ts); err != nil {
		return false
	}
	ttl := int64(45)
	if v := strings.TrimSpace(os.Getenv("TTMUX_SWARM_BUSY_TTL")); v != "" {
		var n int64
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			ttl = n
		}
	}
	return opt.Now().Unix()-ts <= ttl
}
