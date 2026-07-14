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

### 2.1 项目 = git 仓库（canonical common-dir）

**不是**「顶层会话 = 项目」：顶层会话可关闭、可多开、可不在任何仓库里；仓库才是稳定容器。

- **发现 = 现算 ∪ 弱台账**：项目列表 = 「全部会话 pane cwd join（07 §2.4）∪ knownRepos
  逐仓库 worktree 扫描」。repo 身份 = canonical common-dir（07 §2.3 规则不变）。
  **不能只靠会话现算**：现有 `GET /git/worktrees/all` 只枚举「当前会话触达的仓库」，
  仓库最后一个会话关掉后，留着未合并提交的孤儿 worktree 就没有任何来源能再发现它——
  「待收尾/复活」入口直接消失。
- 因此 `<dataDir>/projects.json` 是**弱台账**：仓库首次被发现（会话 cwd join 命中）即
  自动记入 `knownRepos`（canonical common-dir 列表）；仓库目录已不存在、无 roam worktree
  且未置顶时自动移出。同文件顺带存 UI 偏好（置顶、默认 agent/base、自定显示名）。
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

- 投影规则：任务集合 = 项目内全部会话（按 竞赛 > parent 树 > 平铺 组织，同 W2 优先级）
  **∪** 无会话占用的 worktree（孤儿/外部，07 W4 四态徽章语义照搬）。
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
- **手机端**：P1 卡片纵排；P2 composer 收成底部输入条「＋ 描述新任务…」，任务流为主。

## 4. API（读模型聚合 + 一个新增组合写接口）

| 接口 | 说明 |
|---|---|
| `GET /projects` | 聚合：knownRepos（§2.1 弱台账）逐仓库 worktree 扫描 + `ttmux ls --tree` cwd join（顺带把新命中的仓库记入 knownRepos）+ races 计数 + 最近活动（worktree HEAD 时间的 max）|
| `GET /projects/:repoKey` | 单仓库详情：任务投影（§2.2）+ worktree 列表 + races + 活动流（各 worktree `git log --since` 汇总 + 收尾留痕，带缓存）|
| `PATCH /projects/:repoKey/prefs` | UI 偏好（置顶/默认 agent/默认 base），落 projects.json；knownRepos 由发现流程自动维护，无手动接口 |
| `POST /git/worktree/finish` | **新增组合 API（P3 合并档）**：复用 close-with-worktree 的状态机、去掉 kill 步——CommitAll wip-commit → merge（dry-run/expected-head）→ remove，失败停在可恢复阶段。必须新增：`/git/worktree/merge` 对脏树返回 `WORKTREE_DIRTY` 且不代为提交，而孤儿任务已无会话可走 close-with-worktree。执行成功落收尾留痕 |
| 其余写操作 | 全复用 07：`/worktree-sessions`、`/sessions/:parent/fork-worktree`、`/sessions/:name/close-with-worktree`、`/git/worktree/*`、`/races*`（这些路径也在收尾/清理成功时落留痕）|

收尾留痕：追加写 `<dataDir>/activity.log`（JSONL：`{repoKey, task, branch, headOid, base,
action: merged|discarded|cleaned, strategy?, shortstat, at}`），只增不改，是活动 tab 的
第二数据源；不是任务真相源，丢失只损失历史摘要。

`repoKey` = canonical common-dir 的 slug（服务端维护映射，避免路径进 URL）。

## 5. 边界

- 项目退场 = knownRepos 自动收敛：worktree 清干净**且**无会话后才移出列表（置顶过的保留，
  标「无活动」）；**只要还有孤儿 worktree，哪怕零会话，项目就一直在列**——这正是弱台账
  存在的理由（§2.1）。没有「删除项目」操作。
- 溯源承诺收窄：活动 tab = 现存 git log + 收尾留痕（§4）。丢弃删除后的提交不可达，
  只剩留痕摘要；不承诺任务级提交可恢复。
- 竞赛/蜂群不动：竞赛在任务流里保持组呈现（组头 → W6 对比台）；蜂群成员会话若落在
  仓库内也进任务流，业务归属仍看 swarm.db。
- i18n：全部新文案照 [i18n 标准](../../development/i18n.md) 走 `zh-CN`/`en-US` 词条。
- 分期：M1 = knownRepos 弱台账 + P1/P2 只读聚合 + composer（写走现有 API）；M2 = P3 收尾
  抽屉（新增 `/git/worktree/finish`）+ 收尾留痕 + 活动 tab + 手机端；M3 = 偏好（置顶/默认项）
  + 面包屑打通终端。
