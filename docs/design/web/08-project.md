# 08 · 项目（Project）概念设计

← 返回 [README](./README.md) ｜ worktree 底层见 [07-worktree](./07-worktree.md)

> 状态：设计提案 v0.1 — 未实现，先出交互图纸。
> 背景：07 落地后，同一仓库下「顶层会话 + 派生子会话 + 一堆 worktree」已经事实上构成
> 一个工作单元，但导航仍是平坦会话列表 + 管理抽屉。本篇把这个事实**提升为一等导航概念：
> 项目（Project）**，对照 Codex 的 project/task 模型重排信息架构。
> 高保真图纸：[08-project/index.html](./08-project/)。

## 1. 动机

现状（07 全落地后）的三个别扭：

1. **容器错位**。用户的心智是「我在 ttmux 这个项目里开了 5 个任务」，但 UI 给的是
   「全局会话列表里有一个 ttmux 分组」——仓库只是行的分组头，不是可进入、可停留的**地方**。
2. **任务生命周期比会话短命**。会话关掉后任务其实没完（worktree 还有未合并提交），
   但它从会话列表消失，只能去管理抽屉里找「孤儿」——收尾动作没有自然的回访路径。
3. **新任务入口太重**。W1 弹窗五个字段，其中「目录」在项目语境下是废问——你已经在这个
   项目里了。Codex 的正确答案是：项目主页顶部一个 composer，描述任务，回车开干。

## 2. 概念模型

**核心心智：任务驱动。** 项目页的主语从「会话/终端」换成「任务」——composer 生产任务、
任务流呈现任务、收尾终结任务；worktree 和命令行（会话/终端）降为任务的**物理载体**，
以资源视角从属存在（Worktree tab / P4）。用户默认只跟任务打交道：描述 → 观察 → review →
合并；只有要动手（跑测试、接管 agent、开多个终端）时才下钻到载体层。两个视角互为投影，
数据同源（§2.2），没有第三份状态。

### 2.1 项目 = 目录（git 可选，v0.2 修订）

**不是**「顶层会话 = 项目」：顶层会话可关闭、可多开；目录才是稳定容器。项目**不与 git
绑定**：任意目录都可以是项目（目录 + 会话）；目录是 git 仓库时归位 canonical 主仓库根，
并开启 worktree / 编队 / 活动 等 git 能力。非 git 项目的会话归属按 pane cwd 目录前缀
现算（git 项目按 §2.4 annotation，更精确、优先认领）。

- **发现 = 现算 ∪ 弱台账**：项目列表 = 「全部会话 pane cwd join（07 §2.4）∪ knownRepos
  逐仓库 worktree 扫描」。repo 身份 = canonical common-dir（07 §2.3 规则不变）。
  **不能只靠会话现算**：现有 `GET /git/worktrees/all` 只枚举「当前会话触达的仓库」，
  仓库最后一个会话关掉后，留着未合并提交的孤儿 worktree 就没有任何来源能再发现它——
  「待收尾/复活」入口直接消失。
- 因此项目在 `<dataDir>/projects.json` 里是**存储对象**，有两条入册通道（v0.2 修订：
  实现期用户反馈——「建的是项目不是 session」，新项目必须是后台一等对象）：
  - **显式创建（origin=user）**：`POST /projects {dir, displayName?}`，目录经 ResolveRepo
    校验并归位主仓库根，非 git 目录拒绝。**永不自动退场**，只能 `DELETE /projects/:key`
    显式移除（纯台账操作，不动目录/worktree/会话）。开 session、建 feature 是进项目
    之后 composer 的事，创建项目本身不建任何会话。
  - **发现（origin=discovered）**：会话 cwd join 命中即自动记入；移出仅当 **(a)** 仓库
    目录已不存在，或 **(b)** 不存在任何 roam worktree（clean/已合并未清理的也算存在）
    **且**无会话**且**未置顶。同文件顺带存 UI 偏好（置顶、默认 agent/base、自定显示名）。
  git/session 真相源不变；台账丢失只损失「零会话仓库的可发现性」，活跃仓库下次开会话即重建。
