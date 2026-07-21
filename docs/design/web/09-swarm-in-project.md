# 09 · 蜂群 × 项目：创建动线设计

← 返回 [README](./README.md) ｜ 项目概念见 [08-project](./08-project.md)（§2.2/§3 蜂群投影、P5 图纸）

> 状态：v0.2 — S1/S2 均已实现（含表单、开场白注入、看板卡、adopt 修复入口）。
> 范围：**只设计「在项目里创建蜂群」这一条动线**。创建之后的体现（任务流 ⬡ 组、
> 编队 tab 蜂群卡）与使用（进入成员/给指挥发话/done 判定）已在 08 §3 + P5 定稿，不重复。

## 1. 原则

- **项目页是发起地，蜂群台是编排地**。项目里创建 = 一次 `POST /swarms`，拆任务/建成员/
  派活的编排权完全留给指挥（cc-swarm 全生命周期）——项目页不代做任何编排。
- **表单只产出「上下文」，不产出「结构」**。班子建议、worktree 约定都只写进指挥开场白
  （与 W1 分支命名约定同一手法：prompt 前置条款，agent 自主执行）；不直接调
  `POST /swarms/:n/members` 逐个建成员——那会绕过指挥对 dev-roles 的判断。
- **真相源不动**：swarm.db 归蜂群，projects.json 不记蜂群任何字段；项目内可见性
  全靠现有投影（cwd join + `GET /swarms/:n`）。

## 2. 入口

| 入口 | 说明 |
|---|---|
| P2 编队 tab「＋ 新建蜂群…」 | **主入口**。git 项目才显示编队 tab，天然限定 |
| 蜂群页全局「新建」 | 保留不动（目录手填）；项目入口的增量价值 = 目录预填 + 项目上下文注入开场白 |

非 git 项目：一期不提供入口（编队 tab 本身不显示）。成员独立 worktree 依赖 git；
非 git 目录多 agent 共目录互踩风险高，先不开口子。

## 3. 表单（P5 帧二，字段逐个定死）

```
┌─ 新建蜂群 ────────────────────────────────┐
│ 名称    [ perf-sprint          ]（可留空） │
│ 目录    ~/codes/ttmux（项目固定·只读）     │
│ 目标    [ 首屏加载压到 1s 内：产物瘦身…  ] │ ← 必填，指挥的开场任务书
│ 班子建议 (⬡指挥·必)(frontend)(perf)(qa)(＋)│ ← chips，多选
│ ☑ 成员各自独立 worktree（默认）            │
│ ▸ 高级：☑ 自动拉起指挥（默认开）           │
│                       [取消]  [开工]       │
└────────────────────────────────────────────┘
```

| 字段 | 规则 |
|---|---|
| 名称 | 可留空：从目标派生（复用 `taskNameFromPrompt` 截 16 字）；蜂群名会成为成员会话名前缀（`cc-<群>` 等 CLI 约定），提交前做 slug 化提示但不强改；重名由后端 `swarm new` 报错原样透出，前端预检 `GET /swarms` 给即时提示 |
| 目录 | 固定 = 项目主仓库根（proj.dir），只读展示——这就是「在项目里创建」的含义 |
| 目标 | 必填 textarea。**不把班子/约定拼进 goal**（goal 存 swarm.db、到处展示，要保持干净的一句话需求） |
| 班子建议 | chips 多选：内置角色来自 `GET /swarm/subroles`（pm/architect/frontend/backend/qa/…），可自定义输入；「⬡ 指挥」常驻不可去。**只是给指挥的建议**，最终拆定权在指挥（dev-roles skill） |
| 成员独立 worktree | 默认勾选。勾选 = 开场白追加 worktree 条款（见 §4） |
| 自动拉起指挥 | 默认开（= 现有 `master:true` 行为）。关闭 = 先建群（传文档/上传材料）再手动拉起——现有 `POST /swarms/:n/adopt` 时序，折叠进「高级」 |

## 4. 提交编排（一次调用 + 模板小改）

前端提交：

```
POST /swarms {
  name, goal, dir: proj.dir, master: true,
  roster:   ["frontend", "perf", "qa"],   // 新增可选：班子建议（subrole key 列表）
  worktree: true,                          // 新增可选：成员独立 worktree 约定
}
```

后端改动**仅限 prompt 渲染层**（`api/swarm.go` + `prompts/auto_leader.md.tmpl`），
CLI 零改动：

- `promptCtx` 增加 `Roster []string`、`WorktreePolicy bool` 两个字段；
  `SwarmNew` 从请求体透传（缺省为空 = 行为与现在完全一致，向后兼容）。
- 模板在「第一步：先读规范」与「全生命周期」之间追加两个条件段：

```
{{if .Roster}}
## 班子建议（human 在项目页勾选的，仅供参考——最终按 dev-roles 拆定）
建议角色：{{range .Roster}}`{{.}}` {{end}}
{{end}}
{{if .WorktreePolicy}}
## Worktree 约定（必须遵守）
改代码的成员一律经 fork-worktree 开进独立分支互不踩文件：
`ttmux swarm add` 之后引导成员（或直接用 web 组合 API POST /sessions/:名/fork-worktree）；
成员开工前先给分支起语义化名字（git branch -m <kebab-case>）。
{{end}}
```

失败语义：

| 阶段 | 处理 |
|---|---|
| `swarm new` 失败 | 无半态，报错原样给表单（重名/目录不可写） |
| 群建成、指挥拉起失败 | 群存在无指挥——编队 tab 蜂群卡显示「无指挥」黄标 + [拉起指挥] 按钮（= 现有 `POST /swarms/:n/adopt`，S2 落地） |

## 5. 创建后（回链 08，不在本篇展开）

提交成功 → 编队 tab 出现蜂群卡（`GET /swarms/:n` 投影）→ 指挥读开场白按 cc-swarm
拆任务建成员 → 成员会话经 cwd join 自动进项目任务流 ⬡ 组，**无需任何登记**。
done 判定只认指挥显式 `swarm done`（项目页不代标）。

## 6. 边界

- **跨项目派活**：指挥可以把成员开到别的仓库；各项目只显示落在本仓库的成员
  （08 §2.2「成员 n/N」语义），本表单不试图约束。
- **资源提示**：班子建议 >5 个角色时表单黄字提示资源开销（同竞赛上限的软提示，不硬拦）。
- **与竞赛的分工**：竞赛 = 同题多解赛马（结构由 Race Service 定死）；蜂群 = 分工协作
  （结构由指挥动态拆）。编队 tab 两种卡并列，创建入口也并列，不合并表单。
- **i18n**：全部新文案照 [i18n 标准](../../development/i18n.md) 走 `zh-CN`/`en-US` 词条。

## 7. 分期

| 期 | 内容 |
|---|---|
| S1 | 表单（P5 帧二）+ `POST /swarms` 透传 roster/worktree + 模板两个条件段 |
| S2 | 「无指挥」修复入口（adopt）+ 班子建议同步建看板卡（`POST /swarms/:n/task` 逐条，仍不建成员） |
