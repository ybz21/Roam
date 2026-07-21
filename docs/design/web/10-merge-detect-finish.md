# 10 · 已合入检测与任务收尾（远端感知）

← 返回 [README](./README.md) ｜ 收尾底层见 [07-worktree](./07-worktree.md) ｜ 任务流见 [08-project](./08-project.md)

> 状态：设计提案 v0.1 — 未实现，先出机制图纸。
> 背景：08 落地后任务生命周期是 `干活中 → 待收尾 → 已合并 → 完结`（08 §2.2），但
> 「已合并」的判定只对比**本地** base。真实工作流是「任务分支 push → GitHub 开 PR →
> 网页上 merge」——合并发生在**远端**，本地毫不知情。结果就是：明明已经合进 main 的
> 任务，项目页还挂着黄色「待收尾 · ↑n 未合并」，收尾抽屉还在渲染「损失清单」，
> 用户看不懂：到底还有没有东西没合？

## 1. 现状诊断（为什么看不懂）

判定链条今天长这样（`backend/worktree/service.go` List）：

```
committedAhead = rev-list --count <本地 base>...HEAD     ← 只看本地
待收尾  = 孤儿 worktree 且 (committedAhead>0 或 dirty>0 或 untracked>0)
已合并  = committedAhead==0 且 dirty==0（⇥ 可清理，紫标）
```

三个断裂点，恰好覆盖用户遇到的全部「看不懂」：

1. **远端合并不可见**。PR 在 GitHub 上 merge 后，本地 `main` 没动过，
   `base...HEAD` 依旧 ahead>0 → 任务永远显示「待收尾/有损失」。只有用户手动
   `git pull` 主仓库之后，普通 merge 的任务才会翻绿。工具从不 `git fetch`
   （List 全链路零网络调用，fetch 只在 Create 显式 remote 时发生）。
2. **squash / rebase 合并永远不翻绿**。GitHub 默认常用 squash——合入 main 的是
   一个新提交，任务分支上的提交按 OID 永远不是 main 的祖先。哪怕本地 main 拉到
   最新，`rev-list` 仍然 ahead>0，「待收尾」黄条一辈子挂着，收尾只能选
   「丢弃删除」并被红字警告损失 n 个提交——**明明零损失**，界面却在吓人。
3. **「待收尾」一个词背了两种语义**。真·未合并（有损失风险，需要人决策）和
   已合入·只剩清理（零风险，一键删）今天是同一个黄条、同一个三选一抽屉。
   前者需要谨慎，后者需要顺手——混在一起，两边都别扭。

## 2. 目标与非目标

**目标**

- 远端合并（含 squash/rebase）能被自动识别，任务翻到明确的「已合入」状态。
- 「待收尾」拆成两种视觉与动线：`已合入·待清理`（绿，一键清）/`未合并·待决策`（黄，三选一）。
- 检测是**周期性 + 事件触发**的后台行为，用户不需要懂 git 也不需要手动 pull。

**非目标**

- 不接 GitHub API / gh CLI 做 PR 状态查询（依赖 token、平台耦合；git 本身信号已够用，
  平台增强留给插件层，见 §8）。
- 不自动删除任何东西（worktree/分支/会话）。检测只改**展示与建议**，删除永远经人点击
  （可留一个显式 opt-in 的自动清理配置，默认关）。
- 不改变 07/08 已有的收尾三选一、留痕、竞赛/蜂群语义——本篇是在它们前面加一层
  「远端感知」，不是重做收尾。

## 3. 远端同步：什么时候 fetch

新增仓库级轻量同步（每个 knownRepo 一份状态）：

```
git fetch --prune origin +refs/heads/<默认分支>:refs/remotes/origin/<默认分支> <任务分支们>
```

- **fetch 什么**：默认分支（合并目的地）+ 本仓库 roam worktree 对应的远端同名分支
  （拿 branch-gone 信号）。`--prune` 让「远端分支已删」可见。不做全量 fetch。
- **触发时机**（三档，从便宜到贵）：
  1. **驻留刷新**：项目页（P2）/概览在前台时，每 5 分钟一次；同仓库多视图共享结果。
  2. **事件触发**：任务会话关闭时、收尾抽屉打开时、用户点「刷新」时——这些是
     「用户马上要看合并状态」的时刻，值得即时同步一次。
  3. **后台兜底**：常驻服务每 30 分钟扫一轮 knownRepos（有 roam worktree 的仓库才扫）。
