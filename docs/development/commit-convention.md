# 提交信息规范（Commit Convention）

随着参与者增多，提交历史需要保持可读、可检索、可自动化。本仓库采用
[Conventional Commits](https://www.conventionalcommits.org/) 的轻量子集，并由
`commit-msg` Git 钩子在本地强制校验。

## 格式

```
<type>(<scope>): <描述>

<正文，可选>

<脚注，可选>
```

- **type**：必填，见下表。
- **scope**：可选，标明改动范围，小写，如 `tls`、`mobile`、`cli`、`backend`、`frontend`。
- **描述**：必填。仓库默认用**中文**，祈使语气，结尾不加句号。标题（含 `type` 前缀）建议 ≤ 72 字符。
- 破坏性变更：在 `type`/`scope` 后加 `!`，并在脚注写 `BREAKING CHANGE: …`。

校验只检查**结构**，不限制描述语言——中英文都能过。

### type 取值

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `style` | 格式（不影响逻辑：空格、格式化等） |
| `refactor` | 重构（既非新功能也非修复） |
| `perf` | 性能优化 |
| `test` | 测试 |
| `build` | 构建系统 / 依赖 |
| `ci` | CI 配置与脚本 |
| `chore` | 杂项（不改 src 或测试） |
| `revert` | 回滚某次提交 |

## 示例

```
feat(tls): 自签证书拆分根 CA + 叶子，新增「下载证书」入口
fix(mobile): 软键盘悬浮不再挤压布局
docs: 补充 README 安装步骤
refactor(cli)!: 重命名 swarm done 子命令

BREAKING CHANGE: swarm done 改名为 swarm finish，旧命令移除。
```

## 启用校验

```bash
bash scripts/dev/install-git-hooks.sh
```

它会：

- 设置 `core.hooksPath=.githooks`，启用 `pre-commit`（质量门）与 `commit-msg`（本规范）。
- 设置 `commit.template=.gitmessage`，`git commit` 时自动带出模板提示。

`Merge` / `Revert` / `fixup!` / `squash!` 等自动生成的提交会被钩子放行。

## PR 标题

合并采用 Squash 时，PR 标题会成为最终提交标题，因此 **PR 标题也应遵循同一规范**。
