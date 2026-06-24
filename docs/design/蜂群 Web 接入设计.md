# 蜂群 Web 接入设计（广场 + 看板上前端/后端）

> 状态: **设计稿，待评审**　作者: cc-swarm　日期: 2026-06-16
>
> 前置:
> - [蜂群编排设计.md](蜂群编排设计.md) —— swarm / member / master / 依赖门控（已实现，`cli/ttmux-cli/lib/swarm.sh`）
> - [蜂群广场与看板设计.md](蜂群广场与看板设计.md) —— 广场(Plaza) / 看板(Board) 概念 + CLI + §9 Web 映射草案
>
> 本文把上文 §9「Web 映射」展开为可执行的三层(CLI / Go 后端 / React 前端)落地设计。

---

## 1. 背景与动机

`ttmux-web` 控制台现在能管「会话」「任务组」「环境变量」「浏览器」，但**完全没有体现 swarm**——
蜂群、广场、看板这些蜂群协作的核心抽象只活在 CLI + 终端里。用户在 web 上看不到「任务其实是一个有目标、
有成员、有协作的集群」，更没法在 web 上读广场、看看板。

目标：**让 web 体现 swarm —— 任务升格为「集群」，可在 web 上被查看与轻量管理，能看它的广场(沟通)与看板(分工)。**
数据真源仍是 CLI（纯文本 / 每群 SQLite），后端只做透传，前端做可视化，与既有 `ttmux-web` 架构一致。

### 1.1 概念模型（钉死）

> **一个蜂群 = 一个 master cc 带着一群 member cc 干活。每个 cc 都是一个 tmux 会话。**

- **master**：会话名 `cc-<群>`，加载了 [cc-swarm skill](../skills/cc-swarm/SKILL.md) 的 Claude Code，负责拆活/派活/巡检/验收。
- **member**：会话名 `<群>-<成员>`，各自一个 Claude Code（`agent` 类型），干自己名下的活，经广场/看板协作。
- **每个节点都能「一键进入」**：web 上点任一节点 → 把该 cc 会话挂进右侧终端栏（`openTerm`），直接看/操作它的终端。
- **「任务」概念被「蜂群」取代**：底层任务组(`group`/`spawn`)仍是蜂群成员的运行机制，但 web 顶层不再暴露「任务」入口——
  蜂群就是任务的升格形态（详见 §6.1 导航改动）。

## 2. 范围与定位（已定决策）

| # | 决策 | 选择 | 影响 |
|---|------|------|------|
| 1 | 看板交互 | **真·拖拽** | 前端引入一个 DnD 库；卡片跨列拖拽 = `task move` |
| 2 | Web 管理深度 | **只读 + 广场/看板轻操作** | 见下表“能/不能” |

**Web 能做（建群 + 管理 + 协作）** —— 范围已扩展：web 现在能完整地建群与管理。
- 读：蜂群列表、详情(成员/依赖/挂起)、广场消息流、看板。
- 建群/管理：**新建蜂群 `swarm new`（默认自带 master）**、**加成员 `swarm add`**、
  标记完成 `swarm done`、解锁挂起 `swarm activate`、归档 `swarm archive`。
- 广场：发言 `say`（默认署名 `human`）。
- 看板：建卡 / 拖拽流转 `move` / 指派 `assign` / 完成 / 删卡。

**Web 仍不做**
- 彻底删除 `swarm rm`（需 tty 确认，web 用「归档」代替）、cc 接管 `swarm adopt`（建群已自带 master，无需再接管）。

> 一句话定位：**web = 蜂群的完整控制台**——建群、派活、读广场、推看板、进终端，一处搞定。

## 3. 总体架构（三层，沿用既有约定）

```
React 前端 (frontend/src)        Antd 深色主题 / hash 路由 / SSE
   │  fetch /api/swarms...
   ▼
Go 后端 (backend/api + server)   ttmux.Client 透传, 不含编排逻辑
   │  exec: ttmux swarm ... --json   (参数独立传入, 防注入)
   ▼
ttmux CLI (cli/ttmux-cli/lib)        数据真源: meta.db + 每群 swarm.db(WAL)
```

