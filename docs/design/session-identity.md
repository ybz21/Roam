# 会话身份：tmux 会话名 = 会话 id，名字是展示属性

> 状态：已实现（CLI + 后端 + 前端）。
> 相关：[web/07-worktree.md §2.4](./web/07-worktree.md)（归属钉在 `#{session_id}`）、
> [swarm/蜂群 Web 接入设计.md](./swarm/蜂群%20Web%20接入设计.md)（成员会话）。

## 1. 为什么改

会话名过去一个人干两份活：**身份**（`tmux -t` 目标、`logs/<名>.log`、`meta/<名>/`、
任务组台账、蜂群点名、前端标签与 URL）和**展示文本**（用户起的名字）。两者要求相反：

- 身份要不变、唯一、无歧义 —— 但名字可以随时改，可以重名，`tmux -t` 还按前缀匹配
  （`dev` 死了 `has-session -t dev` 会命中 `dev-review`，存活判定假阳性）。
- 展示要好读 —— 中文、空格、冒号都该随便写，但它们在 tmux 目标里是特殊字符。

于是历史上出现一连串"改名要搬家"的补丁：meta.db 主键 + parent 外键搬、
session-homes 搬、group 台账搬。前面两次已经分别把 `project` 和 `sessmeta` /
`session-homes` 的主键换成不可变 id，这次把最后一块补上。

## 2. 契约

| 概念 | 载体 | 性质 |
|---|---|---|
| 会话 id | tmux `#{session_name}` | 不可变、server 内唯一、`YYYY-MMDD-HHMM-<4位>`；一切 API/WS/URL/台账的 handle |
| 展示名 label | tmux 用户选项 `@roam_name` | 可改、可重名、可中文空格；只用于展示 |

- id 由 `id.ForSession(session_created, session_id)` 派生，与 tmux 的 `$N` 一一对应、
  可反解，**和 `ls` 一直以来展示的 id 是同一个值**——老书签/URL 不失效。
- 建会话统一走 `runtime.CreateSession`：`new-session -d -P -F` 拿回 `$N`+创建时刻 →
  派生 id → `rename-session` → `set-option @roam_name <label>`。CLI 是 id 的唯一出处，
  后端不再自己拼 `tmux new-session`，改调 `ttmux new --json`。
- 展示口径统一 **`名字(id)`**：CLI 的 `ls`/`ls --tree`/各命令回显、Web 的会话行、
  终端标签、页面标题。`ls --json` 里 `name` 是 id，`label` 是展示名。
- 改名 = 只改 `@roam_name`。handle 不动 ⇒ 终端标签、URL、项目归属、meta 外键、
  logs/meta 路径、任务组台账**一个都不用搬**，重名也无所谓。

例外：`_ttmux-plugind` / `_ttmux-im` / `_ttmux-cron` 这类基础设施单例保留固定名——
它们靠固定名 `has-session` 做单例判定，id 化会破坏且没有收益。

## 3. 解析器：老用法不失效

`runtime.Resolve(token)` 把任意 handle 解析成会话名（= id），顺序：

1. 精确会话名命中
2. tmux `#{session_id}`（`$3`）命中
3. `@roam_name` 命中（多个同名取会话名最小的那个，稳定不漂）
4. 派生 id 命中（迁移前的老会话 / 老书签）

这是"全部会话都叫 id"能落地的关键：cc-swarm 技能里的 `ttmux send <群>-<成员>`、
`swarm done <群> <成员>`、文档与外部脚本里所有按语义名的调用**一行都不用改**。
台账里读出来的会话名走 `ResolveAlive`：活着就直接用（零额外 tmux 调用），
不在了才回退解析——兼容迁移前写下的按名字记的老台账。

## 4. 派生数据

`logs/<id>.log`、`meta/<id>/`、`groups/<组>.group` 的成员、蜂群 `members.session`
一律按 id 存。展示要的语义名另存：

- 任务会话：`meta/<id>/label.txt`（`<组>-<成员>`）。会话死后 `@roam_name` 随之消失，
  而 `status`/`collect` 还要显示名字，所以必须落盘。
- 蜂群成员：`members.session` 列（会话 id）。会话名不能再从 `<群>-<成员>` 推导，
  死后也要能找回它的日志/pane。
- 蜂群指挥：`swarms.supervisor` 存会话 id（展示名仍是 `cc-<群>`）。

## 5. 存量迁移

`runtime.MigrateSessionsToID()`，幂等（标记 `<dataDir>/migrations/session-id.done`），
CLI 每次启动做一次 `os.Stat` 级别的检查。对每个"名字不是 id 且不以 `_ttmux-` 开头"的活会话：

1. **先**写 `@roam_name = 原名`（保证解析器立刻能按老名字命中，迁移过程不断档）
2. `rename-session` 成派生 id
3. 搬 `logs/<原名>.log`、`meta/<原名>/`、`agents/<原名>/`、`cc-swarm/<原名>.brief.md`
4. 重写 `groups/*.group` 的成员行；蜂群 `supervisor`/`members.session`、插件会话表跟着改
   （这两个包 import 了 runtime，反过来不能，所以汇合点在 app 层）

tmux 盲态（server 没起/读不到会话）时**不迁移也不写标记**，下次再来——与 `sessmeta`
v1 迁移同一口径：宁可晚一次，也不在看不见的时候乱搬。

## 6. 已知代价

- 裸 `tmux ls` / `Ctrl-b s` 看到的是一串 id，可读性下降。想缓解可以给会话级
  `set -t <id> status-left '[#{@roam_name}] '`（当前未做）。
- 迁移瞬间，正在跑的蜂群 leader 若用**裸 tmux 命令**（而非 `ttmux`）按老名字操作会失效；
  走 `ttmux` 的调用由解析器兜住。

## 7. 实现位置

| 关注点 | 文件 |
|---|---|
| id/label/解析/建会话 | `cli/ttmux-cli-go/internal/runtime/session.go` |
| 存量迁移 | `cli/ttmux-cli-go/internal/runtime/migrate_sessions.go` + `internal/app/app.go` |
| CLI 命令接线 | `internal/command/session/*`（`ls`/`new`/`rename`/`resolve`/`fork`/`kill`/`send`） |
| 任务/蜂群/插件 | `internal/command/spawn`、`internal/command/swarm`、`internal/swarm`、`internal/plugin` |
| 后端 | `backend/api/api.go`（`newSession`/`RenameSession`）、`worktree.go`、`race.go` |
| 前端展示 | `frontend/src/session-label.tsx`（label 表 + `SessionTitle`），各页面读 `label` 字段 |
