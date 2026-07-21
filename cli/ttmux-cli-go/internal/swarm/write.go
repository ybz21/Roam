package swarm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MemberSpec is the full row spec for a swarm member.
type MemberSpec struct {
	Name    string
	Type    string // task | agent
	Task    string
	Workdir string
	Model   string
	Perm    string
	Kind    string // claude | codex
	Role    string // leader | member
	Subrole string // 细分角色 key: pm|architect|frontend|backend|qa|… (自定义原样)
	Duty    string // 长期职责（负责哪一块/产出标准）
}

// SwarmRow is one swarm in the registry listing.
type SwarmRow struct {
	ID, Name, Goal, Status, Supervisor, Created string
}

// NewSwarm inserts a planning swarm and initializes its db. Returns the id.
func (s *Store) NewSwarm(name, goal string) (string, error) {
	if err := s.MetaInit(); err != nil {
		return "", err
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return "", err
	}
	defer db.Close()
	id := s.NewID()
	_, err = db.Exec(`INSERT INTO swarms(id,name,goal,status,supervisor,created)
		VALUES(?,?,?,'planning','',?)`, id, name, goal, s.opt.Now().Format("2006-01-02 15:04:05"))
	if err != nil {
		return "", err
	}
	sdb, err := s.openSwarmDB(id)
	if err != nil {
		return "", err
	}
	sdb.Close()
	return id, nil
}

// ListSwarms returns all swarms ordered by creation.
func (s *Store) ListSwarms() ([]SwarmRow, error) {
	if err := s.MetaInit(); err != nil {
		return nil, err
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id,name,IFNULL(goal,''),IFNULL(status,''),IFNULL(supervisor,''),IFNULL(created,'') FROM swarms ORDER BY created`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SwarmRow
	for rows.Next() {
		var r SwarmRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Goal, &r.Status, &r.Supervisor, &r.Created); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HasLeader reports whether a leader/master member already exists.
func (s *Store) HasLeader(swarm string) bool {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return false
	}
	defer db.Close()
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM members WHERE role IN ('leader','master')`).Scan(&n)
	return n > 0
}

// DepGet/DepSet read/write a member's dependency list.
func (s *Store) DepGet(swarm, member string) string {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return ""
	}
	defer db.Close()
	var deps string
	_ = db.QueryRow(`SELECT IFNULL(deps,'') FROM members WHERE name=?`, member).Scan(&deps)
	return deps
}

func (s *Store) DepSet(swarm, member, deps string) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO members(name,deps) VALUES(?,?)
		ON CONFLICT(name) DO UPDATE SET deps=excluded.deps`, member, deps)
	return err
}

// MarkMemberDone / IsMemberMarkedDone / DoneList back the done column.
func (s *Store) MarkMemberDone(swarm, member string) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO members(name,done) VALUES(?,1)
		ON CONFLICT(name) DO UPDATE SET done=1`, member)
	return err
}

func (s *Store) isMarkedDone(swarm, member string) bool {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return false
	}
	defer db.Close()
	var done int
	_ = db.QueryRow(`SELECT IFNULL(done,0) FROM members WHERE name=?`, member).Scan(&done)
	return done == 1
}

// AddMemberRow upserts a launched (non-pending) member row.
func (s *Store) AddMemberRow(swarm string, m MemberSpec) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO members(name,type,task,workdir,model,perm,kind,role,subrole,duty,pending,done)
		VALUES(?,?,?,?,?,?,?,?,?,?,0,0)
		ON CONFLICT(name) DO UPDATE SET type=excluded.type,task=excluded.task,
			workdir=excluded.workdir,model=excluded.model,perm=excluded.perm,
			kind=excluded.kind,role=excluded.role,subrole=excluded.subrole,duty=excluded.duty,pending=0`,
		m.Name, m.Type, m.Task, m.Workdir, m.Model, m.Perm, m.Kind, m.Role, SubroleNorm(m.Subrole), m.Duty)
	return err
}

// SetPending upserts a member as pending (awaiting deps), storing its spec.
func (s *Store) SetPending(swarm string, m MemberSpec) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO members(name,type,task,workdir,model,perm,kind,role,subrole,duty,pending)
		VALUES(?,?,?,?,?,?,?,?,?,?,1)
		ON CONFLICT(name) DO UPDATE SET type=excluded.type,task=excluded.task,
			workdir=excluded.workdir,model=excluded.model,perm=excluded.perm,
			kind=excluded.kind,role=excluded.role,subrole=excluded.subrole,duty=excluded.duty,pending=1`,
		m.Name, m.Type, m.Task, m.Workdir, m.Model, m.Perm, m.Kind, RoleNorm(m.Role), SubroleNorm(m.Subrole), m.Duty)
	return err
}