- cwd 不在任何 git 仓库的会话 → 「散会话」区，保留原会话语义，不强造项目。

### 2.2 任务 = 会话 ∪ 孤儿 worktree 的统一投影（读模型，非新实体）

一个任务的物理载体随生命周期变化，但任务本身应当持续可见：

```
阶段      物理载体                      任务流里的样子
──────    ─────────────────────────    ─────────────────────────
干活中    会话(活) + worktree           ● running / ◐ waiting / ○ idle
待收尾    会话已关，worktree 有未合并    ◌「会话已关」+ 高亮 [收尾] [复活]
已合并    worktree 干净或 base 已含      ✓ merged，可一键清理
完结      worktree 已删                  从任务流消失（活动 tab 留收尾痕，见 §3）
```

- 投影规则：任务集合 = 项目内全部会话（按 竞赛 > 蜂群 > parent 树 > 平铺 组织）
  **∪** 无会话占用的 worktree（孤儿/外部，07 W4 四态徽章语义照搬）。
- **蜂群也是给项目服务的**：蜂群 = 项目内的编队任务组，成员会话按 ⬡ 组头聚合进任务流
  （组头 → 蜂群页做编排/验收，项目页只是作战地图）；跨仓库蜂群在每个项目只列落在本仓库的
  成员并标「成员 n/N」。业务归属真相仍在 swarm.db（07 §2.2 parent ≠ 业务归属），
  项目层零写入、纯投影——竞赛与蜂群在 P2 统一收进「编队」tab。
- 主仓库里的会话（没进 worktree）也是任务，只是没有 ⎇ 分支徽章与收尾语义。
- **没有 task 表**。全部由 `sessions tree + worktrees + races` 三个现有读模型 join 得出；
  「待收尾」= 07 已有的孤儿判定 + committedAhead>0。

### 2.3 与 Codex 对照

| | Codex | Roam |
|---|---|---|
| project | repo + cloud 环境 | 本地 git 仓库（现算，无注册流程） |
| task | 一次性云容器跑完出 diff | 长活会话 + worktree，可进终端接管 |
| 新任务 | 项目页 composer，回车即跑 | 同款 composer = `POST /worktree-sessions` |
| 收尾 | diff → PR | 对比 base → merge/squash/rebase 或 PR（07 §2.3） |
| 任务残留 | 云端自动回收 | worktree 留存 → 「待收尾」一等展示（我们的差异化） |

### 2.4 导航变化

- Sider「会话」→「**项目**」，默认落项目列表（P1）。
- 全局平铺会话视图**保留**：P1 顶部 Segmented「项目 | 全部会话」，后者即现有 W2 页面，
  老心智不破坏。
- 项目主页（P2）成为仓库语境的**驻留页**：composer + 任务流 + Worktree/竞赛/活动 tab。
  W4 抽屉、W6 对比台降级为项目主页的 tab/入口，跨仓库总览由 P1 承担。
- 终端顶部加面包屑 `项目 › 任务`，一键跳回项目主页。

## 3. 页面（图纸见 [08-project/](./08-project/)）

