// Package metadb 是 <dataDir>/meta.db 的唯一入口：一套连接参数、一套版本、一套迁移。
//
// 在此之前，sessmeta / swarm / plugin 三个包各写一份开库代码，同一条 DSN 抄了三遍，
// 各自用「裸 ALTER 吞错误」或「按列名猜版本」的方式演进 schema，谁也不知道谁改了什么。
// 更要命的是**没有一处开 WAL**：默认的 rollback journal 下写会整库阻塞读，而
// 并发写者早已不止一个（CLI 短操作 + 长驻 plugind + 未来的后端），
// SQLITE_BUSY 又被大量 `_, _ =` 静默吞掉，表现成「偶尔一行没写进去」。
//
// **DDL 只由 CLI 拥有。** 后端是另一个 Go module，按约定不能 import 本模块
// （原因见 backend/internal/id/id.go 的包注释），它只对已存在的库做 DML。
// 于是「谁建库、谁迁移」永远只有一个答案：ttmux。
package metadb

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// dsnArgs 是全仓唯一一份连接参数。
//
//   - journal_mode=WAL：读写不再互斥。这是并发写者不止一个之后的必需项，不是调优。
//   - _txlock=immediate：Go 的 database/sql 默认起 deferred 事务，「先读后写」会拿到
//     SQLITE_BUSY_SNAPSHOT 并**立刻**失败——它不走 busy_timeout，重试也救不回来。
//     台账里的读改写（Touch / SetPrefs / crown 状态机）全是这个形状。
//   - busy_timeout=10s：原先 5s 是按「只有一个 CLI 在写」定的。
//   - synchronous=NORMAL：WAL + NORMAL 扛得住进程崩溃（我们真正遇到的失败模式），
//     只在掉电时可能丢最后几笔；FULL 会让每次 ttmux ls 的 Reconcile 都 fsync 一遍。
const dsnArgs = "?_pragma=busy_timeout(10000)" +
	"&_pragma=journal_mode(WAL)" +
	"&_pragma=synchronous(NORMAL)" +
	"&_pragma=foreign_keys(1)" +
	"&_txlock=immediate"

// dsnNoWAL 是退路：家目录挂在 NFS/SMB 上时拿不到 WAL 需要的共享内存。
// 那时行为退回到今天（写阻塞读），但不能因此开不了库。
const dsnNoWAL = "?_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)&_txlock=immediate"

// Options 是迁移期需要的外部输入。零值可用。
type Options struct {
	// DataDir 是 JSON 台账（projects.json 等）所在目录，HomeDir 是蜂群库所在目录。
	// ROAM_DATA 可以把两者指到不同地方，所以分开传，别互相反推。
	// DataDir 为空时「收编旧台账」那一步不做也不盖章，等下一次带全 Options 的 Open 补上。
	DataDir string
	HomeDir string
	Now     func() time.Time
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// DB 嵌入 *sql.DB：调用方照旧 Query/Exec，切换到本包的 diff 只在开库那一行。
type DB struct {
	*sql.DB
	path string
	wmu  sync.Mutex // 进程内写串行；读不加锁（WAL 下读写本来就不互斥）
}

func (d *DB) Path() string { return d.path }

var (
	poolMu sync.Mutex
	pool   = map[string]*DB{}
)

// Open 返回该库的**进程级共享连接**，第一次打开时建库并迁到最新版本。
//
// 没有 Close：plugind 长驻着句柄（internal/plugin/daemon.go），而 sessmeta 是每个
// 操作开一次——只有共用一个池，才不会出现「一个包关掉了另一个包正在用的库」。
// 空闲连接不阻塞 WAL checkpoint（只有开着的读事务会），所以长期持有没有副作用。
// 进程退出即回收。
func Open(homeDir string, opt Options) (*DB, error) {
	if homeDir == "" {
		return nil, fmt.Errorf("metadb: homeDir 为空")
	}
	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		return nil, err
	}
	if opt.HomeDir == "" {
		opt.HomeDir = homeDir
	}
	return OpenFile(filepath.Join(homeDir, "meta.db"), mainSteps, opt)
}

// OpenFile 同 Open，但 schema 由调用方给——每群自己的 swarm.db 用这个入口，
// 于是「一套连接参数」是共享的，而「哪张表归谁」还留在各自的领域包里。
func OpenFile(path string, steps []Step, opt Options) (*DB, error) {
	path = filepath.Clean(path)
	poolMu.Lock()
	defer poolMu.Unlock()
	if d, ok := pool[path]; ok {
		return d, nil
	}
	sqlDB, err := openWithFallback(path)
	if err != nil {
		return nil, err
	}
	d := &DB{DB: sqlDB, path: path}
	if err := d.prepare(steps, opt); err != nil {
		sqlDB.Close()
		return nil, err
	}
	pool[path] = d
	return d, nil
}