- **护栏**：
  - `GIT_TERMINAL_PROMPT=0` + 超时 10s——凭据缺失/网络不通就静默失败，绝不弹交互。
  - 失败不降级体验：沿用上次结果，仓库级记 `syncedAt` + `syncError`，UI 只在角落显示
    「远端 · 3 分钟前」/「远端不可达」，判定退回纯本地（= 今天的行为）。
  - 无 remote 的纯本地仓库：跳过同步，逻辑与今天完全一致。
  - 每仓库串行 + 结果缓存（TTL 同触发档位），和现有 List 缓存同栈，避免 git 进程风暴。

## 4. 合入判定：三个信号，两级置信

对每个「有 base 的非主仓库 worktree」，在现有 dirty/ahead/behind 之外增算：

| 信号 | 命令 | 覆盖场景 | 置信 |
|---|---|---|---|
| S1 祖先 | `merge-base --is-ancestor HEAD origin/<主干>` | merge commit / fast-forward / rebase 后 ff | **确证** |
| S2 补丁等价 | `git cherry origin/<主干> HEAD` 全为 `-` | squash、逐提交 rebase | **确证**（patch-id 等价） |
| S3 远端分支消失 | push 过（reflog/upstream 有据）且 fetch --prune 后 `origin/<分支>` gone | GitHub「merge 后删分支」惯例 | **佐证**（单独不定案） |

判定规则：

```
merged   = S1 ∨ S2                    （mergedKind = ancestry | squash）
likely   = ¬merged ∧ S3               （「疑似已合入」——只提示，不改动线）
unmerged = 其余
```

- S2 说明：`git cherry` 按 patch-id 对比，squash 场景下任务分支的每个提交内容都被
  squash 提交覆盖时全部标 `-`。若任务分支合并前又长出新提交，会出现 `+`——此时不算
  merged，ahead 数按 `+` 的条数展示（比今天的裸 rev-list 更准）。
- S3 单独出现（比如远端分支被手删但内容没合）不能定案，所以只作「疑似」黄条附注：
  「远端分支已删除——若 PR 已合并可直接丢弃」，把判断线索给人，不替人拍板。
- 对比对象是 `origin/<主干>`（fetch 来的远端真相），不再依赖本地主干是否 pull 过；
  本地无 origin 时退回本地 base（今天的行为）。
- 竞赛落选 lane：加冕(§07 竞赛)后未获胜的 lane 天然 unmerged，维持现有「丢弃」动线，
  不受本篇影响；获胜 lane 会被 S1/S2 命中翻绿。

## 5. 状态机（08 §2.2 的收尾段细化）

```
                     ┌────────────── 会话关 ∧ ahead>0 ∧ ¬merged ──────────────┐
干活中 ──────────────┤                                                        ├──▶ 完结
 (会话活)            │  待收尾·未合并（黄）  ── merged 检出 ──▶ 已合入·待清理（绿） │   (留痕)
                     └── merged 检出（会话还开着也可标）────────▲   [清理] 一键    ┘
```

| 状态 | 判定 | 颜色/徽章 | 动线 |
|---|---|---|---|
| 干活中 | 会话活 | 现状不变 | 现状不变；若此时已 merged，行内加 ✓ 绿点提示「已合入，可关会话」 |
| 待收尾·未合并 | 孤儿 ∧ (ahead>0 ∨ dirty) ∧ ¬merged | 黄条（今天样式） | P3 三选一（今天动线）；S3 命中时附「远端分支已删」线索 |

> **三态细化（已提交→已推送→已合入）**：`待收尾·未合并` 一个词其实盖了两种进度——
> 「本地已提交、还没 push」和「已 push、等合入」。新增 `pushed`（HEAD 是
> `origin/<branch>` 祖先，纯本地 ref 判定、无网络）把它俩拆开：导轨 `建→干→审→并` 上
> **已提交**停在「审」(cur=3)、**已推送**推进到「并」在跑(done=3,cur=4)、**已合入**走满(done=4)；
> 任务行/待收尾行加蓝色 `⇡ 已推送` 徽章，让人一眼知道远端还留着分支、丢弃前心里有数。
| **已合入·待清理** | merged ∧ 孤儿 | **绿条** ✓ 已合入(`ancestry`/`squash`) | **[清理]** 一键 = 删 worktree + 删本地分支 + 留痕；dirty>0 时按钮变「查看未提交改动」先走确认 |
| 完结 | worktree 已删 | 活动 tab 留痕 | 留痕新增 `mergedInto`/`mergedKind`/合并提交 OID（能从 merge subject 提取 `#PR` 就顺带存） |

- 生命周期导轨 `建→干→审→并`：「并」段今天靠本地判定，改为吃 merged 信号——
  远端 squash 合并后导轨终于能走满，这是用户「看不懂」的最直观修复点。
