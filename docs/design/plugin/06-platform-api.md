# 平台 API:宿主暴露给插件的能力面

> 返回 [插件机制设计主文档](README.md)
>
> 四个故事要求的底座 API 不能散落在各模块里,应形成稳定能力面。所有 API 经 JSON-RPC 由 plugind 提供,每次调用都过权限检查并写审计。带 SDK 的语言里表现为 `ctx.<域>.<方法>()`。

## 1. v1 API

### Workspace API

```text
workspace.info()                          # 当前工作区路径、分支
workspace.diff({ base, target, paths })   # 结构化 diff
workspace.files({ glob })
workspace.readFile({ path, maxBytes })    # 限制在工作区内,防穿越
workspace.lease({ scope, ttl })           # 工作区互斥租约(写类 job 用),到期/释放自动解除
```

用途:review 插件取审查上下文;monitor 读配置。**并发约束**:多个插件可能同时想改同一工作区(如两个 fixer)。约定:同一 workspace + 同一 job type 默认串行;要做写操作(spawn fixer、跑会改文件的命令)的 job 先 `workspace.lease`,拿不到就排队或降级为只读分析,租约随 job 结束释放,plugind 兜底按 ttl 过期。

### Agent API

```text
agent.providers()                         # 发现可用 provider(claude/codex/...)及版本
agent.spawn({ provider, role, prompt, workdir, sessionName, labels, interactive })
agent.capture({ sessionName, tailLines })
agent.send({ sessionName, text })
agent.stop({ sessionName })
```

用途:受控启动与串联 claude/codex,插件不自己拼 shell。`labels`(如 `{job:'job-42', role:'reviewer'}`)与 owner(spawn 者插件 id)由 plugind 记入注册表,是插件**持有并组织多个会话**的句柄机制,见 [04-architecture.md](04-architecture.md) 2.5 节。实现前置:重构 `internal/command/spawn/agent.go` 的硬编码两分支为 provider 接口。

### Session API

```text
session.list({ owner, labels, status })   # owner:'self' 取自己 spawn 的;全局读需 sessions:read
session.status({ name })
session.capture({ name, tailLines })
session.send({ name, text })      # 高危,需 sessions:write
session.kill({ name })            # 高危,需 sessions:write + policy
```

用途:review、monitor 查看/控制已有 tmux 会话;`list` 的 owner/labels 过滤用于取回自己编排的会话组(跨激活恢复:进度存 storage,会话在 tmux,重启后 list + storage 对账)。插件被禁用时其会话默认保留,`--kill-sessions` 或 policy 可级联清理。

### Command 执行(宿主代执行)

```text
command.exec({ argv, cwd, timeout })      # 仅白名单内;输出与 exit code 由宿主记录
```

用途:quality gate、健康检查。**由宿主执行并留痕**,产生"测试真的跑过"的可信证据;这也是白名单唯一真正可强制的地方。

### Job API

review、监控分类、飞书派活、GitHub review 天然都是"一件有始有终的事",统一成 job 模型,而不是各插件自己用 storage 造轮子:

```text
job.create({ type, workspace, baseRef, targetRef, meta })   # 返回 jobId
job.update({ id, status, result, error })                   # pending/running/blocked/done/failed
job.attachSession({ id, sessionName })                      # job ↔ 会话组的正式关联
job.get({ id }) / job.list({ plugin, type, status })
```

meta.db `jobs` 表:`id / type / plugin / status / workspace / base_ref / target_ref / session_ids / result / error / created / updated`。session labels 里的 `job` 即指向此 id;飞书话题、GitHub PR 都挂在 job.meta 上。CLI/Web 可以直接列出"现在有哪些 job、各到哪一步"。

### Finding API

```text
finding.create({ severity, title, file, line, jobId, evidence: [...] })
finding.update({ id, status, ... })
finding.list({ status, severity, source, jobId })
finding.verify({ id, verdict, evidence })
```

模型要点:

- finding 支持外部引用字段(`externalProvider` / `externalReviewId` / `externalCommentId` / `externalThreadId`),供 github-review 双向关联。存 meta.db,CLI/Web/Agent 读同一份。
- **evidence 是结构化数组,不是自由 JSON**。统一结构:`{ kind, ref, summary, capturedAt }`,`kind ∈ command_run(指向审计里的一次宿主执行)/ session_capture(会话名+行范围)/ diff_snapshot / external_comment / file_range`。这样"测试真的跑过"可以点开 evidence 回溯到宿主执行记录,审计与报告不用解析各插件的私有格式。

### Watcher API

```text
watcher.register({ id, schedule, scope })   # 通常由 manifest 声明,运行时注册用于动态场景
watcher.unregister({ id })
watcher.state({ id })
```