| 图版 | 内容 |
|---|---|
| [P1 项目列表](./08-project/p1-project-list.html) | 卡片网格：主干同步态、任务/worktree/待收尾计数、进行中任务前 2 条、7 日活动 spark、散会话区；「项目 \| 全部会话」视图切换 |
| [P2 项目主页](./08-project/p2-project-home.html) | 核心页：Codex 式 composer（需求 textarea + 在哪干活 pill + Agent pill，⏎ 开干）+ 任务流（生命周期 stepper、parent 树缩进、竞赛组、待收尾/已合并分区）+ Worktree/竞赛/活动 tab |
| [P3 任务收尾](./08-project/p3-task-finish.html) | 待收尾任务抽屉：损失清单（↑n 未合并 · 改动 n）+ 对比 base 文件列表 + 三选一（合并并删除 / 复活会话 / 丢弃删除），复用 07 W4/W7 的全部安全语义 |
| [P4 Worktree × 命令行](./08-project/p4-worktree-terminals.html) | 资源视角（P2 Worktree tab 的完整交互）：worktree 行可展开列出全部派生命令行（agent 会话与裸 shell 同列，带终端尾行预览），「＋ 新开命令行」三选，进入 → 停靠终端 + 面包屑；孤儿展开即复活、外部即收编 |
| [P5 蜂群 × 项目](./08-project/p5-swarm-in-project.html) | 蜂群的项目内体现（编队卡展开：成员/职责/看板计数/广场尾声）与发起动线（目录预填 + 班子建议与 worktree 约定写进指挥开场白），零新增编排 API |
| [P6 概览重构](./08-project/p6-overview.html) | 概览从会话/蜂群双栏转为**项目为主**：「需要你」横幅置顶（跨项目 待输入/待收尾/待解锁）+ 统计条 + 活跃项目作战卡（内嵌任务前 3/⬡ 蜂群摘要/待收尾黄条）+ 散会话·最近活动双列；无活动项目不上概览（提案，待确认后实现） |

关键交互细节：

- **composer**：默认「新建 worktree」pill（base = 本地主干，缺省规则同 W1 修订 5）；
  名称自动从需求派生（W1 修订 3）；「展开完整表单 ›」回落 W1 弹窗改高级项。
  提交即 `POST /worktree-sessions`，创建零等待，行内出现新任务并进入会话。
- **生命周期 stepper**：任务行 meta 里 4 段微导轨 `建→干→审→并`
  （cyan → green → yellow → purple），一眼扫出每个任务走到哪一步；hover 出阶段说明。
- **待收尾分区**：默认折叠为一行黄条「2 个任务待收尾」，展开逐行 [收尾]（→P3）
  [复活]（= W1「已有 worktree」档语义，`POST /worktree-sessions` 指向既有 worktree）。
- **活动 tab = git log ∪ 收尾留痕**：现存 worktree/主仓库的 git log 汇总，加上收尾时落盘的
  留痕条目（任务名/分支/headOid/base/策略/±行数/时间，见 §4）。「丢弃删除」后的提交不可达，
  **只剩留痕摘要，不承诺可恢复**；squash 合并同理靠留痕保住 任务→合并提交 的映射。
- **蜂群在项目里（P5）**——体现三层 / 使用四步：
  - 体现：P1 卡片 ⬡ 计数 → P2 任务流 ⬡ 编队组（成员即任务行）→ 编队 tab 蜂群卡展开
    （成员/subrole/看板列计数/广场最后一条）。数据 = `GET /swarms/:n` + board/feed +
    cwd join（成员会话落在哪个 worktree），**零新增编排 API**。
  - 发起：编队 tab「＋ 新建蜂群…」——目录预填 = 项目仓库，目标 textarea，班子建议 chips
    （`GET /swarm/subroles`），「成员各自独立 worktree」默认勾选。提交 = 一次
    `POST /swarms`：班子与 worktree 约定**只写进指挥开场白**（同 W1 命名约定手法），
    拆任务/建成员/派活的编排权留给指挥（cc-swarm 全生命周期）。
    **创建动线的字段级/编排级完整设计见 [09-swarm-in-project](./09-swarm-in-project.md)**。
  - 干活中：成员行「进入」下钻终端；「给指挥发话」= `POST /swarms/:n/say`（广场署名
    human）；编排动作（加人/流转/验收）一律跳蜂群台，项目页不代做。
  - 完成与集成：done 判定只认指挥显式 `swarm done`（项目页不代标）；done 后成员行变
    「待集成」，worktree 合并建议走蜂群台集成验收；若在 P3 单独收尾，提示
    「该 worktree 属蜂群 <名>」。跨仓库成员在本项目置灰只留跳转，防双处操作。