func (s *Store) clearPending(swarm, member string) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`UPDATE members SET pending=0 WHERE name=?`, member)
	return err
}

// PendingList returns the names of members awaiting dependencies.
func (s *Store) PendingList(swarm string) []string {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT name FROM members WHERE pending=1 ORDER BY name`)
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

// pendingSpec loads the stored spec for a pending member.
func (s *Store) pendingSpec(swarm, member string) (MemberSpec, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return MemberSpec{}, err
	}
	defer db.Close()
	m := MemberSpec{Name: member}
	err = db.QueryRow(`SELECT IFNULL(type,'agent'),IFNULL(task,''),IFNULL(workdir,''),
		IFNULL(model,''),IFNULL(perm,''),IFNULL(kind,'claude'),IFNULL(role,'member'),
		IFNULL(subrole,''),IFNULL(duty,'')
		FROM members WHERE name=?`, member).
		Scan(&m.Type, &m.Task, &m.Workdir, &m.Model, &m.Perm, &m.Kind, &m.Role, &m.Subrole, &m.Duty)
	return m, err
}

// MemberDone reports completion for dependency gating: explicit done mark,
// dead pane, or a vanished session that has a log (mirrors _swarm_member_done).
func (s *Store) MemberDone(swarm, member string) bool {
	if s.isMarkedDone(swarm, member) {
		return true
	}
	sess := swarm + "-" + member
	if tmuxHasSession(s.opt.TmuxBin, sess) {
		dead := strings.TrimSpace(runTmux(s.opt.TmuxBin, "display-message", "-t", "="+sess, "-p", "#{pane_dead}"))
		return dead == "1"
	}
	_, err := os.Stat(filepath.Join(s.opt.DataDir, "logs", sess+".log"))
	return err == nil
}

// DepsSatisfied reports whether all of a member's deps are complete.
func (s *Store) DepsSatisfied(swarm, member string) bool {
	deps := s.DepGet(swarm, member)
	if strings.TrimSpace(deps) == "" {
		return true
	}
	for _, d := range strings.Split(deps, ",") {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if !s.MemberDone(swarm, d) {
			return false
		}
	}
	return true
}

// SpawnFunc launches a member session; supplied by the command layer so the
// core stays free of tmux-orchestration/agent-launch code.
type SpawnFunc func(swarm string, m MemberSpec) (bool, error)

// Activate unlocks pending members whose deps are satisfied, cascading until no
// further members launch (mirrors _swarm_activate). `only` limits to one member
// (no cascade); `force` ignores deps. Returns the number launched.
func (s *Store) Activate(swarm string, only string, force bool, spawn SpawnFunc) (int, error) {
	launched := 0
	for changed := true; changed; {
		changed = false
		for _, m := range s.PendingList(swarm) {
			if only != "" && m != only {
				continue
			}
			if !force && !s.DepsSatisfied(swarm, m) {
				continue
			}
			spec, err := s.pendingSpec(swarm, m)
			if err != nil {
				continue
			}
			ok, err := spawn(swarm, spec)
			if err != nil {
				return launched, err
			}
			if ok {
				if err := s.clearPending(swarm, m); err != nil {
					return launched, err
				}
				launched++
				changed = true
			}
		}
		if only != "" {
			break
		}
	}
	return launched, nil
}

// Migrate imports legacy file-based swarm metadata under DataDir/swarms/<name>/
// into meta.db and seeds member rows from .group files (mirrors _swarm_migrate).
// Returns the number of swarms touched.
func (s *Store) Migrate(groupSessions func(group string) []string, taskType, taskDesc func(sess string) string) (int, error) {
	if err := s.MetaInit(); err != nil {
		return 0, err
	}
	legacyRoot := filepath.Join(s.opt.DataDir, "swarms")
	entries, _ := os.ReadDir(legacyRoot)
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		dir := filepath.Join(legacyRoot, name)
		created := readFirst(filepath.Join(dir, "created.txt"))
		goal := readFirst(filepath.Join(dir, "goal.txt"))
		status := readFirst(filepath.Join(dir, "status.txt"))
		supervisor := readFirst(filepath.Join(dir, "supervisor.txt"))
		if err := s.migrateOne(name, created, goal, status, supervisor); err != nil {
			return n, err
		}
		n++
	}
	// Seed member rows from .group files for every registered swarm.
	rows, err := s.ListSwarms()
	if err != nil {
		return n, err
	}
	for _, r := range rows {
		s.migrateMembers(r.Name, groupSessions, taskType, taskDesc)
	}
	return n, nil
}

func (s *Store) migrateOne(name, created, goal, status, supervisor string) error {
	if s.ResolveID(name) != "" {
		return nil // already indexed
	}
	if created == "" {
		created = s.opt.Now().Format("2006-01-02 15:04:05")
	}
	if status == "" {
		status = "planning"
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO swarms(id,name,goal,status,supervisor,created) VALUES(?,?,?,?,?,?)`,
		s.NewID(), name, goal, status, supervisor, created)
	return err
}