- 概览（P6）「需要你 · 待收尾」只统计**未合并**的；已合入·待清理不进「需要你」横幅
  （它不需要决策），改在项目卡上显示绿色小计 `✓n 可清理`，项目页一键清。
- 收尾抽屉（P3）在 merged 任务上重排文案：损失清单区替换为「✓ 已合入 origin/main
  （squash，对应 abc1234）」，三选一里「丢弃删除」升为推荐首选并去掉红色警示——
  同一个抽屉，两种心情。

## 6. 数据与 API 增量

**Worktree 投影新增字段**（`GET /git/worktrees*`，纯读模型，无迁移）：

```jsonc
{
  "mergedInto":  "origin/main",   // 空 = 未检出合入
  "mergedKind":  "ancestry",      // ancestry | squash
  "remoteGone":  true,            // S3：曾 push、现远端分支已删
  "aheadUnique": 1                // git cherry 的 + 数（比 committedAhead 更准的"真领先"）
}
```

**仓库级同步状态**（挂在项目投影上）：`{ syncedAt, syncError? }`。

**新端点**：`POST /git/worktree/sync {dir}`——手动「刷新远端」，也是事件触发档的内部入口（归入 worktree API 组，避免与 GitOp 已有的 `op=sync`=pull+push 撞名）。
返回同步后的 worktree 列表（复用 List 缓存失效）。

实现落点：全部在 `backend/worktree`（fetch/判定与 List 同栈，享受同一把仓库锁与缓存）；
`project`/`api` 层零新概念，只是把新字段透传给前端。留痕写入点在现有 close/finish
链路上补字段。

## 7. 边界与坑

- **fetch 的凭据**：开发机通常有 ssh-agent/credential helper；没有就静默失败退化为
  本地判定。绝不能让后台 fetch 卡在密码提示上（`GIT_TERMINAL_PROMPT=0`、`-c core.askPass=`）。
- **base 漂移**：worktree 记录的 base 可能是 `develop` 等非主干。判定目标 =
  `origin/<该 worktree 的 base>`；base 本身没有远端时退回本地。
- **多 remote**：v0.1 只认 `origin`（或 base 分支的 upstream remote，如果配置了）；
  多 remote 工作流后续再说。
- **私有大仓**：fetch 单分支 + prune 成本很低；仍按 §3 的 TTL 与串行护栏兜底。
- **merged ∧ dirty**：合入检测不改「未提交改动」的安全语义——清理前必须面对 dirty
  清单（stash/丢弃确认），这一步沿用 07 的护栏。
- **会话还开着但已 merged**：不自动关会话（agent 可能还在写总结/跑验证），只提示。
- **蜂群 worktree**：维持 08 P5 语义——提示「该 worktree 属蜂群 <名>」，集成验收
  优先走蜂群台；merged 徽章照常显示（信息无害），但一键清理入口在蜂群任务上收敛为
  跳转蜂群台。
- **误判防线**：S2 的 patch-id 在「合并时改过内容」（冲突解决、reviewer 手改）时会出
  `+`，宁可漏判（保持黄条）不可错判（把没合的当合了删掉）——所有确证信号都只放宽
  「展示」，删除动作前的 dirty/ahead 复核照旧执行一次。

## 8. 平台增强（插件位，非本篇范围）

git 信号解决 90% 场景；剩下的「PR 还开着没合」「review 被打回」这类**前置**状态属于
平台数据。预留插件点：hostmonitor 同款的 plugin 可选接 `gh pr status --json`，把
`prState/prUrl/reviewState` 附到任务行（08 任务流的 meta 区）。不做进内核，避免
token/企业私服等平台差异污染核心链路。

## 9. 落地切片

| 片 | 内容 | 验收 |
|---|---|---|
| M1 判定 | List 增算 S1/S2/S3 + 新字段（先用本地已有 refs，不 fetch） | 本地 pull 过 main 后，squash 合并的任务能翻绿（今天翻不了） |
| M2 同步 | 仓库级 fetch（三档触发 + 护栏）+ `POST /git/worktree/sync` | 不 pull 本地 main，GitHub merge 后 ≤5 分钟任务翻绿；断网退化无感 |
| M3 UI | 绿条/黄条拆分、P3 文案重排、导轨「并」吃新信号、P6 计数只算未合并、留痕补字段 | 用户能一眼区分「等我决策」和「顺手清理」 |
| M4 可选 | 自动清理 opt-in（merged ∧ clean ∧ 会话已关 ∧ 留痕后删）、PR 插件位 | 默认关；开了也只清零风险项 |

M1 与 M3 不依赖网络就能显著改善（用户 pull 过之后 squash 也能翻绿）；M2 才是
「不需要用户懂 git」的完全体。