- **worktree × 命令行（P4）**：一个 worktree 下可挂多条命令行——agent 会话与裸 shell 同列
  （挂靠 = cwd join 实况：cd 走自动离组、cd 进自动入列；多 pane 命中多 worktree 显 ⚠ 歧义
  标记，hover 列全部 matches）。行内终端尾行预览只读（capture-pane，懒加载）；
  「＋ 新开命令行」三选：shell = `ttmux new --dir <worktree>`（命名 `<分支>-sh` 自动后缀），
  Claude/Codex = `POST /worktree-sessions`「已有」档——孤儿复活与外部收编是同一动作的特例。
  「进入」→ 停靠终端（手机全屏），工具栏面包屑 `项目 › ⎇ 分支 › 命令行`；worktree 删除按钮
  在有命令行挂靠时置灰（占用检查前置到 UI，后端 Remove 仍兜底）。
- **手机端**：P1 卡片纵排；P2 composer 收成底部输入条「＋ 描述新任务…」，任务流为主。

## 4. API（读模型聚合 + 一个新增组合写接口）

| 接口 | 说明 |
|---|---|
| `GET /projects` | 聚合：knownRepos（§2.1 台账）逐仓库 worktree 扫描 + `ttmux ls --tree` cwd join（顺带把新命中的仓库记入发现通道）+ races 计数 + 最近活动（worktree HEAD 时间的 max）|
| `POST /projects` | 显式创建项目对象（origin=user，永不自动退场）；`{dir, displayName?}`，非 git 目录报 `NOT_GIT_REPO` |
| `DELETE /projects/:key` | 显式移除（纯台账，不动目录/worktree/会话；有会话的仓库会被发现通道重新记入——列表反映实况）|
| `GET /projects/:repoKey` | 单仓库详情：任务投影（§2.2）+ worktree 列表 + races + 活动流（各 worktree `git log --since` 汇总 + 收尾留痕，带缓存）|
| `PATCH /projects/:repoKey/prefs` | UI 偏好（置顶/默认 agent/默认 base），落 projects.json；knownRepos 由发现流程自动维护，无手动接口 |
| `POST /git/worktree/finish` | **新增组合 API（P3 合并档）**：复用 close-with-worktree 的状态机、去掉 kill 步——**冻结校验 expectedHead**（用户确认时的 source HEAD，此刻校验后即失效）→ CommitAll wip-commit → merge（用 wip 后的新 HEAD 内部传递，**不把旧 expectedHead 传给 merge**——wip-commit 合法挪 HEAD，同 W6 crown 语义，否则必然 `HEAD_MOVED`；base 侧 OID 仍在 merge 步校验）→ remove，失败停在可恢复阶段。必须新增：`/git/worktree/merge` 对脏树返回 `WORKTREE_DIRTY` 且不代为提交，而孤儿任务已无会话可走 close-with-worktree。执行成功落收尾留痕 |
| 其余写操作 | 全复用 07：`/worktree-sessions`、`/sessions/:parent/fork-worktree`、`/sessions/:name/close-with-worktree`、`/git/worktree/*`、`/races*`（这些路径也在收尾/清理成功时落留痕）|

收尾留痕：追加写 `<dataDir>/activity.log`（JSONL：`{repoKey, task, branch, headOid, base,
action: merged|discarded|cleaned, strategy?, shortstat, at}`），只增不改，是活动 tab 的
第二数据源；不是任务真相源，丢失只损失历史摘要。实现见 §5。

## 5. 后端设计

**总原则：Project 是纯读模型层，不新增真相源。** git 写仍独占于 `backend/worktree`
（07 §2.3 不变），session 写仍薄转发 ttmux CLI；Project Service 只做「发现 + 聚合 +
两个弱持久化文件」。