复用既有基建（不新造轮子）：
- 后端透传：`api.API.json()` / `api.API.text()` + `ttmux.StripANSI`（`backend/api/api.go`、`backend/ttmux/client.go`）。
- 实时：`stream.Hub`（`backend/stream/stream.go`，现服务 `/api/logs/:name` SSE），广场实时可复用其 SSE 模式或先用增量轮询。
- 前端：`api()` 薄封装（`frontend/src/api.ts`）、hash 路由 + `NAV`/`pages`/`ICONS`（`frontend/src/App.tsx`）、`AntApp.useApp()` 的 message/modal。
- 只读逃生口 `swarm sql <群> --json`（`swarm.sh:_swarm_sql`）已在，调试/兜底查 swarm.db 用。

## 4. 前置：补齐 CLI（board 子系统 + JSON 输出）

Web 看板依赖的 CLI **尚未实现**（`cards` 表已在 `store.sh` 建好，但无命令）。先补这一层（对应原设计 P1），
web 才有数据可吃。新增 `cli/ttmux-cli/lib/board.sh`，在 `build.sh` 的 `MODULES` 里 `plaza` 之后插入 `board`，
并在 `99-main.sh` 的 `swarm` 路由加 `board` / `task` 分支、更新 `help.sh` / `completion.sh`。

### 4.1 新增/补齐命令

```
swarm board <群> [--json]                         # 按列分组渲染看板
swarm task add    <群> "<标题>" [--desc ..] [--assignee m] [--deps t1,t2] [--col c]   # 打印新卡 id
swarm task ls     <群> [--col c] [--assignee m] [--json]
swarm task show   <群> <卡id> [--json]
swarm task assign <群> <卡id> <成员>              # 设 assignee + 移到 assigned
swarm task move   <群> <卡id> <列>                # backlog/assigned/doing/review/done/blocked
swarm task done   <群> <卡id>                     # = move ... done
swarm task rm     <群> <卡id>
```
- 存储：复用 `cards(id,title,descr,assignee,col,deps,created,updated)` 表（`store.sh:_swarm_db_init`）。
- id：卡 id 对外显示为 `t<N>`。表无 `seq` 列，用 SQLite 自增取最大：
  `'t' || (SELECT IFNULL(MAX(CAST(SUBSTR(id,2) AS INT)),0)+1 FROM cards)`。
- 转义/查询沿用 `store.sh` 的 `_sqe` / `_sql` / `_sqlj`。`--json` 走 `sqlite3 -json`。
- 列固定 6 列，不开放自定义（原设计 §11.3）。

### 4.2 给 `swarm ls` / `swarm status` 加 `--json`

现 `_swarm_ls` / `_swarm_status` 只有彩色文本；web 列表/详情需要结构化。新增：
- `swarm ls --json` → `[{name,id,goal,status,supervisor,created,total,alive,pending}]`
- `swarm status <群> --json` → `{name,goal,status,supervisor,created, members:[{name,type,task,status,done,pending,deps}], pending:[...], done_marked:[...]}`
  成员存活/状态复用既有 `_status_json`（`status.sh`）或 `_group_sessions` + `_session_exists` 拼装。

### 4.3 JSON 契约（前后端共识，字段名定死）

```jsonc
// GET /api/swarms            ← swarm ls --json
[{"name":"login","id":"2026-0616-1356-aqzq","goal":"加登录","status":"running",
  "supervisor":"cc-login","total":3,"alive":2,"pending":1}]

// GET /api/swarms/:n         ← swarm status :n --json
{"name":"login","goal":"...","status":"running","supervisor":"cc-login",
 "members":[{"name":"api","type":"agent","task":"实现登录API","status":"running","done":0,"deps":""}],
 "pending":[{"name":"web","deps":"api"}], "done_marked":["api"]}

// GET /api/swarms/:n/feed?since=12   ← swarm feed :n --json --since 12
[{"id":13,"ts":"2026-06-16 14:08:33","author":"api","kind":"done","re":null,"text":"契约定了"}]

// GET /api/swarms/:n/board   ← swarm board :n --json  (或 task ls --json 平铺, 前端按 col 分组)
[{"id":"t1","title":"认证后端","descr":"...","assignee":"api","col":"doing","deps":"","updated":"..."}]
```

