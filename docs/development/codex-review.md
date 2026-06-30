# Codex Code Review

本仓库的 PR 由 **OpenAI Codex 的 GitHub App**（机器人账号 `chatgpt-codex-connector`）自动 review。
它不是仓库里的某个配置文件，而是装在 GitHub 组织/仓库上的应用——每次 PR 打开或推送新提交时，
Codex 会自动读 diff、留下 inline review thread，并在 PR body 上用表情标注进度：

- 👀 = 正在 review
- 👍 = review 通过

## 一、启用（仓库管理员一次性操作）

1. 打开 <https://github.com/apps/chatgpt-codex-connector>（或在 ChatGPT 的 Codex 设置里连接 GitHub）。
2. 选择安装到本仓库所在的账号/组织，授权访问 **本仓库**。
3. 安装后，新开的 PR 会在一两分钟内收到 Codex 的自动 review。
4. （可选）在仓库 **Settings → Branches** 给 `main` 加保护规则，把 CI 的 `quality` / `i18n` 等 check 设为必需，确保人和机器都过了才合并。

> 与已有的 `.github/workflows/pr-review.yml`（`scripts/dev/quality/review.sh` 的策略审查）并存：
> 那条是仓库自带的**规则审查**（i18n、密钥、生成物等硬性策略），Codex 是**语义审查**（逻辑、边界、设计）。
> 两者互补，都会在 PR 上留评论。

## 二、响应 Codex 意见

Codex 留的每条 review thread 都要被**回复并 resolve**，否则 PR 会一直挂着未处理项。
处理时遵循一个核心原则：**决策是否修 > 真的去修**——默认倾向不修，只修真实的功能性 bug、
数据一致性/安全问题、或不增加分支复杂度的明确改进；其余说明理由后 resolve，有价值的另开 issue 跟踪。

这套流程已固化成 `babysit-pr` 技能，可自动巡检：

```
/babysit-pr 23        # 监控 PR #23
/babysit-pr           # 从上下文推断 PR
```

技能会轮询 CI 状态、合并冲突、未回复评论，逐条做"修不修"决策、用中文回复（先 `>` 引用解释问题）
并 resolve thread，必要时停下来请人决策。详见 [`skills/babysit-pr/SKILL.md`](../../skills/babysit-pr/SKILL.md)。

回复用中文，提交沿用仓库的 [Conventional Commits 规范](commit-convention.md)。
