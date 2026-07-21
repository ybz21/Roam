# 07 · Worktree 管理设计

← 返回 [README](./README.md) ｜ 页面惯例见 [05-pages](./05-pages.md)

> 状态：设计 v0.6 — 已实现（§7 A–G 全部落地）。
> v0.5 → v0.6：**创建流程反转**——组合 API 从「先建 worktree 再建会话」改为「先建 (sub)session（cwd=仓库）→ 建 worktree（占位分支）→ 会话内 cd 进去」；分支名不再提前指定，由 agent 开工后按任务 `git branch -m` 动态命名（W1 交互修订 4）。Race Service（W5/W6）落地：crown 状态机阶段持久化可续跑，expectedHead 在冻结时校验（wip-commit 会合法挪 HEAD，不传给 Merge）。
> v0.6 增补（交互修订 5）：W1 字段顺序重排（名字→目录→在哪干活→Agent→需求）；base 缺省始终本地主干（origin/HEAD → main → master，绝不默认当前检出分支）；占位分支去 roam/ 前缀（纯会话名 slug，前缀由 agent/用户自定）。
> v0.4 → v0.5：架构边界重定——**ttmux CLI 专注 Session/subSession，Worktree 完全由上层（backend）Worktree Service 管理**。撤销 v0.4「CLI 是 worktree 唯一写入口」的结论：ttmux 不新增 `wt` 命令族、不实现 `cli/internal/worktree`、不执行任何 git 操作；v0.4 吸收的 Git 底层安全规则全部保留，归属改为 Worktree Service（§2.3）。
> 目标：把 git worktree 从「建会话时的一个复选框」升级为**有名字、看得见、有生命周期、能收尾、能并行竞赛**的一等能力。
> 参照：[Orca](https://github.com/stablyai/orca) 的 worktree-native 模型。

## 1. 现状与问题

已有能力（最小可用）：

| 层 | 现状 | 位置 |
|---|---|---|
| 后端 | `POST /git/worktree {dir}` 在 `<repo>/.worktrees/_<时间戳>` 建 worktree；`POST /git/worktree/remove {path}` 强删 | `backend/api/git.go` |
| 前端 | 新建会话弹窗一个「worktree 模式」复选框，建好后会话落在 worktree 里；创建失败回滚删除 | `App.tsx` NewSessionModal |
| Git 面板 | 完全不感知 worktree，只当普通仓库展示 | `GitPanel.tsx` |

问题：

1. **没有身份**。`git worktree add <path>` 默认以目录名建分支，分支叫 `_20260711153045123`——事后不知道它是干嘛的，**也没有任何地方记录它从哪个 base 分出来**。
2. **不可见**。没有界面能列出仓库有哪些 worktree、各自关联哪个会话、有多少未提交改动。
3. **没有收尾**。会话干完活关掉，worktree 和分支永远留在 `.worktrees/`，越积越多变成孤儿。
4. **污染宿主仓库**。对本仓库以外的项目建 worktree，宿主 `git status` 多出 untracked 的 `.worktrees/`。
5. **没吃到并行红利**。多 agent 改同一仓库互踩文件，worktree 隔离是解法但只能手动建。
6. **worktree 编排散落**。`git.go` 是零散 handler 而非领域服务：原子创建/回滚、仓库锁、错误码没有统一归属；前端还要自己两段式编排（先建 worktree 再建会话、失败补删）。

## 2. 模型与职责边界

**总原则：ttmux CLI 只理解 session；Worktree Service（backend 领域服务）独占一切 git 操作；二者由上层组合 API 编排。**

```
┌─ 前端 ────────────────────────────────────────────────┐
│         W1…W7（只调 HTTP，不做编排）                    │
└──────────────┬────────────────────────────────────────┘
┌─ backend ────┴────────────────────────────────────────┐
│  组合 API（事务编排）: /worktree-sessions, fork-worktree │
│  Worktree Service: git worktree/diff/merge/rm/prune/锁 │
│  Race Service: race/crown 状态机（业务数据模型在此层）  │
└───────┬───────────────────────────────┬───────────────┘
        │ 调 ttmux CLI（session 原语）    │ 执行 git
┌───────┴───────────┐          ┌────────┴──────────┐
│ ttmux: new/fork/  │          │ git 仓库           │
│ ls --tree/kill…   │          │ (worktree 身份在此) │
└───────────────────┘          └───────────────────┘
```

真相源各管各的，互不越权：

- **worktree 身份在 git 里**：创建时写 worktree-local config（启用 `extensions.worktreeConfig` 后 `git config --worktree`）：`roam.baseRef`、`roam.startOid`、`roam.createdBy=roam`、`roam.createdAt`。外部 worktree 无这些字段即 **base=unknown，禁止一键合并**（绝不猜 main）。分支名只承载任务身份，不承载 base。
- **session 关系在 meta.db**：`sessions` 表只存通用信息（§2.1），**没有 worktree 字段**——session↔worktree 靠 cwd join 现算（§2.4）。
- **Git 业务编排状态在上层服务**：race_id、repo、base、branch、worktree、winner、cleanup stage 属于 Worktree/Race Service 的数据模型（backend 侧持久化），不塞进 SessionMeta，也不塞进 swarm.db。
- **一个 worktree = 一个分支 = 一个任务**；删除 = 删目录 + 删分支（分支默认 `git branch -d`，未合并需 `-D` 时单独确认；删 worktree 的 force 与删分支的 force 是两个独立开关）。
- **与裸 git 互操作**：外部增删下次刷新照常出现/消失；worktree 内用户任意 git 操作以实况为准。

### 2.1 ttmux CLI：只负责 Session / subSession

ttmux 的能力止步于「平坦 tmux session + parent 关系」，**不理解 worktree**：

- **不新增 `wt` 命令族，不实现 `cli/internal/worktree`，不执行 `git worktree/diff/merge/rm/prune`**。
- `--dir` 对 ttmux 永远只是「普通工作目录」，它不知道也不关心这个目录是不是 worktree。
- **ttmux 永远不因为关闭 session 删除用户目录**，kill 不做任何 Git 安全判断。

命令面（session 全家）：

| 命令 | 说明 |
|---|---|
| `ttmux new <名> [--dir <path>] [--detach] [--json]` | 创建顶层 session。**不接受** `--worktree/--base/--branch` |
| `ttmux fork [<父>] <子> [--dir <path>] [--detach] [--json]` | subSession 原语：创建平坦 tmux session、meta 写 parent、继承父 cwd/env；`--dir` 仅覆盖工作目录。父缺省当前 session（`$TMUX` 探测） |
| `ttmux ls [--tree] [--json]` / `inspect <名>` / `children <名>` | session 树（parent 投影）与 pane cwd 快照；供上层做 cwd join |
| `ttmux kill <名> [--cascade]` | 默认只杀该 session 并将直接孩子 orphan（parent 置 NULL）；`--cascade` 杀子树。**无 `--worktree` 策略、不删目录** |
| `ttmux parent set\|clear <子> [<父>]` | 显式调整 parent（收编/解绑） |

**SessionMeta（meta.db 新增 `sessions` 表）**只存通用字段：`session, parent, created_by, created_at, initial_cwd`。**无 worktree 字段**；实时 cwd/panes 从 tmux 读。要处理：rename 更新外键、父被 kill 后置 NULL、名称复用（旧行清理）、parent 环检测拒绝。裸 `tmux kill-session` 留下的残行由 reconcile/查询时收敛，不承诺拦截。

> 注意现有 MetaDir 是 task 会话的目录型元数据（`spawn.WriteTaskMeta` 写），普通 `ttmux new` 和 web 建会话都不经过它——不能复用，必须新表。

### 2.2 subSession：按进程模型建模

像 Unix 进程：进程表是平的，树只是 `ppid` 字段的推导。

- **物理层不动**：tmux 会话保持平坦命名（`-t` 精确匹配教训不变）。
- **生命周期学 Unix**：杀父默认孤儿收养，`--cascade` 才级联；`ls --tree` 只做 parent 投影，**不把 cwd 推导写回强关系**。
- **两层关系并存**：parent 是显式强关系（fork 意图）；`session --cwd--> worktree --git--> repo` join 是推导弱关系（§2.4，反映实况）。UI 分组优先 parent 树，无 parent 的落回 cwd join 兜底。
- **parent ≠ 业务归属**：蜂群成员的业务归属真相仍在 swarm.db member 行；race 业务在 Race Service。
- **推荐规则**：并行修改代码的 agent **默认独立 worktree**；若该 agent 由现有任务派生，**同时**建模为 subSession（fork）。worktree 与 subSession 经 cwd 关联，但**不是同一概念**——顶层 session 也可进 worktree、外部 worktree 可无 session、已有 worktree 可被 new/fork 接管。

### 2.3 Worktree Service（backend 领域服务，独占 git 操作）

现有 `backend/api/git.go` 的能力**下沉到该 service**（不是下沉到 CLI）；HTTP handler 只调 service。能力面：`create / list / inspect / diff / merge / remove / prune / lock`。v0.4 的 Git 底层安全规则全部保留在此层：

**创建**（全程 common-dir 级 flock）：
1. `git rev-parse --git-common-dir` 定位真仓库身份（**repo 身份 = canonical common-dir**，不用路径字符串；linked worktree/submodule/gitfile 下 `root/.git` 不是目录，不能假设）。
2. ref 输入校验：分支名 `git check-ref-format --branch`；start-from `git rev-parse --verify REF^{commit}`；可能以 `-` 开头的输入一律 `--` 安全传参。远端 ref 由 API 显式给 `remote`+`ref`，fetch 后锁定 start OID，不做字符串猜测。
3. **锁内分配最终 branch/path**（冲突后缀在锁内定，前端提示只是预览；路径 slug 与 branch slug 分开处理）→ `git worktree add` → 写 roam.* worktree config（首次顺带在 common git dir 启用 `extensions.worktreeConfig`）→ **调 ttmux 建会话** → 任一步失败按反向顺序补偿（含删除刚建的 worktree/branch）。
4. `info/exclude`：经 common-dir 定位，带锁幂等追加 `/.worktrees/`。

**组合编排（service 调 ttmux，前端不再两段式；v0.6 顺序反转为先会话后 worktree）**：
- 顶层 worktree 会话 = `ttmux new <名> --dir <仓库目录>` → service 建 worktree（分支缺省自动占位 `<会话名 slug>`——纯 slug 无强制前缀，roam 身份在 roam.* config 不靠分支名）→ 会话内注入 `cd <worktree>`（send-keys 排队，先于前端随后发送的 agent 启动指令）。
- 派生编码会话 = `ttmux fork <父> <子> --dir <仓库目录>` → 同上建 worktree + cd。
- worktree 创建失败 → 反向补偿 `ttmux kill` 刚建的会话。
- 为什么反转：分支名不该在创建时定死——占位分支只是技术需要，agent 读完任务后 `git branch -m` 起语义名（分支名与 roam.baseRef 解耦，rename 安全）；会话先活起来也让创建零等待、cd 过程在回滚里可见。
- tmux 3.4 坑：send-keys 的 pane 目标必须写 `=name:`（精确会话+缺省窗口），裸 `=name` 报 can't find pane。

**合并**（同锁 + 检查无进行中 sequencer/merge/rebase）：
- **执行位**：在 `worktree list` 里找 checkout 了 base 的 worktree（主工作区不一定是 base）；找不到 → 默认建临时 integration worktree 执行、完毕即删（可配置改报 `BASE_WORKTREE_NOT_FOUND`）。执行位 dirty → 结构化报错，不自动 stash。
- **三种 strategy 语义分开**：`merge`/`squash` 在 base 执行位执行；`rebase` 是在 **source worktree** 把 source rebase onto base，之后 fast-forward base 是**第二步**（仍需 base 执行位）。
- **冲突状态机**：分别 `merge --abort` / `rebase --abort`，返回 `{stage, strategy, conflictFiles[], recovered: true}`。
- 破坏性操作（merge/remove）支持 **dry-run/plan**，执行时校验 `--expected-head`（HEAD 与 base OID 未变），避免确认后漂移。

**删除**：
- 删除前检查**是否仍有其他 session/pane 的 cwd 落在该 worktree 内**（含子目录）；默认禁止删除，或要求显式关闭关联 session 后再删。
- 脏保护默认拒绝；`force-worktree` 与 `delete-branch/force-delete-branch` 独立开关。

**读取/统计**：
- 列表解析 `git worktree list --porcelain`（可用时 `-z`），不解析人类输出；**GET 无写副作用**（prune 是显式 `POST /git/worktree/prune`）。
- 逐 worktree status/rev-list 是 O(N) 子进程：service 层 repo-keyed 3~5s 缓存、并发上限、超时。
- **ahead/behind 相对已记录的 `roam.baseRef`**，区分 `committedAhead`（未合并到 base 的提交——不是"未推送"）、`dirty`、`untracked` 三个数。
- **diff 定义**：`mergeBase = git merge-base <baseRef> HEAD`；已提交差异 = `git diff mergeBase..HEAD`；未提交改动**另算** workingTree diff，两个数字不混。文件统计 `--numstat -z`，rename/binary 结构化表达。

### 2.4 session ↔ worktree：cwd join 读模型（上层现算，不写台账）

- 上层读 `ttmux ls/inspect` 的**全部 pane cwd**（保留 session+window+pane），与 `git worktree list` 做 join：路径先 canonical（`EvalSymlinks`+clean），按**路径段边界**做「最长 worktree root 前缀」匹配。
- 返回 `matches[]` + `primary`（active pane）+ `ambiguous` 标记——一个 session 多 pane 可命中多个 worktree，不硬写 session→单对象；UI 对歧义显式标记。
- Worktree 可无 session（孤儿/外部）；session 可在普通目录；关系随 cd 实时变化，这是特性。

生命周期五步，每步都有对应界面（§3）：

```
创建 ──→ 干活 ──→ Review ──→ 收尾(合并/PR) ──→ 删除
 W1      会话+W3      W3 对比base    W4 抽屉 / W7 钩子     W4
```

## 3. 页面设计

> **高保真 HTML mockup：[07-worktree/index.html](./07-worktree/)**（W3/W6/W7 带轻交互）。
> 成套总览：[overall-desktop.html](./07-worktree/overall-desktop.html)｜[overall-mobile.html](./07-worktree/overall-mobile.html)。
> 现有布局基线：电脑 = 导航 `Sider` | 页面 | 右侧停靠终端三栏；手机 = 底部 Tab + 全屏页；Git 面板是终端视图里的浮动抽屉。

七个界面与入口关系：

```
会话列表(W2) ──新建──→ 新建会话弹窗(W1)
   │  └─仓库分组头[管理]──→ Worktree 管理抽屉(W4) ←──Git面板(W3)「···」/徽标
   │  └─竞赛组头[对比台]──→ 竞赛对比台(W6) ←──竞赛创建(W5)生成的组
   └─关闭 worktree 会话──→ 收尾三选一(W7)
```

### W1. 新建会话弹窗（名称 + 需求 + 工作区三选一）

> 交互修订 5（实现期）：**字段顺序重排 + base 缺省主干**——先定位置（名字 → 目录 →
> 在哪干活），再定执行（Agent → 需求），需求不再插在名字与目录之间；「基于」缺省
> 始终是本地主干（origin/HEAD 指向的本地分支 → main → master），绝不默认当前检出的
> feature 分支。占位分支去掉 roam/ 前缀（纯会话名 slug）。

> 交互修订 4（实现期）：**分支不再预指定**——去掉分支输入/派生预览/「高级」折叠，
> 展开卡只剩「基于」。流程反转为先建 subsession 再建 worktree：占位分支按会话名
> 派生（纯 slug，无强制前缀），prompt 前置命名约定让 agent 开工后 `git branch -m` 语义化
> （前缀 feat/fix 等由 agent 自定）；想手动指定分支名走 W4 新建入口。
> 无 agent 时提示可自行改名。

> 交互修订 3（实现期）：需求派生的长句不适合当会话名——**名称回归一等短输入**（可留空，
> 提交时从需求短派生 ≤16 字，再兜底 task-<时间>），需求 textarea 其次（发 Agent 第一条
> 指令，不再实时回填名称）。

> 交互修订 2（实现期）：**主输入是自然语言任务**，不是名字/分支。对照 Orca：它是任务名
> 优先（留空则随机海洋生物名，分支从名字派生，显式分支藏 Advanced）、prompt 要用户建完
> 手动粘 N 次——名字的地位已被 Orca 自己降到"可随机"，我们再进一步：prompt 只打一遍，
> 会话名从 prompt 首句派生（标点断句、24 字截断）、分支 `roam/<slug>` 跟名字走，全部在
> 「高级」折叠里可改；prompt 作为 CLI 参数随 agent 启动一次带入（POSIX 单引号安全包裹）；
> 新建 worktree 且分支未手改时，prompt 前置一行**命名约定**——cc 开工前自行
> `git branch -m roam/<语义名>`（分支名与 roam.baseRef 解耦，rename 安全；会话 rename 经
> ttmux 同步 meta 外键）。零新依赖、创建零延迟、名字最终语义化。
>
> 交互修订 1：原「worktree 模式」复选框把一等选择藏成术语开关，且无法进入已有
> worktree。改为目录是 git 仓库时出现**「在哪干活」三选一**，心智模型对齐用户真实问题。

```
┌─ 新建会话 ──────────────────────────────┐
│ 名称  [ fix-login                  ]    │
│ 目录  [ ~/codes/app         ][浏览]     │
│ 在哪干活  (主仓库)(●新建 worktree)(已有(2))│ ← Segmented，非 git 目录置灰
│ 「为这个任务开一个隔离工作区…」          │ ← 各态一句白话说明
│ ┌─────────────────────────────────────┐ │
│ │ 基于   [ main (默认)          ▾ ]   │ │ ← start-from 选择器（展开卡仅此一项）
│ │ 分支与目录自动创建;Agent 开工后会    │ │ ← 灰字说明，无分支输入（交互修订 4）
│ │ 按任务给分支起语义化名字             │ │
│ └─────────────────────────────────────┘ │
│ ( 无 )( ●Claude )( Codex )              │ ← Agent 在位置确定后选
│ 「需求 / 任务(自然语言)…」textarea       │ ← 最后写要干什么
│ ☐ 自动互审                              │
│                    [取消]  [创建]        │
└──────────────────────────────────────────┘
```

- **主仓库**（默认）：行为与普通建会话完全一致，零打扰。
- **新建 worktree**：展开「基于」卡（同上）；提交 = 一次 `POST /worktree-sessions`。
- **已有 (N)**：下拉列出仓库现有 worktree（`⎇ 分支` + 孤儿/外部/占用会话徽章 + 改动数），
  选中即把会话 cwd 指进去——孤儿由此复活；无可选项时该档置灰。

- **提交 = 一次 `POST /worktree-sessions`**（组合 API，§4，v0.6 先会话后 worktree）：`ttmux new --dir <仓库>` → Worktree Service 建 worktree（占位分支 `<会话名 slug>`，锁内分配后缀）→ 会话内 cd；一次返回 `{session, path, branch, base}`。
- start-from 选远端时 UI 明确拆 `remote` + `ref` 两个值；fetch 中可取消。

### W2. 会话列表：仓库 → worktree 分组

同仓库 ≥2 个 worktree 会话聚组；分组优先按 parent 树（fork 关系），无 parent 的按 cwd join 兜底。行尾 `⎇ 分支` Tag；session 多 pane 命中多个 worktree 时显示 primary 并加歧义标记（hover 列全部 matches）。其余同前（分组头 [管理] 入口、竞赛组头 [对比台]、手机端只显图标、折叠记 localStorage）。

> 实现补充（F 期收尾）：数据源改 `GET /sessions?tree=1`（parent 投影树拍平）；分组优先级
> **竞赛 > 父子树 > 仓库**——有活父/子的会话按 parent 树渲染（子行 ⑂ 紫色导线、按深度缩进），
> 不再落入仓库分组。会话行新增「派生」入口 → 复用新建会话同一张表单（parent 模式）：
> 目录固定 = 父会话 cwd（派生的语义就是在父目录干活，只读展示），其余与新建完全一致——
> 在哪干活三选一（父目录 / 新建 worktree / 已有(N)，非仓库父置灰并说明原因）、
> 勾新建 worktree 时 prompt 同样前置命名约定。提交走 `POST /sessions/:parent/fork-worktree`
> 或（父目录/已有档）`POST /sessions/:parent/fork`。

### W3. Git 面板：worktree 态 + 「对比 base」

- 头部加 `worktree` 徽标与「基于 <roam.baseRef> · 主仓库 <路径>」；**base=unknown（外部 worktree）显示 `base ?`，隐藏合并按钮**。
- 「对比 base」tab：文件清单 = `mergeBase..HEAD`（已提交差异）；顶部单独一行「另有未提交改动 n 个」入口切工作区 diff——两个数字分开呈现。
- 底部操作条 `合并回 <base> ▾`（merge/squash/rebase）+ `Worktree 管理`；合并先 dry-run/plan，确认框带 expected-head 提交执行。

### W4. Worktree 管理抽屉

结构同前（四态徽章：活会话/孤儿/外部/旧格式；元信息行；操作行；Skeleton/空态/筛选）。要点：

| 项 | 规则 |
|---|---|
| 元信息行 | `基于 <base> · ↑committedAhead ↓behind · 改动 dirty(+untracked) · 时间`——ahead 指**未合并到 base** |
| 外部/旧格式行 | base=unknown：无「合并」，只有 进入/对比(需手选基准)/删除 |
| 合并 | 走 §2.3 状态机；冲突弹 `{stage, conflictFiles}` + [进入会话处理]；成功后询问删除 |
| 删除 | 先查占用（有 session/pane 在内 → 默认禁止，引导先关会话）；dry-run 报告将丢失的 dirty/committedAhead 明细；删分支默认 `-d`，需 `-D` 时单独红字勾选 |
| 刷新 | 5s 轮询（service 缓存兜底）；**不顺带 prune**，底部显式「清理残留」按钮 |

> 实现补充（重做版）：默认**跨仓库总览**——`GET /git/worktrees/all` 汇总当前全部会话触达的
> 仓库（cwd join），按仓库分组、组头可「聚焦」；目录框留空即总览。行有状态导轨色 + 有货
> 着色（↑ 蓝/改动 黄），操作补齐 进入会话/新建会话进入（孤儿复活）、对比 base（已提交/未
> 提交分开统计 + 逐文件补丁，对比到工作区）；删除先列损失（改动/未合并提交）再确认 +
> 「同时删分支」勾选；筛选 = 状态档（带计数）+ 文本；新建（可手动指定分支名）仅聚焦时可用。

### W5. 竞赛创建弹窗

布局同前（选手卡、上限 5、资源预估）。入口 = W2「＋ 新建」下拉「新建竞赛…」。提交 = **一次调 `POST /races`**：service 逐选手「建会话（`<竞赛名>-<a/b/c>`，cwd=仓库）→ 建 worktree（分支 `<竞赛名>-<字母>`，即赛道身份，**不随 agent 改名**）→ cd → 发同题」；`race_id/repo/base/branch/worktree/winner/crown 阶段` 落 **Race Service 数据模型**（`<dataDir>/races.json`，不进 SessionMeta、不进 swarm.db）。单个选手失败只标记该选手（`status=failed` + error），不拖累其他人。

### W6. 竞赛对比台

- 数据源 = Race Service（谁参赛、base/branch/winner）+ Worktree Service list/diff（各自改了什么），5s 轮询；lane 状态复用 agent 进程探测（claude/codex running）。
- **[选为赢家] = 调 crown 状态机**（`POST /races/:id/crown`）：冻结（**expectedHead 在此校验**——后续 wip-commit 会合法挪 HEAD，不能把 expectedHead 传给 Merge）→ wip-commit → merge（策略可选，默认 squash）→ 可选清理输家（remove + ttmux kill）；每步完成即持久化 `crownDone`，中途失败返回 `{stage, done}`，同 winner 重试跳过已完成阶段续跑。
- 赢家的会话/worktree 保留（收尾走 W7/W4 占用语义）；[全部清理] 二次确认后杀全部选手会话 + 强删 worktree/分支，随后删竞赛记录。

### W7. 会话关闭钩子：收尾三选一

**定位：上层组合交互**——backend 编排 Worktree Service 与 ttmux，两者各自只做本职；每一步执行前重新校验，失败返回可恢复阶段：

```
┌─ 关闭会话 fix-login？ ──────────────────┐
│ 该会话的 worktree fix-login 还有   │
│ 2 个未提交改动、3 个未合并到 main 的提交 │
│ (●) 保留 worktree（稍后在管理页处理）    │
│ ( ) 合并回 main 并删除    [squash ▾]    │
│ ( ) 丢弃改动并删除 (!)                    │
│                  [取消]  [关闭会话]      │
└─────────────────────────────────────────┘
```

| 选项 | 编排 |
|---|---|
| 保留（默认） | 调 `ttmux kill`（只 orphan 孩子，不动目录） |
| 合并并删除 | service：merge（§2.3 状态机）→ `ttmux kill` → remove worktree/branch；任一步失败停在该阶段可恢复 |
| 丢弃并删除 | 二次确认后：`ttmux kill` → force remove |

- 干净 worktree（base 已知 ∧ dirty=0 ∧ ahead=0 ∧ 无进行中操作）时确认框提供已勾选的「随会话删除该 worktree」——显式可见勾选，不静默。
- 删除前占用检查同 W4（别的 session/pane 还在里面 → 拦）。
- 裸 `tmux kill-session` 绕过一切钩子——不承诺拦截，孤儿由 W4 兜底可见、可清。
- 竞赛成员叠加现有蜂群拦截提示。

## 4. 后端 API（三层，各有 owner）

**Session API**（owner：ttmux CLI，HTTP 薄转发）：

| 接口 | 转发 |
|---|---|
| `POST /sessions` | `ttmux new [--dir] --json` |
| `POST /sessions/:parent/fork` | `ttmux fork <parent> <child> [--dir] --json` |
| `DELETE /sessions/:name?cascade=` | `ttmux kill [--cascade]`（只管 session） |
| `GET /sessions?tree=1` / `GET /sessions/annotations` | `ttmux ls --tree --json` + §2.4 join 读模型（`{session → {primary, matches[], ambiguous}}`） |

**Worktree API**（owner：backend Worktree Service）：

| 接口 | 说明 |
|---|---|
| `POST /git/worktree` | create：锁内命名 + roam.* config + info/exclude，返回 `{path, branch, base, startOid}` |
| `GET /git/worktrees?dir=` | list：porcelain 解析 + committedAhead/dirty/untracked + cwd join；无写副作用 |
| `GET /git/worktree/diff` | mergeBase..HEAD 与 workingTree 分开返回 |
| `POST /git/worktree/merge` | dry-run/plan + expected-head；冲突返回 `{stage, conflictFiles, recovered}` |
| `POST /git/worktree/remove` | 占用检查 + 脏保护；force-worktree 与 delete-branch/force-delete-branch 独立 |
| `POST /git/worktree/prune` | 显式清理残留元数据 |

**组合 WorktreeSession API**（owner：backend 编排层，事务式，前端一次调用）：

| 接口 | 编排 |
|---|---|
| `POST /worktree-sessions` | `ttmux new --dir <仓库>` → Worktree Service create（分支缺省占位）→ 会话内 cd；worktree 失败反向补偿 kill 会话；返回 `{session, path, branch, base}` |
| `POST /sessions/:parent/fork-worktree` | `ttmux fork --dir <仓库>` → create → cd；同上补偿 |
| `POST /sessions/:name/close-with-worktree` | W7 三选一（keep / merge-then-remove / discard-remove）的状态机入口 |
| `POST /races` / `GET /races` | 开赛（逐选手 会话→worktree→发题）/ 竞赛列表 |
| `POST /races/:id/crown` | crown 状态机（冻结校验 expectedHead → wip → merge → 可选清理），阶段可续跑 |
| `POST /races/:id/cleanup` / `DELETE /races/:id` | 全部清理（会话+worktree+分支）/ 删除竞赛记录 |

## 5. 与裸 git 互操作

- 外部 `git worktree add`：列表标「外部创建」，base=unknown（无 roam.* config），可收编（新建/接管会话进入）但不可一键合并。
- 外部 `git worktree remove`：下次刷新消失；残留元数据走显式 prune。
- worktree 内用户任意 git 操作：以实况为准；进行中的 merge/rebase/sequencer 会让 Roam 侧破坏性操作被拒（§2.3）。

## 6. 边界与风险

- **并发**：Worktree Service 所有 create/merge/remove 持 common-dir 级 flock；同仓库操作串行化。
- **确认后漂移**：破坏性操作 expected-head 校验，变了就拒绝并要求重新确认。
- **合并执行位不存在**：默认临时 integration worktree（可配置改报 `BASE_WORKTREE_NOT_FOUND`）。
- **删除占用**：有任何 session/pane cwd 落在 worktree 内默认禁止删除。
- **worktree 里嵌套建 worktree**：以 common-dir 归位真仓库根，避免套娃。
- **旧时间戳 worktree**：照常展示标「旧格式」（base=unknown 待遇），不做迁移。
- **竞赛资源上限**：选手上限先定 5，创建时预估提示。
- **i18n**：全部新文案按 [i18n 标准](../../development/i18n.md) 走 `zh-CN`/`en-US` 词条。

## 7. 实施顺序与分期

**先底层语义后 UI，session 与 worktree 两条线可并行起步**：

| 步 | 内容 | 对应分期 |
|---|---|---|
| A | SessionMeta（meta.db sessions 表）+ `ttmux fork` / `ls --tree` / `children` / `parent set\|clear` / `kill --cascade` 语义 | M1 |
| B | backend Worktree Service + Git 集成测试（普通仓 / linked worktree / dirty / 分支被占 / 冲突 / 外部 worktree） | M1 |
| C | session↔worktree cwd join 读模型（annotations） | M1 |
| D | 事务式组合 API（/worktree-sessions、fork-worktree、close-with-worktree） | M1 |
| E | W1 / W4 / W7 | M1~M2 ✅ |
| F | W2 / W3（对比 base） | M2 ✅ |
| G | Race Service（race/crown 状态机）+ W5 / W6 | M3 ✅ |

A–D 亦已全部落地（M1）。