### 4.4 建群自带 master（cc 指挥）

**`ttmux swarm new <群>` 创建时自动拉起一个 master cc 会话**（不再要求事后 `swarm adopt`）：
- 复用既有 `_swarm_adopt`（`swarm.sh`）逻辑：建会话 `cc-<群>` → 注入环境 → `claude '/cc-swarm --swarm <群>'`。
  `/cc-swarm --swarm` 即加载 [cc-swarm SKILL.md](../skills/cc-swarm/SKILL.md)，进入「蜂群作用域监护」。
- **master 已被告知如何操作 CLI**：SKILL.md 的「广场 + 看板」一节（L84–108）已写明
  `swarm task add/assign/move/done`、`swarm say/feed/board`、`swarm done/activate` 等命令与协作纪律——
  建群即把这套操作手册随 skill 一起加载给 master。
- 落地改动：`_swarm_new` 末尾调用 `_swarm_adopt "$name"`（或抽公共 `_swarm_bootstrap_master`）。
  加 `--no-master` 开关给「只要元数据、暂不开指挥」的场景（如纯 web 浏览/测试）。
- 注意：建 master 需要 `claude` 可执行 + tmux；缺失时降级为「只建元数据 + 提示手动 adopt」，不报错中断。
- 与 §2 范围一致：web 仍**不**触发建群/接管（那是 CLI 动作）；本节只是让 CLI 建群更省一步。

## 5. 后端 API（`backend/api/swarm.go` + `server.go` 路由）

新建 `backend/api/swarm.go`，handler 全部走 `a.json()` / `a.text()` 透传 ttmux，**零编排**（与 `api.go` 风格一致）。
在 `server.go` 受保护组 `g`（已过 `auth.Middleware`）里注册：

| 方法 & 路径 | 转发 | 类型 |
|---|---|---|
| `GET    /api/swarms` | `swarm ls --json` | 只读 |
| `GET    /api/swarms/:n` | `swarm status :n --json` | 只读 |
| `GET    /api/swarms/:n/feed?since=&kind=&n=` | `swarm feed :n --json [--since..]` | 只读 |
| `POST   /api/swarms/:n/say` | `swarm say :n --as human [--kind k] [--re id] <text>` | 轻写 |
| `GET    /api/swarms/:n/board` | `swarm board :n --json` | 只读 |
| `POST   /api/swarms/:n/task` | `swarm task add :n <title> [--desc/--assignee/--deps/--col]` | 轻写 |
| `PATCH  /api/swarms/:n/task/:id` | body `{move?:col}`→`task move`；`{assign?:m}`→`task assign`；`{col:"done"}` 走 move | 轻写 |
| `DELETE /api/swarms/:n/task/:id` | `swarm task rm :n :id` | 轻写 |

- 命名空间用 `/api/swarms`（区别既有 `/api/tasks` = 任务组），避免概念混淆。
- 路径参数 `:n` / `:id` 与 body 字段都作为**独立 argv** 传给 `ttmux`，不拼 shell，天然防注入（`client.go` 用 `exec.Command`）。
- `say` 后端固定 `--as human`（web 代发即人类发言；自动署名只在终端会话内推断成员）。
- 不注册任何 member 写路由（建群/加成员/done/activate/adopt/archive）——范围决策 §2。

## 6. 前端（`frontend/src`）

### 6.1 导航与页面骨架（改 `App.tsx`）
- **「任务」入口删除，「蜂群」替代它**：`NAV` 把 `{ key:'tasks', label:'任务' }` 换成 `{ key:'swarm', label:'蜂群' }`，
  `ICONS.swarm` 用线性节点/蜂巢图标（沿用 `svg()` 风格）。导航变为：概览 / 会话 / **蜂群** / 系统配置 / 浏览器。