func (s *Store) migrateMembers(name string, groupSessions func(string) []string, taskType, taskDesc func(string) string) {
	db, err := s.openSwarmDB(name)
	if err != nil {
		return
	}
	defer db.Close()
	supervisor := s.MetaGet(name, "supervisor")
	for _, sess := range groupSessions(name) {
		member := strings.TrimPrefix(sess, name+"-")
		role := "member"
		if supervisor != "" && sess == supervisor {
			role = "leader"
		}
		_, _ = db.Exec(`INSERT INTO members(name,type,task,role,pending,done) VALUES(?,?,?,?,0,0)
			ON CONFLICT(name) DO UPDATE SET
				type=COALESCE(NULLIF(members.type,''), excluded.type),
				task=COALESCE(NULLIF(members.task,''), excluded.task)`,
			member, taskType(sess), taskDesc(sess), role)
	}
}

func readFirst(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		return strings.TrimSpace(line)
	}
	return ""
}

// ReadQuery runs a read-only query against a swarm's db and returns the column
// names and string rows (backs `swarm sql`).
func (s *Store) ReadQuery(swarm, query string) ([]string, [][]string, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()
	rows, err := db.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	var out [][]string
	for rows.Next() {
		raw := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, nil, err
		}
		rec := make([]string, len(cols))
		for i, v := range raw {
			switch t := v.(type) {
			case nil:
				rec[i] = ""
			case []byte:
				rec[i] = string(t)
			default:
				rec[i] = fmt.Sprintf("%v", t)
			}
		}
		out = append(out, rec)
	}
	return cols, out, rows.Err()
}

// PendingCount returns how many members await dependencies.
func (s *Store) PendingCount(swarm string) int { return len(s.PendingList(swarm)) }

// Remove deletes a swarm's registry row and on-disk data.
func (s *Store) Remove(swarm string) error {
	id := s.ResolveID(swarm)
	if id == "" {
		return fmt.Errorf("swarm not found: %s", swarm)
	}
	db, err := openSQLite(s.metaPath())
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM swarms WHERE id=?`, id)
	db.Close()
	if err != nil {
		return err
	}
	return os.RemoveAll(s.swarmHome(id))
}
