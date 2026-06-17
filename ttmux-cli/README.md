# ttmux-cli — ttmux 的模块化源码

根目录的 `ttmux` 是**单文件分发版**（install.sh / `curl | bash` 直接装这一个文件）。
但单文件太长不好维护，所以源码按模块拆在这里，用 `build.sh` 拼回单文件。

## 工作流

```bash
# 1. 改模块
vim ttmux-cli/lib/agent.sh

# 2. 重新生成根目录的 ttmux
bash ttmux-cli/build.sh

# 3. （可选）安装到 ~/.local/bin
bash install.sh
```

> ⚠ **不要手改根目录的 `ttmux`**——它是 `build.sh` 的生成物，下次 build 会被覆盖。
> 所有改动都在 `ttmux-cli/lib/*.sh` 里做。

## 模块（拼接顺序）

| 顺序 | 文件 | 内容 |
|------|------|------|
| 1 | `lib/00-header.sh` | shebang / 版本 / 目录变量 / `set -euo pipefail` |
| 2 | `lib/core.sh` | 颜色、图标、辅助函数、JSON 输出 |
| 3 | `lib/env.sh` | 全局环境变量 (`env set/rm/push` …) |
| 4 | `lib/group.sh` | 任务组管理 + 任务元数据（统一 cmd / agent） |
| 5 | `lib/status.sh` | `info` / `status` / 状态 JSON |
| 6 | `lib/spawn.sh` | `spawn` 批量创建并行任务 |
| 7 | `lib/capture.sh` | `capture` 捕获会话输出 |
| 8 | `lib/wait.sh` | `wait` 等待任务完成 |
| 9 | `lib/collect.sh` | `collect` 收集输出 |
| 10 | `lib/agent.sh` | 多 Claude Agent 编排 |
| 11 | `lib/swarm.sh` | **蜂群编排**：成员/依赖门控 + 广场 + 看板（见下） |
| 12 | `lib/completion.sh` | Tab 补全安装 |
| 13 | `lib/help.sh` | 帮助文本 |
| 14 | `lib/interactive.sh` | 交互模式（菜单 + 各交互子流程） |
| 15 | `lib/99-main.sh` | 主入口 / 命令分发 |

> 广场(plaza)与看板(board)的函数集中在 `lib/swarm.sh`（`_plaza_*` / `_board_*` 前缀）。
> 若该文件过大可再拆出 `lib/plaza.sh`、`lib/board.sh`，插在 `swarm` 之后、`completion` 之前，
> 并同步 `build.sh` 的 `MODULES` 数组。

拼接顺序写死在 `build.sh` 的 `MODULES` 数组里（`00-header` 必须最前、`99-main` 必须最后）。
新增模块时在数组里插到合适位置即可。

## 为什么根 `ttmux` 仍在 git 里

`install.sh` 的 GitHub 路径会 `curl .../ttmux`，所以**生成物必须提交**，不能 gitignore。
即：每次改完模块、`build.sh` 重新生成后，连同 `ttmux` 一起提交。

## 蜂群 swarm 命令参考（实现规格）

> 设计与理由见 [`docs/design/蜂群编排设计.md`](../docs/design/蜂群编排设计.md) 与
> [`docs/design/蜂群广场与看板设计.md`](../docs/design/蜂群广场与看板设计.md)。本节是**落地到 CLI 的命令清单**，
> 即 `lib/swarm.sh` 要实现的全部子命令；实现后同步 `lib/help.sh` 与 `lib/completion.sh`。
>
> 一句话模型：**多个智能体(成员)通过「广场+看板」协作；有且只有一个「主控 master」负责拆任务、派活。**
> human 给目标/拍板，master 拆解+分配+调度+验收，成员执行+沟通。

### 落盘布局（定稿 · SQLite）

基目录 **`~/.ttmux`**。存储 = **shell CLI + SQLite**（CLI 仍 bash，调 `sqlite3`）。
**混合拓扑**：一个全局索引库 + 每个蜂群一个库；日志走文件；tmux 是活的运行时（不进库）。

```
~/.ttmux/
├── meta.db                          # 全局索引(sqlite): 跨群列表 / name→id / 状态
└── swarms/
    └── 2026-0616-1357-bxkp/         # 每蜂群一文件夹; id = YYYY-MMDD-HHMM-<随机4位>
        ├── swarm.db                 # 每群库(sqlite): members / posts(广场) / cards(看板)
        └── logs/<成员>.log          # 成员终端输出(文件)
```

> 本轮**先只蜂群进库**；普通会话(`ttmux new/ls/kill`)暂留现状，后续再迁 `sessions/<id>/` + meta.db。

**职责划界**：**库=元数据与协作记录；tmux=活的运行时(`has-session`/`pane_dead`)；文件=日志流。**

`meta.db`（全局索引）：
```sql
CREATE TABLE swarms(
  id TEXT PRIMARY KEY,              -- 2026-0616-1357-bxkp
  name TEXT UNIQUE, goal TEXT,
  status TEXT, supervisor TEXT, created TEXT);
```