- `pages` 去掉 `tasks`、加 `swarm: <Swarm openTerm={openTerm} />`；移动端底部 Tab 自动同步。
- 旧 `Tasks` / `SpawnModal` / `CollectModal` 组件及其用法移除（底层 `/api/tasks` 仍在，作为蜂群成员运行机制，不再有顶层 UI）。
- `Overview` 概览页的「任务组」卡片改为「蜂群」卡片（拉 `/api/swarms`），点进 `#/swarm`。
- 新建组件文件 `frontend/src/Swarm.tsx`（页面较大，独立成文件，像 `BrowserView.tsx`/`FileBrowser.tsx`）。

### 6.2 蜂群列表（Swarm 列表态）
- `GET /api/swarms` 轮询(3s)，卡片列表：名称 + 目标 + 状态 Tag(running/done/planning/archived 配色对应既有) + `alive/total` + `+N 待解锁` + `◆supervisor`。
- 点卡进详情。无写按钮（建群引导：提示「在终端 `ttmux swarm new`」）。

### 6.3 蜂群详情（仪表盘：拓扑 / 广场 / 看板 + 成员）
采用**响应式仪表盘**（视觉稿见 §6.5）：宽屏拓扑+广场并排在上、看板横跨在下；窄屏退化为 `[拓扑][看板][广场]` 页签。
成员信息融进拓扑节点（不再单列一个面板），重操作引导去终端。各面板数据来源：

**A. 成员 = 拓扑节点（只读，详见 §6.6）**
- `GET /api/swarms/:n` 轮询：成员渲染为**实时拓扑图**节点（名/类型/状态/依赖边/挂起），不再单列列表面板。
- 点节点 → 联动高亮该成员的看板卡 + 滚动广场到它的发言（§6.7）；节点上「终端」按钮 → `openTerm('<群>-<成员>')`。
- 重操作(标完成/解锁/接管)只读展示 + 文案引导去终端，不放按钮。

**B. 广场 (Plaza) — 聊天/动态流**
- `GET /api/swarms/:n/feed?since=<lastId>` 增量轮询(2s)，气泡按 `author`(master ◆紫 / human ●蓝 / 成员 ●绿) + `kind`(broadcast📢 / done✔ / ask? / decide◎ / block!) 色标，复用 plaza.sh 既定语义。
- 底部输入框 + kind 选择 → `POST /api/swarms/:n/say`（署名 human）。
- 实时升级：可选把 `swarm watch` 接 SSE（`stream.Hub` 模式），后续；先增量轮询足够。

**C. 看板 (Board) — 真拖拽 Kanban**
- `GET /api/swarms/:n/board` 轮询(3s)，6 列（backlog/assigned/doing/review/done/blocked）。
- **DnD 库选型**：用 **`@hello-pangea/dnd`**（react-beautiful-dnd 维护版，支持 React 18，列/卡 API 最简、最契合看板）。
  加入 `frontend/package.json` dependencies。落卡跨列 → `PATCH /api/swarms/:n/task/:id {move:<col>}`，乐观更新 + 失败回滚。
- 卡片：标题 + assignee Tag + deps 标注。卡上「指派」下拉 → `PATCH {assign}`；「+建卡」按钮 → `POST .../task`；删卡 → `DELETE`。

### 6.4 概览页点一下（可选小改）
- `Overview` 统计行可加「蜂群」计数（`GET /api/swarms` 长度），点进 `swarm` 页。低优先，先不做也行。

### 6.5 页面布局（视觉稿）

> 📐 **可在浏览器打开的高保真视觉稿**：[`mockups/swarm-dashboard.html`](mockups/swarm-dashboard.html)
> （ttmux 真实深色配色 + 真 SVG 拓扑；顶部可切「蜂群列表 / 详情仪表盘」。下面 ASCII 是同一布局的速记。）

