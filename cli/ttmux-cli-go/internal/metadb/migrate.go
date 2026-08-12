package metadb

import (
	"database/sql"
	"errors"
	"fmt"
)

// Step 是一次 schema 演进。SQL 是纯 DDL；Fn 给那些「要先读数据才知道怎么写」的步骤
// （老表认代、旧台账收编）。两者都在同一个事务里跑——SQLite 的 DDL 是事务性的，
// 所以「建表 + 搬数据 + 盖章」要么全成要么全不成。这正是相对于原先
// 「裸 ALTER 吞错误」（plugin/store.go 的 ADD COLUMN 连 duplicate 都不判）的实质改进。
type Step struct {
	Version int
	Name    string
	SQL     string
	Fn      func(*sql.Tx, Options) error
}

// schema_meta 是账本而不是单个数字：每应用一步落一行。
// 排障时「这台机器停在哪一步、什么时候跑的」比一个裸版本号有用得多。
// 不再镜像 PRAGMA user_version —— 两个真相源必然漂。
const createSchemaMeta = `CREATE TABLE IF NOT EXISTS schema_meta(
	version    INTEGER PRIMARY KEY,
	name       TEXT NOT NULL,
	applied_at TEXT NOT NULL
)`

// Version 返回库当前的 schema 版本（没有账本表时为 0）。
func (d *DB) Version() (int, error) { return currentVersion(d.DB) }

func currentVersion(q interface {
	QueryRow(string, ...any) *sql.Row
}) (int, error) {
	var v sql.NullInt64
	if err := q.QueryRow(`SELECT MAX(version) FROM schema_meta`).Scan(&v); err != nil {
		return 0, err
	}
	return int(v.Int64), nil
}

// needsAdoptBackup 报告这是不是一个「有数据但还没被本包接管过」的老库。
// 全新空库返回 false —— 不然每台新机器都会多出一个 0 字节的 .bak。
func needsAdoptBackup(db *sql.DB) (bool, error) {
	if HasTable(db, "schema_meta") {
		return false, nil
	}
	var n int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&n)
	return n > 0, err
}

// migrate 把库推到 steps 的最后一版。
//
// 并发安全靠「事务内复核」：另一个 ttmux 进程可能刚好在做同一步（web 每 5s 拉一次
// ls --tree，撞车是常态）。谁先提交谁算数，后到的看到版本已经被盖过就让路。
// 这顶掉了原先 sessmeta 里那段「ALTER 失败就重新探测版本」的特判兜底。
func migrate(d *DB, steps []Step, opt Options) error {
	if _, err := d.DB.Exec(createSchemaMeta); err != nil {
		return err
	}
	cur, err := currentVersion(d.DB)
	if err != nil {
		return err
	}
	if len(steps) > 0 && cur >= steps[len(steps)-1].Version {
		return nil // 常态：一次 SELECT 走人
	}
	for _, st := range steps {
		if st.Version <= cur {
			continue
		}
		err := applyStep(d, st, opt)
		if errors.Is(err, ErrStepDeferred) {
			// 这一步的前提还不齐（典型：plugind 先开了库，没带 DataDir，收编没法做）。
			// 不盖章、不报错、就停在这个版本——下一次带全 Options 的 Open 会补上。
			// 因此需要外部输入的 step 必须排在最后，前面的不能被它挡住。
			return nil
		}
		if err != nil {
			return fmt.Errorf("metadb: step %d(%s): %w", st.Version, st.Name, err)
		}
	}
	return nil
}

// ErrStepDeferred 由那些「前提不齐就该往后推」的 Step 返回。见 migrate 里的处理。
var ErrStepDeferred = errors.New("metadb: 前提不齐，本步推迟")

func applyStep(d *DB, st Step, opt Options) error {
	return d.Tx(func(tx *sql.Tx) error {
		again, err := currentVersion(tx)
		if err != nil {
			return err
		}
		if again >= st.Version {
			return nil // 另一个进程赢了，让路
		}
		if st.SQL != "" {
			if _, err := tx.Exec(st.SQL); err != nil {
				return err
			}
		}
		if st.Fn != nil {
			if err := st.Fn(tx, opt); err != nil {
				return err
			}
		}
		_, err = tx.Exec(`INSERT INTO schema_meta(version,name,applied_at) VALUES(?,?,?)`,
			st.Version, st.Name, opt.now().Format("2006-01-02T15:04:05Z07:00"))
		return err
	})
}

// 版本比本二进制新时**不报错**：老 plugind 还活着、CLI 已经升级过，这种组合是真实的。
// 配套政策写在这里，改 schema 的人必须遵守：
//
//	schema 只增不改 —— 新列一律 nullable 或带默认值；不改名、不删列、不改类型。
//
// 只有这样，新旧二进制共存时旧的那个才不会读出一堆 NULL 或者干脆崩掉。