`swarms/<id>/swarm.db`（每群库）：
```sql
PRAGMA journal_mode=WAL;            -- 多 agent 并发写安全
CREATE TABLE members(               -- 成员 + 依赖门控(pending/done 变成列)
  name TEXT PRIMARY KEY, type TEXT, task TEXT, workdir TEXT,
  status TEXT, deps TEXT, done INT DEFAULT 0, pending INT DEFAULT 0,
  model TEXT, perm TEXT);
CREATE TABLE posts(                 -- 广场
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, author TEXT, kind TEXT, re INTEGER, text TEXT);
CREATE TABLE cards(                 -- 看板
  id TEXT PRIMARY KEY, title TEXT, descr TEXT, assignee TEXT,
  col TEXT DEFAULT 'backlog', deps TEXT, created TEXT, updated TEXT);
```

**约定**：
- **CLI 命令即 CRUD**：领域命令(下方)背后是 `INSERT/SELECT/UPDATE/DELETE`；`name→id` = `SELECT id FROM swarms WHERE name=?`。
- **`--json` 免费**：一律走 `sqlite3 -json`。web(Go) 可 `database/sql` 直接读同一库，不必 `exec` CLI。
- **逃生口**：`ttmux swarm sql <群> "SELECT ..."`（只读守卫）给 web/调试用。
- **SQL 转义**：bash 拼 SQL 用 `esc(){ printf %s "$1" | sed "s/'/''/g"; }`（单引号翻倍），防注入。
- **依赖守卫**：`command -v sqlite3` 缺失则提示 `apt/brew install sqlite3`。
- `archive` = `UPDATE swarms SET status='archived'`(软删) + kill 会话；`rm` = 删 `<id>/` 文件夹 + `DELETE FROM swarms`。
- **名 / id 都能定位**：参数先按 id 正则判断，否则当 name 查 meta.db。

### 成员 / 依赖门控（既有，已实现）

```
swarm new <名> [--goal "..."]                  swarm ls
swarm add <群> <成员> --type task|agent [--dir/--perm/--model] [--depends-on a,b] <命令或任务>
swarm status <群>                              swarm collect <群> [--json]
swarm activate <群> [成员] [--force]            swarm done <群> [成员]
swarm adopt <群> [--by <cc会话>]                swarm archive|rm <群>
```

### 广场（plaza）— 待实现　`_plaza_*`

```
swarm say   <群> [--as <成员>] [--kind note|ask|block|decide|done|broadcast] [--re <id>] <消息>
            # 发言。author 默认按当前 tmux 会话名自动署名：<群>-<成员>→成员, cc-<群>→master, 否则 human。
swarm feed  <群> [-n <N>] [--from <成员>] [--kind <类型>] [--since <id>] [--json]
            # 读流。默认末 30 条；--since <id> 取该 id 之后（增量轮询/巡检用）。
swarm watch <群>                               # 实时跟随（轮询 posts 表 WHERE id>上次 + 渲染），master 盯场 / web SSE。
```

### 看板（board）— 待实现　`_board_*`

```
swarm board <群> [--json]                      # 渲染看板：按列分组（backlog/assigned/doing/review/done/blocked）
swarm task add    <群> "<标题>" [--desc ..] [--assignee <成员>] [--deps t1,t2] [--col <列>]   # 建卡, 打印卡 id
swarm task ls     <群> [--col <列>] [--assignee <成员>] [--json]
swarm task show   <群> <卡id>
swarm task assign <群> <卡id> <成员>            # 派活：设 assignee + 自动移到 assigned（只 master 用）
swarm task move   <群> <卡id> <列>              # 流转；swarm task done <群> <卡id> = move ... done 快捷
swarm task rm     <群> <卡id>
```

### 实现要点

- **正交 + 显式桥接**：广场/看板/成员门控三套独立，不隐式联动；串联由 master(cc-swarm skill) 显式做。
  可选便捷桥接（默认关闭）：`swarm done <群> <成员> --with-cards`、`swarm task assign ... --spawn`、`TTMUX_BOARD_NOTIFY=1`。
- **命名消歧**：`swarm done`(成员/整群) vs `swarm task done`(卡片)；`swarm add`(成员) vs `swarm task add`(卡片)，分属不同命名空间。
- **存储引擎**：SQLite（`meta.db` + 每群 `swarm.db`，WAL 并发安全）；`--json` 走 `sqlite3 -json`；并发写靠 WAL，不用 flock。
- **路由**：`lib/99-main.sh` 的 `swarm)` 分支加 `say|feed|watch|board|task|sql` 子命令；`task` 再二级分发 `add|ls|show|assign|move|done|rm`。
- **新模块**：`lib/store.sh`（sqlite3 守卫 + `_id_new` + `_meta_db`/`_swarm_db` schema 初始化 + `_sql`/`_sqlj` 封装 + `name→id` 解析），插在 `core` 之后。

## 校验

`build.sh` 末尾会自动 `bash -n` 语法自检。生成后可再跑一遍冒烟测试：

```bash
./ttmux help | head
./ttmux ls
```