**列表页（`#/swarm` 根）** —— 蜂群卡片栅格（Antd `Row/Col` 响应式，`xs=24 sm=12 lg=8`）：
```
┌ 蜂群                         建群请在终端: ttmux swarm new <名> ┐
├──────────────────┬──────────────────┬──────────────────┐
│ ◆ login   [running]  │ ◆ refactor [done]    │ ◆ docs   [planning]  │
│ 目标:加登录页         │ 目标:抽取支付模块     │ 目标:补 API 文档      │
│ ●●●○  3/4 活 +1待解锁 │ ✔✔  2/2 完成         │ (还没有成员)          │
│ ◆cc-login            │                      │                      │
└──────────────────┴──────────────────┴──────────────────┘
点卡 → 进详情仪表盘
```
- `●/○` 小圆点条 = 成员存活/总数；`+N待解锁` = pending 成员数；`◆xxx` = supervisor。
- 状态色沿用既有：running 黄、done 绿、planning/archived 灰（与 `App.tsx:StatusTag` 一致）。

**详情页 · 宽屏仪表盘**（容器宽 ≥ ~860px）：
```
┌ ← 蜂群   login   目标:加登录页   [running]   ◆ cc-login   3 成员·2 活·1 待解锁 ┐  ← 顶部条 + 返回
├──────────────────────────────────┬──────────────────────────────┤
│  拓扑 (实时依赖图, §6.6)            │  广场 (feed, §6.3-B)            │  ← 上排两栏
│         ┌──────────┐               │  ▎#12 ◆master 📢 开工, 各认领   │     拓扑 ~58%
│         │ ◆ master │               │  ▎#13 ●api   ✔ 契约 POST/login │     广场 ~42%
│         └────┬─────┘               │  ▎#14 ●ui    ? token 放 header? │
│       ┌──────┼──────┐              │  ▎#15 ◆master ◎ 放 Bearer       │
│       ▼      ▼      ▼              │  ─────────────────────────────  │
│   ┌─────┐┌─────┐┌──────┐           │  [全部▾] 输入消息…        [发言] │
│   │●api ││●ui  ││⏳test│           │                                │
│   │run  ││run  ││挂起   │           │                                │
│   └──┬──┘└─────┘└──────┘           │                                │
│      └───依赖──────┘ test→api       │                                │
├──────────────────────────────────┴──────────────────────────────┤
│  看板 (Kanban, 真拖拽 §6.3-C)                              [+ 建卡] │  ← 下排横跨, 6 列横向滚动
│  backlog │ assigned │ doing │ review │  done  │ blocked            │
│  ┌─────┐ │ ┌─────┐  │┌────┐ │        │        │                    │
│  │ t3  │ │ │ t2  │  ││ t1 │ │        │        │                    │
│  │@ui  │ │ │@api │  ││@api│ │        │        │                    │
│  └─────┘ │ └─────┘  │└────┘ │        │        │                    │
└────────────────────────────────────────────────────────────────────┘
```

**详情页 · 窄屏/终端停靠**（容器宽 < ~860px，含手机、桌面右侧终端展开时内容被压到 ~300px）：
```
┌ ← login  [running] ◆cc-login ─────────┐
│ [ 拓扑 ] [ 看板 ] [ 广场 ]              │  ← Segmented, 一次一视图全宽
├───────────────────────────────────────┤
│  (选中视图占满；拓扑纵向排布、看板单列纵   │
│   向滚、广场全高)                        │
└───────────────────────────────────────┘
```
- 断点判定：`Swarm.tsx` 根用 `ResizeObserver` 量**自身**宽度（而非视口），因为终端停靠会压窄内容区——
  < 860 切页签，≥ 860 仪表盘。比只看 `useBreakpoint` 更准。
- 顶部条「← 蜂群」返回列表（改 hash 或本地 state）。

### 6.6 实时拓扑视图设计（核心新增）

**渲染**：自绘 **SVG**（不引图库）——节点用圆角 chip，连线用 `<path>`，与既有 `svg()` 线性风格一致，零额外依赖。
（reactflow / d3 对这点规模是过度工程；成员数通常个位数到几十。）

