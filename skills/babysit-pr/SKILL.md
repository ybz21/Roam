---
name: babysit-pr
description: 轮询监控 Codex PR Review，自动决策修不修、回复并 resolve。当用户说"监控PR"、"babysit"、"等codex review"时触发。
user-invocable: true
allowed-tools:
  - Bash
  - Edit
  - Read
  - Glob
  - Grep
  - Agent
---

# Babysit PR —— 自动监控 Codex Review 并修复

## 参数

$ARGUMENTS —— PR 编号（可选）。如果未提供，从当前对话上下文中推断。

## 任务

持续监控 GitHub PR 上的 Codex 自动 review。对每条 comment 先做"修不修"的决策，再执行修复或解释不修的理由。每条处理完都要同时**回复 comment 并 resolve 对应的 review thread**。

## 核心原则：决策是否修 > 真的去修

这是整个流程**最重要的一条规则**，优先级高于任何具体的修复动作。

修得越多，代码距离最初设计的偏离就越多，冗余和隐患越大。很多 Codex 建议是基于不适用的假设或罕见到可忽略的路径，默认**不修**。

对每条 comment，先自问：

- 这是**真实存在**的问题吗？还是基于不适用的假设？
- 我们代码的**原始设计**是否本来就考虑了这一点？
- 修了会不会**引入新复杂度**？新增参数、新增分支、新增抽象？
- 修了会不会**掩盖**更深层的问题？

**默认倾向是"不修"**。只在以下情况修：

1. 真实的功能性 bug（会导致用户可感知的错误行为）
2. 会影响数据一致性、安全性、或其它可测的硬性指标
3. 简单明确的代码质量改进（删除死代码、修正命名、修 type error），不增加分支逻辑

不修不是偷懒——把每个 comment 当成一次"设计回顾"，能抵挡住的 review 意见越多，代码越稳。

## 执行流程

### 1. 确定 PR

- 如果 `$ARGUMENTS` 提供了 PR 编号，使用它；否则从对话上下文推断
- 确定 `owner/repo`：优先从对话上下文获取，否则用 `gh repo view --json nameWithOwner -q .nameWithOwner`
- 运行 `gh pr view <number> --repo <owner/repo> --json number,title,headRefName` 确认 PR 存在
- 运行 `gh pr diff <number> --repo <owner/repo>` 了解 PR 整体改动

### 2. 等待 Codex Review 或检测未回复 comment

运行本 skill 自带的阻塞脚本：

```bash
bash wait-codex-review.sh {owner/repo} {pr_number}
```

> 注意：`wait-codex-review.sh` 与本 SKILL.md 同目录。

脚本会自动检测 CI 状态、合并冲突、👀 reaction、未回复评论等。根据退出码：
- **0** → 有未回复的 Codex comment（stdout 是未回复 comment ID 的 JSON 数组），进入步骤 3d
- **1** → 审核通过，通知用户，结束
- **2** → 超时，通知用户，结束
- **3** → CI check 失败（stdout: 失败的 check 名称 JSON 数组），进入步骤 3a
- **4** → 合并冲突，进入步骤 3b
- **5** → 其他 reviewer 的未回复评论（stdout: comment ID 的 JSON 数组），进入步骤 3c

### 3. 处理异常情况

#### 3a. CI 失败（退出码 3）

1. 解析失败 check 名称列表
2. `gh pr checks {pr} --repo {owner/repo} --json name,state,detailsUrl --jq '.[] | select(.state == "FAILURE" or .state == "ERROR")'` 取详情
3. `gh run view {run_id} --repo {owner/repo} --log-failed` 看失败日志
4. 本仓库 CI 常见失败点：`scripts/dev/quality/check.sh full`（Go fmt/test、前端 `npm run i18n:check` / `typecheck` / `build`）、`pr-review.yml` 的策略审查。先在本地复现：`scripts/dev/quality/check.sh full`
5. 修复后提交推送，回到步骤 2

#### 3b. 合并冲突（退出码 4）

1. `gh pr view {pr} --repo {owner/repo} --json baseRefName --jq .baseRefName` 取 base 分支
2. `git fetch origin` + `git merge origin/{base}`
3. 解决冲突文件，提交推送后回到步骤 2

#### 3c. 其他 reviewer 的未回复评论（退出码 5）

按 3d 的方式处理，区别只是来源不是 Codex bot。

#### 3d. 处理 Codex Comments（退出码 0）

根据脚本输出的 comment ID 列表，**逐条**处理：

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}
```

对每条 comment：

1. **读取涉及的代码**：按 comment 的 `path` 和 `line`/`original_line` 读相关文件。
2. **做"修不修"决策**：参考顶部"核心原则"，结论是 **修** / **不修** / **需要用户决策**。
   - **不修** 但问题确有价值 → 提 GitHub issue 跟踪。
   - **需要用户决策**（架构级、业务不确定）→ **立即暂停**，告诉用户哪条 comment 需要人工判断。
3. **回复 comment + resolve review thread**（无论修不修都要做）。

回复要求：

- **用中文**，第一段必须是 Markdown 引用块 `>`，复述并**解释**原 comment 的问题——不是机械翻译标题，要讲清"为什么是问题 / 影响什么 / 绕过了什么设计约束"，让没看英文原文的人也能独立看懂。
- 涉及前后端状态 / 事件流一致性时，说清"哪一端变了、哪一端没同步、刷新前后为什么不同"。
- 涉及安全或权限时，说清"原边界是什么、现在怎么绕过、绕过后能拿到什么"。
- 引用后说明决策：修 / 不修 / 提 issue / 需要用户决策，并给理由；已修则说修复点和验证。

推荐格式：

```markdown
> 问题：<用中文完整解释 Codex 指出的问题、触发条件、影响>

已处理：<修复点与验证>，或：不修，因为<原设计已覆盖 / 假设不适用 / 不应在本 PR 修>。
```

只有 resolve 成功后该 comment 才算处理完毕——否则 `wait-codex-review.sh` 会反复把它当未回复项，babysit 陷入死循环。

### 4. 提交推送

如果有代码修改：

1. 确认当前分支与 PR 的 `headRefName` 一致
2. **先跑质量门**：`scripts/dev/quality/check.sh quick`（或涉及前端/运行时行为时 `full`）
3. 提交推送：

```bash
git add {modified files}
git commit -m "fix(<scope>): 处理 PR #{pr} 的 Codex review 意见"
git push
```

commit message 遵循仓库 [Conventional Commits 规范](../../docs/development/commit-convention.md)（中文描述）。

### 5. 循环

回到步骤 2，继续等待下一轮 Codex review。

## 重要规则

- **决策优先于修复**。默认倾向"不修"。
- **必须 resolve thread**。只回复不 resolve 会让 comment 无限重现。
- **回复必须先用 `>` 引用并用中文完整解释问题**，不要只写一句短标题。
- **用户可见前端文案必须走 i18n 层**（见 `AGENTS.md` / `docs/development/i18n.md`），不要为了修 review 引入硬编码中英文。
- 每次修复后跑 `scripts/dev/quality/check.sh`（quick 或 full）。
- Reply 使用中文；commit message 遵循 Conventional Commits。
- 如果 PR 的 repo 不在当前目录，所有 `gh` 命令带 `--repo` 参数。