### 5.1 落点（现有分层的增量）

```
backend/
  worktree/service.go     已有：git 领域服务（repo 锁 / 3s list 缓存 / pane cwd join）
  api/worktree.go         已有：handler + 组合编排（worktree-sessions / fork / close-with-worktree）
  api/race.go             已有：RaceStore（<dataDir>/races.json，互斥+整写）+ crown 状态机
  project/service.go      新增：发现聚合 + knownRepos 台账 + 收尾留痕读写
  api/project.go          新增：GET /projects、GET /projects/:repoKey、PATCH …/prefs
  api/worktree.go         扩展：WorktreeFinish（§5.4，与 close-with-worktree 共享步骤 helper）
```

依赖方向：`api/project.go → project.Service → {worktree.Service, ttmux.Client, RaceStore,
swarm 只读}`（蜂群成员归属读 swarm.db，与 07 §2.2 一致，项目层不写）。
project 包不直接跑 git 子进程——repo 解析、worktree 列表、diff 统计全部经 `worktree.Service`
（canonical common-dir、flock、缓存因此天然复用）。

### 5.2 数据文件（dataDir，与 races.json 同级、同体例）

| 文件 | 内容 | 写法 |
|---|---|---|
| `projects.json` | `{repos: {repoKey: {dir, pinned, displayName?, defaultAgent?, defaultBase?, firstSeen, lastSeen}}}` | 单写者 project.Service；内存互斥 + tmp 文件原子替换（同 RaceStore 体例）|
| `activity.log` | 收尾留痕 JSONL（§4），只追加 | `O_APPEND` 单行写；超 5MB 轮转为 `.1` 只保一代，读取 = 两代合并按时间倒序、单仓库上限 200 条 |

`repoKey` = 仓库目录名 slug + common-dir 短 hash（如 `ttmux-3f9a`）：可读、稳定、
不把绝对路径塞进 URL；`repoKey → dir` 映射只存在 projects.json 里，
**API 只接受台账中已存在的 key**——顺带杜绝任意路径探测。

### 5.3 发现与聚合（GET /projects 的一次请求）

1. `ttmux ls --tree --json` + pane cwd 快照（worktree.Service 已有 join 逻辑，导出复用）；
   每个命中 git 仓库的 cwd → `ResolveRepo`（canonical）→ **knownRepos 不在册则记入**
   ——发现是读路径的副作用，无独立注册流程。
2. 对 knownRepos 全量：`WT.List`（3s 缓存兜底）→ 统计 任务数 / worktree 数 / 待收尾数
   （孤儿 ∧ committedAhead>0）/ 最近活动（各 worktree HEAD commit 时间的 max）。
   仓库间 errgroup 并行、并发 ≤4；整个响应再套 5s TTL 缓存（与 W4 轮询节拍一致）。
3. RaceStore 计数；目录不存在 → §2.1(a) 移出；无 roam worktree ∧ 无会话 ∧ 未置顶 →
   §2.1(b) 移出——收敛发生在读时，无后台任务。
4. 排序在服务端定且**必须稳定**（v0.2 修订：活动只展示、不参与排序——按活动排会随
   轮询不断跳变）：置顶 > 入册时间（FirstSeen，老项目位置不动、新项目追加在后）>
   名称兜底；前端不重排。

单仓库详情（`GET /projects/:repoKey`）在此之上加：任务投影（§2.2——纯函数
`tasks(sessions, worktrees, races)`，无状态无持久化）、7 日 spark
（common-dir 一次 `git log --all --since=7.days --format=%ct`，60s 独立缓存——它比
worktree 列表变化慢）、活动流（`git log --all --since=30.days` + activity.log 合并，
60s 缓存）。

生命周期导轨不落后端字段：running/waiting 来自现有 agent 进程探测，「审」=
committedAhead>0，「并」= merged 判定——前端由既有字段推导，后端不新增状态机。