**布局：分层 DAG（指挥树自上而下）**
- 第 0 层：`master`(supervisor) 居中顶部（无 supervisor 时画一个虚拟「目标」根，标 goal）。
- 成员按**依赖深度**分层：无依赖成员 = 第 1 层（master 直下）；`deps` 指向的成员所在层 +1 = 本成员层（取最深链）。
- 同层节点水平均分；列宽/行高固定，整体可横向+纵向滚动；节点过多时同层自动换行。
- 算法：对 `members` 跑一次 `deps` 拓扑分层（Kahn / 记忆化最长链深度），O(V+E)，纯前端算。

**连线**
- **指挥边**：master → 每个第 1 层成员，细/暗（dim）虚线，表「归属」。
- **依赖边**：成员 A `deps` 含 B → 从 B 画实线箭头到 A，标「依赖」；B 已完成则边变绿（下游可解锁的视觉信号）。

**节点状态 → 配色 + 动效**（数据来自 `GET /api/swarms/:n` 的 member.status/done/pending）
| 状态 | 样式 | 含义 |
|------|------|------|
| running | 绿框 + 轻微**呼吸/脉冲**动画 | 会话活跃（agent 在跑） |
| done(标记/已退出) | 绿底实心 + ✔ | 指挥已 `swarm done` 或会话结束 |
| pending(挂起) | 黄虚框 + ⏳ + `依赖→x` | 等依赖，未 spawn |
| blocked | 红框 + ! | （未来）报阻塞 |
| failed/exited≠0 | 红框 + ✕ | 异常退出 |
| master | 紫 `◆` + 加粗，置顶 | 指挥 |

**交互**
- hover 节点 → Tooltip 显示成员 `task` 全文 + 类型 + 依赖。
- **单击节点 → 打开「节点详情抽屉」（Antd `Drawer`，右侧滑出）**，集中查看这个 cc 的全部信息（见下）；
  同时进入「聚焦」态：联动高亮其看板卡、滚动广场到其发言（§6.7）。关抽屉/点空白取消聚焦。
- 实时：3s 轮询，状态变化做 200ms 颜色过渡；running 节点持续脉冲。

**节点详情抽屉（点开查看）** —— 一个节点 = 一个 cc，抽屉把它的「身份 + 实时状态 + 产出 + 沟通」聚到一处：
| 区块 | 内容 | 数据来源 |
|------|------|----------|
| 头部 | 名称 + 状态 Tag + 类型(agent/master) + 会话名(`<群>-<成员>` / `cc-<群>`) | `GET /api/swarms/:n`(成员行) |
| 任务 | `task` 全文；依赖 `deps→` / 被谁依赖 | 同上 |
| 终端快照 | 最近 N 行 capture（只读预览），按钮「进入终端 ↗」挂进右侧终端栏 | 既有 `GET /api/sessions/:sess/capture` + `openTerm` |
| 它的卡 | `assignee=该成员` 的看板卡（标题 + 列） | board 数据前端过滤 |
| 它的发言 | `author=该成员` 的广场消息 | feed 数据前端过滤 |
| Claude 对话 | 若该会话在跑 cc，复用既有 `ClaudeChat` 入口（可选） | 既有 `/sessions/:n/claude` |
- 全部复用既有 API/组件（capture / openTerm / ClaudeChat），抽屉只是把它们按「这个节点」聚合，不新增后端。
- master 节点同样可点开：看它的指挥终端 + 它在广场的 broadcast/decide。

### 6.7 跨面板联动（仪表盘的价值点）
三面板共享一个 `focusMember` 本地 state，把「拓扑/广场/看板」串成一个整体而非三张孤立表：
- 点拓扑节点 `api` → 看板只高亮 `assignee=api` 的卡（其余淡化）、广场滚动并高亮 `author=api` 的发言。
- 点看板卡 → 拓扑高亮其 `assignee` 节点。
- 这是选「仪表盘」而非「纯页签」的理由：一眼看清「谁(节点)、在做什么(卡)、说了什么(广场)」的对应。

### 6.8 视觉规范（配色 / 组件，取自既有 `App.tsx`，保持一致）