// openWithFallback 先按带 WAL 的参数开；拿不到 WAL（网络文件系统）就退回不带的，
// 行为回到今天，不阻断。
func openWithFallback(path string) (*sql.DB, error) {
	for _, args := range []string{dsnArgs, dsnNoWAL} {
		db, err := sql.Open("sqlite", "file:"+path+args)
		if err != nil {
			continue
		}
		// 池上限 4：**不要设 1**。Rows 没读完时连接是被占住的，而 swarm.Status
		// 会在 members 循环里一边遍历 Rows 一边 exec tmux，单连接会自锁。
		// 写的串行化交给 wmu，不用连接数来拿。
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(4)
		if err = db.Ping(); err == nil {
			return db, nil
		}
		db.Close()
	}
	return nil, fmt.Errorf("metadb: 打开 %s 失败", path)
}

// prepare 接管一个库：老库先备份，再跑迁移。
func (d *DB) prepare(steps []Step, opt Options) error {
	// VACUUM INTO 不能在事务里跑，所以「接管前备份」只能在 migrate 之前做。
	// 只对**已有用户表但还没有 schema_meta** 的老库备份：全新空库不备份，
	// 免得每台新机器都多一个没用的 .bak。
	if adopting, err := needsAdoptBackup(d.DB); err == nil && adopting {
		if _, err := d.Backup(""); err != nil {
			// 备份失败不阻断迁移：老库大多能原地迁好，而拒绝启动的代价更大。
			fmt.Fprintf(os.Stderr, "ttmux: 迁移前备份失败（继续）: %v\n", err)
		}
	}
	return migrate(d, steps, opt)
}

// Exec 遮蔽内嵌的 sql.DB.Exec，把进程内的写串行掉。
func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	d.wmu.Lock()
	defer d.wmu.Unlock()
	return d.DB.Exec(query, args...)
}

// Tx 在一个事务里跑 fn。DSN 里的 _txlock=immediate 让它一开始就拿到写锁，
// 不会走到「读事务想升级成写」那个 busy_timeout 救不了的死角。
func (d *DB) Tx(fn func(*sql.Tx) error) error {
	d.wmu.Lock()
	defer d.wmu.Unlock()
	tx, err := d.DB.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Backup 落一份一致快照，dest 为空则用 <库>.bak-<时间>（沿用一直以来的命名，
// 用户和 scripts/dev/rebuild-session-history.py 都认它）。返回实际写入的路径。
//
// 用 VACUUM INTO 而不是拷文件：开 WAL 之后，最近的提交还躺在 -wal 里没 checkpoint，
// 整文件拷贝拿不到那部分——拷出来的是一份**悄悄少了几笔的库**，而备份恰恰是
// 迁移前的后悔药，最不能少笔。
func (d *DB) Backup(dest string) (string, error) {
	if dest == "" {
		dest = d.path + ".bak-" + timeStamp(time.Now())
	}
	// VACUUM INTO 拒绝写已存在的文件；同秒两次备份会撞名，加序号重试。
	target := dest
	for i := 2; i < 10; i++ {
		if _, err := os.Stat(target); os.IsNotExist(err) {
			break
		}
		target = fmt.Sprintf("%s-%d", dest, i)
	}
	d.wmu.Lock()
	defer d.wmu.Unlock()
	if _, err := d.DB.Exec(`VACUUM INTO ?`, target); err != nil {
		return "", err
	}
	return target, nil
}

func timeStamp(t time.Time) string { return t.Format("20060102-150405") }

// Discard 丢弃某个库的共享连接。只给 plugind 退出与测试收尾用——
// 常规代码不该关库（见 Open 的说明）。
func Discard(path string) error {
	path = filepath.Clean(path)
	poolMu.Lock()
	defer poolMu.Unlock()
	d, ok := pool[path]
	if !ok {
		return nil
	}
	delete(pool, path)
	return d.DB.Close()
}

// Queryer 让 Columns 既能查 *sql.DB 也能查事务里的 *sql.Tx。
type Queryer interface {
	Query(string, ...any) (*sql.Rows, error)
}

// Columns 读一张表的列集合。这是全仓唯一一份 PRAGMA table_info 读取
// （原先 sessmeta.columns 与 swarm.tableColumns 是同一份代码抄了两遍）。
func Columns(q Queryer, table string) (map[string]bool, error) {
	rows, err := q.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}

// HasTable 报告表是否存在。
func HasTable(q Queryer, name string) bool {
	rows, err := q.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name)
	if err != nil {
		return false
	}
	defer rows.Close()
	return rows.Next()
}