命令行尾行预览（P4）单独走 `GET /sessions/:name/peek`：`tmux capture-pane -p -t =name:`
取末行（沿用 07 的 `=name:` 精确匹配教训），仅前端展开 worktree 时按会话懒加载，
5s 缓存、输出截断 120 字符——不进 /projects 聚合响应，避免 O(S) 子进程常驻轮询。

### 5.4 finish 状态机（api 层组合，不进 worktree.Service）

`SessionCloseWithWorktree` 已实现 keep/merge/discard 的逐段编排（每步失败返回
`{stage, done}`）。finish = 同一条 merge 链去掉 kill 步 + 前置冻结校验；实现上把
「wip-commit → merge → remove → 留痕」抽成 api 包内共享 helper，close-with-worktree
的 merge 档与 finish 都调它——**一份编排两处用，避免语义漂移**。

| 步 | 动作 | 失败语义 |
|---|---|---|
| freeze | 校验 expectedHead == source HEAD，此后该值作废 | `HEAD_MOVED`，要求重新确认 |
| wip | `CommitAll`（无改动则跳过，幂等） | 返回 `{stage: wip}` |
| merge | `WT.Merge`（**不传 expectedHead**；base 侧 OID 校验、冲突 abort 自恢复均在 Merge 内，07 §2.3） | `{stage: merge, conflictFiles}` |
| remove | `WT.Remove`（占用检查防与「复活」竞态；delete-branch 按请求） | `{stage: remove}` |
| 留痕 | activity.log 追加 | 只记 warn，不算失败 |

锁：各步经 worktree.Service 自取 repo flock（07 §2.3），api 层不额外持锁。
与 crown 不同，**不做 crownDone 式跨请求持久化**：竞赛贵在选手、crown 必须可续跑；
finish 每步幂等（wip 重试自动跳过、merge 冲突已被内部 abort 恢复、remove 可重试），
失败把 `{stage, done}` 抛回 P3，用户重试从头走一遍即可，无需状态文件。

### 5.5 开销预算

- 最坏路径 = knownRepos 全量 List：O(R × N) 子进程，被三层缓存（list 3s / 响应 5s /
  spark·活动 60s）+ 仓库级并发上限压住；P1/P2 轮询 5s 与 W4 同拍，不新增压力档。
- activity.log 读放大由「轮转 + 单仓库 200 条上限」封顶；留痕只含统计与 OID，
  **不含 diff 内容**——敏感代码不进日志文件。

## 6. 边界

- 项目退场 = knownRepos 自动收敛，条件见 §2.1：**只看 roam worktree 是否存在，不看干净与否**
  ——clean/已合并但尚未清理的孤儿也让项目在列（「清理」入口就在这），全部 roam worktree
  移除且无会话后才退场（置顶过的保留，标「无活动」）。没有「删除项目」操作。
- 溯源承诺收窄：活动 tab = 现存 git log + 收尾留痕（§4）。丢弃删除后的提交不可达，
  只剩留痕摘要；不承诺任务级提交可恢复。
- 竞赛/蜂群以编队组进任务流（竞赛组头 → W6 对比台，蜂群组头 → 蜂群页），P2「编队」tab
  汇总两者但不做编排；swarm.db / races.json 真相源不动，项目层只读投影。蜂群跨仓库时
  各项目只见本仓库成员（标「成员 n/N」），全局视图仍在 Sider 蜂群页。
- i18n：全部新文案照 [i18n 标准](../../development/i18n.md) 走 `zh-CN`/`en-US` 词条。
- 分期：M1 = knownRepos 弱台账 + P1/P2 只读聚合 + composer（写走现有 API）；M2 = P3 收尾
  抽屉（新增 `/git/worktree/finish`）+ 收尾留痕 + 活动 tab + 手机端；M3 = 偏好（置顶/默认项）
  + 面包屑打通终端。