| 用途 | 色值 | 用在 |
|------|------|------|
| 最深底 / 面板内底 | `#0d1117` / `#06090d` | 页面背景 / 看板列、广场输入底 |
| 面板底 / 分隔线 | `#161b22` / `#21262d`·`#30363d` | 卡片、面板 / 描边 |
| 主文 / 次文 / 更淡 | `#e6edf3` / `#8b949e` / `#6e7681` | 标题 / 说明 / 时间戳 |
| 强调蓝 / 主按钮 | `#58a6ff` / `#1f6feb` | 链接、聚焦描边 / 发言等主操作 |
| running 黄 | `#d29922` | running 节点框 + 脉冲、status Tag |
| done 绿 | `#3fb950` | done 节点、依赖边、成员存活点 |
| 失败/阻塞 红 | `#f85149` | failed/blocked 节点、blocked 列 |
| master 紫 | `#d2a8ff` | 指挥节点、广场 master 署名 |

- 组件全用既有 Antd 体系：`Card`/`Tag`/`Segmented`/`List`/`Tooltip`/`Dropdown`/`Empty`，深色主题已配好。
- 节点 chip、看板卡、广场气泡的具体样式见视觉稿 HTML（可直接对照实现）。
- 字体：系统默认（`-apple-system, "PingFang SC", "Microsoft YaHei"`），时间戳用 `tabular-nums` 对齐。

## 7. 与既有机制的关系（不打架）
- **看板卡 ≠ 成员**（原设计 §4.3）：web 看板只动 `cards` 表，绝不触发成员 spawn / 依赖解锁。
- **成员 done / 依赖门控**：仍由指挥在终端 `swarm done`/`activate` 驱动；web 只读展示其结果。
- **松耦合**：广场/看板/成员三正交，web 不做隐式桥接（原设计 §6）。

## 8. 分阶段实施
- **S1 · CLI board + 建群自带 master**（§4）：`lib/board.sh` + `swarm ls/status --json`；`_swarm_new` 末尾 auto-adopt master(§4.4) + `--no-master`；`build.sh`/`99-main.sh`/`help`/`completion`；隔离 tmux 端到端自测。
- **S2 · 后端**（§5）：`api/swarm.go` + `server.go` 路由；`curl` 验证各端点透传正确。
- **S3 · 前端**（§6）：`Swarm.tsx` + `App.tsx` 接线 + `@hello-pangea/dnd`。
  - S3a 列表页 + 详情仪表盘骨架（响应式 ResizeObserver 断点，§6.5）；导航删「任务」换「蜂群」、移除旧 Tasks 组件、Overview 改拉蜂群（§6.1）。
  - S3b 广场面板(增量轮询发言) + 看板面板(真拖拽流转)。
  - S3c **实时拓扑 SVG**（分层 DAG + 状态配色/脉冲 + hover/点击，§6.6）。
  - S3d 跨面板联动 `focusMember`（§6.7）。
- **S4 · 打磨**：广场 SSE 实时(可选)、概览计数、空态/错误态、移动端微调。

## 9. 验证（端到端）
1. **CLI**：隔离 tmux socket 建群→建卡→拖列(move)→发言(say)→feed --json，断言 JSON 字段；沿用既有 swarm 测试方式(`tests/`)。
2. **后端**：`go build ./...`；起服务后 `curl` 走一遍 §5 路由，核对 JSON / 写操作返回。
3. **前端**：`npm run build` 通过；`start.sh --dev` 起全栈，浏览器进「蜂群」页，列表→详情→广场发言→看板拖卡，核对回写。

## 10. 残留问题（实现时按默认推进，可纠偏）
1. 看板卡 id 生成用 SQLite 取 `MAX` 自增（无 `board/seq` 文件）；并发建卡靠 WAL 事务。
2. 广场实时：先增量轮询(2s)，SSE 留 S4；超长消息体单行截断(原设计 §11.1)。
3. `say` 署名：web 固定 `human`；如要代成员发言，后续给前端一个「以 X 身份」选择（暂不做）。
4. DnD 依赖体积：`@hello-pangea/dnd` 随 antd 一并打包，可接受；若想零依赖可退化为「列下拉换列」(本方案不选)。
