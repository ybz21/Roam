package swarm

import (
	"fmt"
	"strings"
)

// Card is one board card.
type Card struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Descr    string `json:"descr"`
	Assignee string `json:"assignee"`
	Col      string `json:"col"`
	Deps     string `json:"deps"`
	Created  string `json:"created"`
	Updated  string `json:"updated"`
}

// BoardCols is the ordered set of board columns.
var BoardCols = []string{"backlog", "assigned", "doing", "review", "done", "blocked"}

// ColValid reports whether col is a known board column.
func ColValid(col string) bool {
	for _, c := range BoardCols {
		if c == col {
			return true
		}
	}
	return false
}

// ColLabel returns the Chinese label for a column (mirrors _board_col_label).
func ColLabel(col string) string {
	switch col {
	case "backlog":
		return "待办"
	case "assigned":
		return "已派"
	case "doing":
		return "进行"
	case "review":
		return "待审"
	case "done":
		return "完成"
	case "blocked":
		return "受阻"
	default:
		return col
	}
}

func (s *Store) cardExists(swarm, id string) bool {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return false
	}
	defer db.Close()
	var n int
	_ = db.QueryRow(`SELECT 1 FROM cards WHERE id=?`, id).Scan(&n)
	return n == 1
}

func (s *Store) nextCardID(swarm string) string {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return "t1"
	}
	defer db.Close()
	var id string
	_ = db.QueryRow(`SELECT 't'||(COALESCE(MAX(CAST(SUBSTR(id,2) AS INTEGER)),0)+1) FROM cards`).Scan(&id)
	if id == "" {
		return "t1"
	}
	return id
}

// CardAdd inserts a card and returns its id (mirrors _board_add).
func (s *Store) CardAdd(swarm, title, desc, assignee, deps, col string) (string, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return "", err
	}
	defer db.Close()
	id := s.nextCardID(swarm)
	_, err = db.Exec(`INSERT INTO cards(id,title,descr,assignee,col,deps,created,updated)
		VALUES(?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`,
		id, title, desc, assignee, col, deps)
	return id, err
}

// CardAssign sets assignee and promotes backlog→assigned (mirrors _board_assign).
func (s *Store) CardAssign(swarm, id, who string) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`UPDATE cards SET assignee=?,
		col=CASE WHEN col='backlog' THEN 'assigned' ELSE col END,
		updated=datetime('now','localtime') WHERE id=?`, who, id)
	return err
}

// CardMove changes a card's column. Returns the previous column.
func (s *Store) CardMove(swarm, id, col string) (string, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return "", err
	}
	defer db.Close()
	var old string
	_ = db.QueryRow(`SELECT IFNULL(col,'') FROM cards WHERE id=?`, id).Scan(&old)
	_, err = db.Exec(`UPDATE cards SET col=?, updated=datetime('now','localtime') WHERE id=?`, col, id)
	return old, err
}

// CardRemove deletes a card.
func (s *Store) CardRemove(swarm, id string) error {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`DELETE FROM cards WHERE id=?`, id)
	return err
}

// CardGet returns a single card.
func (s *Store) CardGet(swarm, id string) (Card, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return Card{}, err
	}
	defer db.Close()
	var c Card
	err = db.QueryRow(`SELECT id,title,IFNULL(descr,''),IFNULL(assignee,''),col,IFNULL(deps,''),created,updated
		FROM cards WHERE id=?`, id).Scan(&c.ID, &c.Title, &c.Descr, &c.Assignee, &c.Col, &c.Deps, &c.Created, &c.Updated)
	return c, err
}

// CardExists reports whether a card id exists.
func (s *Store) CardExists(swarm, id string) bool { return s.cardExists(swarm, id) }

// Cards lists cards with optional column/assignee filters, ordered by id.
func (s *Store) Cards(swarm, col, who string) ([]Card, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	where := "1=1"
	var args []any
	if col != "" {
		where += " AND col=?"
		args = append(args, col)
	}
	if who != "" {
		where += " AND assignee=?"
		args = append(args, who)
	}
	rows, err := db.Query(`SELECT id,title,IFNULL(descr,''),IFNULL(assignee,''),col,IFNULL(deps,''),created,updated
		FROM cards WHERE `+where+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Card
	for rows.Next() {
		var c Card
		if err := rows.Scan(&c.ID, &c.Title, &c.Descr, &c.Assignee, &c.Col, &c.Deps, &c.Created, &c.Updated); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ColCount returns the number of cards per column for the given swarm.
func (s *Store) ColCount(swarm string) (map[string]int, int, error) {
	db, err := s.openSwarmDB(swarm)
	if err != nil {
		return nil, 0, err
	}
	defer db.Close()
	counts := map[string]int{}
	total := 0
	rows, err := db.Query(`SELECT IFNULL(col,'backlog'), COUNT(*) FROM cards GROUP BY col`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		var n int
		if err := rows.Scan(&c, &n); err != nil {
			return nil, 0, err
		}
		counts[c] = n
		total += n
	}
	return counts, total, rows.Err()
}

// validateCol returns an error message if col is invalid.
func validateCol(col string) error {
	if !ColValid(col) {
		return fmt.Errorf("列只能是: %s", strings.Join(BoardCols, " "))
	}
	return nil
}