持久化在注册表,plugind 重启后恢复。

### Notification API

```text
notification.publish({ type, severity, title, body, actions, source, dedupeKey })
notification.subscribe({ types })            # 通常由 manifest notificationSinks 声明
notification.ack({ id, actor })
```

`dedupeKey` + 宿主侧限速解决刷屏;所有生产者只发标准通知,飞书/Web/CLI 是不同 sink。

### Storage / 配置

```text
storage.get/set/delete({ key })              # 落 $TTMUX_DATA/plugins/storage/<id>/
config.get()                                 # 合并后的最终配置(经 schema 校验)
```

**配置分层与优先级**(`config.get()` 返回合并结果,低→高):schema 默认值 → 全局配置(设置页/CLI 写入,存 meta.db)→ 工作区覆盖(`<repo>/.ttmux/plugins.json` 的 config 段)。**policy(`plugin-policy.json`)不是配置**,它是权限上限,单独裁决不参与合并;**运行态(job 进度、游标)不进配置**,放 storage。

### 事件订阅(SDK 侧)

```text
ctx.events.on('session:agent.exited', handler)
ctx.events.on('notification:finding.blocking', handler)
```

事件类型与延迟语义见 [04-architecture.md](04-architecture.md) 第 6 节;至少一次投递,handler 幂等。

## 2. v1.5 API

### Secret API

```text
secret.set({ key, value })     # CLI/设置页写入,加密落盘
secret.get({ key })            # 仅 manifest 声明过的 key;每次读取写审计
secret.delete({ key })
```

### Webhook API

```text
webhook.register({ id, path, verify })      # 通常由 manifest 声明
webhook.respond({ requestId, status, body })
```

宿主网关职责:路径隔离(`/plugins/<id>/...`)、签名校验回调、重放保护、限速。开发机通常无公网 IP——飞书优先走长连接模式,GitHub 可用轮询 watcher 兜底(见 [03-stories.md](03-stories.md))。

### Command Intent + Approval API

```text
intent.create({ source, command, args, risk, requiresApproval })
intent.execute({ id }) / intent.reject({ id, reason })
approval.request({ action, summary, risk, source, expiresAt })
approval.decide({ id, decision, actor, reason })
```

所有**外部输入**(飞书 @ 消息/私聊、卡片按钮、webhook)一律先转 intent,经身份绑定/权限/policy/审批/审计后由宿主执行;`approval.decide` 是一次可审计的人类决策,需要身份绑定。

标准 intent 类型(宿主内置执行器,插件只负责创建):

| intent | 作用 | 默认 policy |
|---|---|---|
| `agent.dev-task` | 拉起开发 Agent 会话干活(含写代码;独立分支、只到开 PR) | 绑定用户 + 工作区白名单放行,否则要求审批 |
| `session.send` | 向既有会话追加指令(话题多轮对话) | 限发起该会话的同一外部身份 |
| `plugin.command` | 调用某插件命令(如 `review-mesh.fix`) | 随目标命令的权限走 |
| `session.kill` / `service.restart` | 高危控制 | 默认要求审批 |

### SCM / PR API + Diff Mapping

```text
scm.providers()
scm.pr.get/diff/reviews/comments/checks({ provider, owner, repo, number })
scm.review.createDraft(...) / scm.review.submit({ event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" })
scm.check.publish(...)

diff.mapFileLineToPatchPosition({ diff, path, line, side })
diff.mapFindingToReviewComment({ finding, diff })
```

GitHub/GitLab 共用抽象;Diff Mapping 由底座统一实现,插件不自己猜 GitHub line/position。`REQUEST_CHANGES`、批量 comment、自动 resolve 默认被 policy 禁止,需显式授权;发布走限速队列。

## 3. 阶段 3+ API

### Skill Registry API

```text
skill.register({ pluginId, skillId, path, tools, version })
skill.unregister({ pluginId, skillId })
skill.allowedTools({ skillId })
```

插件附带的 skill 按仓库既有约定安装为 `<名>/SKILL.md` 目录形式(复用 `skills/sync-skills.sh` 的分发路径);skill 只能调用声明且授权的插件工具,插件禁用时同步失效。

## 4. 阶段 5(v1 不做):Swarm API

```text
swarm.list/get/members(...)
swarm.board.createCard/moveCard(...)
swarm.plaza.post(...)
swarm.block/unblock({ name, reason, source })
```

引入时机与前提见 [08-roadmap.md](08-roadmap.md) 阶段 5:插件只通过 hook 与稳定 API(board/plaza/block)参与,核心状态机仍由 Roam 管,v1 不把调度核心开放为可替换。
