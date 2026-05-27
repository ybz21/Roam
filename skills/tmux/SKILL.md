---
name: ttmux
description: >
  使用 ttmux 将复杂任务拆分为多个并行子任务，通过 tmux 会话管理执行。
  支持普通命令并行和多 Claude Agent 编排两种模式。
user-invocable: true
allowed-tools:
  - Bash(ttmux *)
  - Bash(cat ~/.local/share/ttmux/logs/*)
  - Bash(cat ~/.local/share/ttmux/agents/*)
  - Read
---

# /ttmux — 任务拆分与多 Agent 编排

你可以使用 `ttmux`（位于 `~/.local/bin/ttmux`）进行任务拆分和并行执行。

参数: `$ARGUMENTS`

## 什么时候该用

- 用户的任务可以拆成 2 个以上独立子任务并行执行
- 需要同时启动多个 Claude 实例各自完成不同工作
- 长时间运行的命令需要在后台执行并监控
- CI 类场景：lint + test + build 同时跑

## 核心能力

ttmux 有两套编排模式：

### 模式一：命令并行（spawn）

适合跑 shell 命令，如构建、测试、脚本等。

### 模式二：多 Agent（agent）

适合将一个大任务拆给多个 Claude 实例并行完成。每个 Agent 是一个独立的
Claude Code 进程，运行在独立的 tmux 会话中，有自己的上下文。

## 任务拆分原则

收到用户任务后，按以下步骤拆分：

1. **识别独立性** — 哪些子任务之间没有依赖？可以同时做的就并行
2. **控制粒度** — 每个子任务应该是一个清晰的、可独立完成的工作单元
3. **命名清晰** — 用简短的英文小写命名：`auth-api`、`login-ui`、`db-migration`
4. **不超过 6 个** — 并行太多反而低效，通常 2~4 个最佳
5. **定义验收** — 每个子任务的任务描述要包含明确的完成标准

## 工作流：多 Agent 编排

这是最核心的用法——拆分任务给多个 Claude 并行干活。

### 第一步：拆分任务

分析用户需求，识别可并行的子任务。例如用户说"重构用户系统"：

- `auth`: 重构认证模块，改用 JWT
- `profile`: 重构用户资料 CRUD
- `tests`: 补充用户模块的单元测试

### 第二步：启动 Agent 组

```bash
ttmux agent spawn refactor \
  "auth"    "重构认证模块，将 session 认证改为 JWT，更新 src/auth/ 下所有文件" \
  "profile" "重构用户资料的 CRUD 接口，在 src/api/user.ts 中使用新的数据模型" \
  "tests"   "为 src/auth/ 和 src/api/user.ts 补充单元测试，覆盖率目标 80%" \
  --dir /home/ai/project \
  --perm auto
```

可用选项：
- `--dir <目录>` — Agent 工作目录（默认当前目录）
- `--model <模型>` — 指定模型（如 sonnet、opus）
- `--perm <模式>` — 权限模式：`auto`（自动批准）、`plan`（只规划）、`default`
- `--max-turns <N>` — 最大轮次限制

### 第三步：监控状态

```bash
ttmux agent status refactor
```

输出会显示每个 Agent 的运行状态：运行中、已完成、失败。

### 第四步：追加指令

如果某个 Agent 需要补充说明：

```bash
ttmux agent send refactor-auth "认证模块还需要加上 refresh token 的支持"
```

也可以附加到会话直接查看 Agent 工作过程：

```bash
ttmux a refactor-auth
```

按 `Ctrl+b d` 分离回来。

### 第五步：收集结果

```bash
ttmux agent collect refactor          # 人类可读
ttmux agent collect refactor --json   # 结构化输出
```

阅读所有 Agent 的输出，向用户汇总各子任务的完成情况。

### 第六步：清理

```bash
ttmux agent kill refactor
```

**必须清理**，不要留下孤立会话。

## 工作流：命令并行

适合跑 shell 命令（非 Claude 任务）：

```bash
# 创建任务组
ttmux spawn build \
  "lint"  "npm run lint" \
  "test"  "npm test" \
  "types" "npx tsc --noEmit"

# 等待完成并收集
ttmux wait build --timeout 120
ttmux collect build

# 清理
ttmux group kill build
```

## 单个后台任务

不需要拆分时，跑一个后台命令：

```bash
ttmux new bg-task -d               # 创建后台会话
ttmux send bg-task "npm run build" # 发送命令
# ... 继续做其他事 ...
ttmux capture bg-task              # 查看输出
ttmux kill bg-task                 # 清理
```

## 参数分发

当用户通过 `/ttmux` 调用时：

- **无参数** → 执行 `ttmux status`，汇报当前所有会话和任务组状态
- **`run <任务描述>`** → 分析任务，拆分子任务，启动 Agent 组
- **`check <组名>`** → 查看指定组的状态
- **`collect <组名>`** → 收集并汇总结果
- **`clean`** → 清理所有 ttmux 管理的 Agent 组
- **其他** → 直接转发给 ttmux

## 任务描述编写规范

给 Agent 的任务描述要具体、可执行，包含：

1. **做什么** — 明确的目标
2. **在哪做** — 涉及的文件或目录
3. **怎么做** — 技术方案（如果有要求）
4. **完成标准** — 怎样算做完

好的任务描述：
```
重构 src/auth/middleware.ts，将 session 认证改为 JWT。
使用 jsonwebtoken 库，token 过期时间 24h。
确保所有现有的 API 路由仍然正常工作。
```

差的任务描述：
```
改一下认证
```

## 规则

1. 启动前先 `ttmux ls` 检查是否有同名会话
2. 收集结果后才能清理——先 collect 再 kill
3. 每组最多 6 个 Agent
4. 收集结果时优先用 `--json`，方便解析
5. 文件产出类任务，让 Agent 写到项目目录内
6. 某个 Agent 失败了，先 capture 查看原因再决定重试
7. 向用户汇报时，要汇总所有 Agent 的结果，不要遗漏
8. 清理是必须的——不要留下孤立会话占资源
