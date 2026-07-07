# 四个插件故事:场景、插件形态与能力倒推

> 返回 [插件机制设计主文档](README.md)
>
> 插件机制要先服务"智能工作流",而不是先做泛化市场。本文用四个具体插件故事倒推底层能力,并给出**每个插件具体长什么样**:目录结构、manifest、前后端组成、运行形态。
>
> **注意:按范围声明,v1 插件不涉及 swarm。** 原设计中挂在 swarm 生命周期上的触发点,一律改为会话(session)/ Agent 级触发;swarm 版本的故事在阶段 5 重新展开。

四个故事:

1. **Code Review 插件(review-mesh)**:Codex 与 Claude 互审,形成 finding、修复、复验闭环。
2. **自动监控插件(monitor)**:持续监控 session、Agent、服务和长任务,异常时先总结再升级。
3. **飞书消息插件(feishu-bridge)**:在飞书群 @ 机器人或私聊即可给开发机派活(包括代码开发),Agent 进度与结果回帖到同一话题;Roam 关键事件也推送到飞书。
4. **GitHub Code Review 插件(github-review)**:本地 Agent 互审与 GitHub PR Review、Checks 双向打通。

---

## 1. 故事一:Code Review 插件(review-mesh)

### 1.1 用户场景

用户让 Claude 完成一个功能。Claude 的会话结束(或用户手动触发)后,插件拉起 Codex 做严格审查。

**自动触发必须满足归因条件,不是"任何 Agent 会话退出都审"**——人手工开的会话不一定是开发任务。`agent.exited` 触发 review 需至少命中其一:①会话带 `review:auto=true` 标签(spawn 时声明);②会话由飞书 intent / 插件 job 创建(有 owner);③工作区存在可归因的 base/target diff 且配置开启了 auto-review。都不命中就只能手动 `review-mesh.review`。

```text
claude 会话结束(agent.exited 事件,通过归因条件)或用户执行 review-mesh.review
  -> 插件取 workspace.diff(工作区当前变更)
  -> agent.spawn 启动 codex reviewer 会话
  -> codex 输出结构化 findings(经插件的 agentTool 写回)
  -> high/critical finding 产生 blocking 通知
  -> 用户或 fixer agent 修复
  -> 插件跑 quality gate + codex 复审
  -> findings verified 后发 resolved 通知
```

用户看到的不是一段松散聊天,而是结构化质量状态:

```text
$ ttmux plugin run review-mesh.status
智能互审
- Blocking findings: 2
- Fixed pending verification: 1
- Verified: 5
- Last reviewer: codex
- Gate: scripts/dev/quality/check.sh quick passed
```

### 1.2 插件长什么样

**前后端组成:纯后端插件**。`main` 进程实现全部逻辑;finding 的展示走 CLI 命令输出和通知流,v2 再加 Web 面板。

```text
review-mesh/
├── roam-plugin.json
├── README.md
├── dist/
│   └── main.js              # 插件后端进程入口
├── prompts/
│   ├── reviewer.md          # codex reviewer 提示词模板
│   └── verifier.md
└── schemas/
    └── config.schema.json   # 严格度、门禁命令等配置
```

```json
{
  "manifestVersion": 1,
  "id": "roam.review-mesh",
  "publisher": "roam",
  "name": "review-mesh",
  "version": "0.1.0",
  "engines": { "roam": ">=0.6.0" },
  "main": "dist/main.js",
  "runtime": { "kind": "node", "activation": "lazy" },
  "permissions": {
    "workspace": ["read"],
    "commands": { "allow": ["scripts/dev/quality/check.sh", "git diff", "git status"] },
    "agents": ["spawn", "capture", "send"],
    "sessions": ["read"],
    "findings": ["read", "write"],
    "notifications": ["publish"]
  },
  "activationEvents": [
    "onCommand:review-mesh.review",
    "onCommand:review-mesh.status",
    "onSessionEvent:agent.exited"
  ],
  "contributes": {
    "commands": [
      { "id": "review-mesh.review", "title": { "zh-CN": "互审当前变更", "en-US": "Review current changes" } },
      { "id": "review-mesh.verify" },
      { "id": "review-mesh.status" }
    ],
    "agentTools": [
      { "id": "review-mesh.createFinding", "description": "Create a structured review finding." },
      { "id": "review-mesh.resolveFinding" }
    ],
    "configuration": { "schema": "schemas/config.schema.json" }
  }
}
```

`main.js` 骨架(SDK 用法详见 [09-plugin-development.md](09-plugin-development.md)):

```js
const { activate } = require('@roam/plugin-sdk')

activate(ctx => {
  ctx.commands.register('review-mesh.review', async () => {
    const jobId = await newJobId(ctx)      // 会话名带 job id 防并发冲突;labels 是会话组句柄
    const diff = await ctx.workspace.diff({})
    const s = await ctx.agents.spawn({ provider: 'codex', role: 'reviewer',
      prompt: renderPrompt('reviewer', { diff }),
      sessionName: `review-mesh-${jobId}-rv1`,
      labels: { job: jobId, role: 'reviewer' } })
    // reviewer 通过 MCP 调 review-mesh.createFinding 写回结构化 finding
  })
  ctx.events.on('session:agent.exited', async ev => {
    // 归因判定:review:auto 标签 / intent 或插件 job 创建 / 配置开启且有可归因 diff
    if (await shouldAutoReview(ctx, ev)) { /* 同上 */ }
  })
  ctx.agentTools.register('review-mesh.createFinding', async args =>
    ctx.findings.create({ ...args, source: 'review-mesh' }))
})
```

### 1.3 它用到的底层能力

| 底层能力 | 使用方式 |
|---|---|
| Workspace API | `workspace.diff` 取变更、分支、目标 |
| Agent API | 发现 codex/claude 可用性,按角色受控拉起 reviewer/fixer |
| Session API | review 会话可 capture、attach、kill |
| Session 事件 | 订阅 `agent.exited` 触发自动审查 |
| Finding API | 保存 finding、状态、证据、验证记录;CLI/Web/Agent 读同一份 |
| 宿主命令执行 | quality gate 由宿主执行并记录输出——"测试真的跑过"的证据来自宿主执行记录,不是 Agent 自称 |
| Notification API | blocking / resolved 状态变化发布为标准通知 |
| MCP 桥 | reviewer agent 调 `createFinding` 写结构化结果,不靠解析聊天文本 |
| 审计 | 谁发起 review、跑了哪些命令、哪些 finding 阻塞,全程可查 |

> 本故事的完整产品与算法设计见 [../智能评审插件设计.md](../智能评审插件设计.md);该文档中的 manifest 与存储设计需按本目录规范对齐(finding 走平台 Finding API,而非插件私有表)。

---

## 2. 故事二:自动监控插件(monitor)

### 2.1 用户场景

用户开了几个 Agent 会话跑大任务,然后离开电脑。监控插件持续观察:

- 哪些 session 长时间无输出;哪些 Agent 卡在确认提示、权限请求、测试失败。
- 哪些开发服务挂了;哪些长任务超过预期时间。

异常发生后,插件不是简单报警,而是先让轻量 Agent 总结现场:

```text
monitor detected: session "api-dev" no output for 25m
  -> session.capture 取最近 200 行
  -> 拉起轻量 classifier agent 分类: waiting_approval / stuck / long_test / crashed
  -> waiting_approval: 发通知请人处理(飞书插件会转发)
  -> test failed: 发 blocking 通知 + 可选拉起 fixer agent
  -> service down: 按 policy 允许则重启,否则仅告警
```

### 2.2 插件长什么样

**前后端组成:纯后端插件**。watcher 注册在宿主调度器上(持久化,plugind 重启后恢复),插件进程仅在触发时被激活。

```text
monitor/
├── roam-plugin.json
├── dist/main.js
└── schemas/config.schema.json    # 巡检间隔、静默阈值、服务清单
```

manifest 关键部分:

```json
{
  "id": "roam.monitor",
  "main": "dist/main.js",
  "permissions": {
    "sessions": ["read"],
    "agents": ["spawn"],
    "commands": { "allow": ["curl", "systemctl status"] },
    "watchers": ["register"],
    "notifications": ["publish"]
  },
  "activationEvents": [
    "onSchedule:monitor.patrol",
    "onSchedule:monitor.service-health",
    "onCommand:monitor.status"
  ],
  "contributes": {
    "commands": [
      { "id": "monitor.enable" }, { "id": "monitor.disable" }, { "id": "monitor.status" }
    ],
    "watchers": [
      { "id": "monitor.patrol", "schedule": "every 2m", "handler": "patrolSessions" },
      { "id": "monitor.service-health", "schedule": "every 30s", "handler": "checkServices" }
    ],
    "configuration": { "schema": "schemas/config.schema.json" }
  }
}
```

### 2.3 它用到的底层能力

| 底层能力 | 使用方式 |
|---|---|
| Watcher 调度器 | 持久定时巡检;Roam 重启后由 plugind 恢复 |
| Session 事件 + 轮询 | 有事件(`session.exited`)时实时,无事件时定时巡检兜底 |
| Session API | `session.list` / `session.capture` 判断是否卡住 |
| Agent API | 拉起轻量 classifier agent 做现场分类与摘要 |
| 宿主命令执行 | 健康检查命令(白名单内) |
| Policy | 自动重启/kill/追加指令必须经 policy 允许,否则降级为仅告警 |
| Notification API | 标准异常模型:`stuck` / `failed` / `waiting_approval` / `timeout` / `flapping` |
| 状态存储 + 去重 | watcher 状态、上次检查时间、异常去重 key;同一问题 5 分钟内不重复发,超阈值升级 |

---

## 3. 故事三:飞书消息插件(feishu-bridge)

### 3.1 用户场景

核心场景:**飞书就是遥控开发机的入口**。有人在飞书群里 @ 机器人,或者直接私聊,就能给 Roam 派活——包括真正的代码开发,人不需要在电脑前:

- 群里 @:"@Roam 在 ttmux 项目修一下登录页在手机上错位的 bug" → 拉起 claude 开发会话,干完回帖。
- 私聊:"帮我把昨天那个 PR 的 review 意见都处理了" → 拉起 fixer agent。
- 话题内追问:"进展如何?" / "顺便把单测补了" → 转给同一个 Agent 会话,多轮持续对话。
- 反向:Agent 会话完成/失败/等待确认时推送到飞书;review-mesh 发现 high finding 时推送摘要,卡片带 `批准` / `拒绝` / `派给 Claude 修复` 按钮。

**派活主链路(含代码开发)**:

```text
飞书群 @Roam "修复登录页手机端错位,修完跑下测试"
  -> 事件经飞书长连接(或 webhook 网关)进入 feishu-bridge,校验签名
  -> 身份绑定检查: 该飞书用户是否绑定 Roam 操作者、是否有派活权限
  -> 意图解析: 规则匹配(status/approve 等短指令)直接处理;
     自由文本交给轻量 classifier agent 解析出 {任务类型, 目标工作区, 任务描述}
  -> 创建 Command Intent: agent.dev-task { workspace: ~/codes/ttmux,
       provider: claude, prompt: <任务描述+验收要求> }
  -> policy 裁决: 绑定用户 + 白名单工作区 -> 放行(或要求飞书卡片二次确认)
  -> 宿主执行 intent: agent.spawn 拉起 claude 开发会话
  -> 插件把 {飞书话题 id <-> 会话名} 存入 ctx.storage,回帖"已开工,会话 dev-fix-a1"
  -> Agent 干活期间: 关键进度(测试通过/失败、等待确认)经通知流回帖同一话题
  -> agent.exited 事件 -> 插件取会话摘要 + workspace.diff 摘要,回帖结果卡片
     [查看 diff] [跑质量门禁] [让 codex review] [继续修改]
  -> 用户在话题里追加"顺便把单测补了" -> 映射到既有会话 -> intent: session.send
```

约束与安全边界:

- **外部输入永不直接执行**:飞书消息一律先转 Command Intent,经身份绑定 → 权限 → policy →(可选)审批 → 审计,才落到 `agent.spawn` / `session.send`。
- **代码开发的产物默认走既有守规矩流程**:Agent 在独立分支上工作、只到开 PR 为止,合并永远留给人;可配置完工后自动触发 review-mesh 互审。
- 未绑定的飞书用户只能查询状态,不能派活;高危任务类型(改基础设施、动生产配置)policy 可强制要求卡片二次确认。

### 3.2 插件长什么样

**前后端组成:纯后端插件——这是"插件有没有后端程序"的标准答案**。飞书插件没有任何自己的页面:它是一个常驻的后端程序,双向工作——出站订阅 Roam 通知调飞书 OpenAPI 发卡片,入站接收 @ 消息/私聊/按钮回调并转成受控 intent;唯一的"界面"是宿主根据 `config.schema.json` 自动渲染的设置表单(填 app id/secret、默认群、工作区白名单)。

因为要接收消息,它是典型的**常驻型插件**:`onStartupFinished` 激活后维持飞书长连接,不适用"空闲即回收",manifest 里声明 `runtime.resident: true`。

```text
feishu-bridge/
├── roam-plugin.json
├── dist/main.js
├── templates/
│   ├── task-card.json         # 派活确认/进度卡片
│   ├── result-card.json       # 完工结果卡片(diff 摘要 + 后续动作按钮)
│   ├── finding-card.json
│   └── approval-card.json
└── schemas/config.schema.json
```

manifest 关键部分:

```json
{
  "id": "roam.feishu-bridge",
  "main": "dist/main.js",
  "runtime": { "kind": "node", "resident": true },
  "permissions": {
    "notifications": ["subscribe"],
    "network": { "allowedDomains": ["https://open.feishu.cn"] },
    "secrets": ["feishuAppId", "feishuAppSecret", "feishuVerificationToken"],
    "webhooks": ["receive"],
    "intents": ["create"],
    "agents": ["spawn"],
    "sessions": ["read"],
    "workspace": ["read"]
  },
  "activationEvents": [
    "onNotification:*",
    "onWebhook:feishu.callback",
    "onStartupFinished"
  ],
  "contributes": {
    "notificationSinks": [
      { "id": "feishu.send",
        "events": ["finding.blocking", "monitor.alert", "approval.requested", "agent.completed"] }
    ],
    "webhooks": [
      { "id": "feishu.callback", "path": "/plugins/feishu/callback", "handler": "handleCallback" }
    ],
    "commands": [ { "id": "feishu.test" }, { "id": "feishu.bind-user" }, { "id": "feishu.tasks" } ],
    "configuration": { "schema": "schemas/config.schema.json" }
  }
}
```

权限解释:`agents:spawn` 仅用于意图解析的轻量 classifier 会话(把自由文本变成结构化任务);**真正的开发任务不是插件直接 spawn 的**,而是插件创建 intent、由宿主在 policy 裁决后执行——派活权限属于 intent 链,不属于插件本身。`sessions:read` + `workspace:read` 用于生成进度和结果卡片(会话摘要、diff 摘要)。

**公网可达性问题(必须解决)**:Roam 跑在开发机上,通常没有公网 IP,飞书 HTTP 回调无法直达。两条路:

1. **推荐:飞书事件长连接模式**——飞书开放平台支持通过 WebSocket 长连接订阅事件与卡片回调,无需公网 URL。插件作为客户端主动连接,完全绕开公网入口问题。落地前需验证卡片交互回调在长连接模式下的覆盖范围。
2. 备选:HTTP 回调 + 用户自备反代/内网穿透,宿主 webhook 网关做路径隔离、签名校验、重放保护、限速。

### 3.3 它用到的底层能力

| 底层能力 | 使用方式 |
|---|---|
| Webhook 网关(v1.5)或飞书长连接 | 接收 @ 消息、私聊、卡片按钮回调 |
| 身份绑定 | 飞书用户 ↔ Roam 操作者;未绑定只能查询,不能派活;派活权限按用户分级 |
| Agent API | 拉起轻量 classifier 解析自由文本意图(仅此用途) |
| Command Intent API | **派活主通道**:@ 消息/按钮 → intent(`agent.dev-task` / `session.send` / `review-mesh.fix`)→ 权限/policy/审批 → 宿主执行,插件永不直接执行 |
| Approval API | 卡片"批准/拒绝"映射为一次可审计的人类决策;高危任务类型强制二次确认 |
| Session API + Workspace API | 取会话摘要与 diff 摘要,渲染进度/结果卡片 |
| 插件存储 | `飞书话题 id ↔ Agent 会话名` 映射,支撑话题内多轮追加指令 |
| Notification API | 出站方向:订阅标准通知事件转发飞书;Agent 干活期间的进度回帖也走这里 |
| Secret API | app id/secret/token 加密存储,不落仓库不进日志 |
| 限速与去重 | 同一告警不刷屏;进度回帖合并节流 |

---

## 4. 故事四:GitHub Code Review 插件(github-review)

### 4.1 用户场景

团队在 GitHub PR 上协作,希望 Roam 的 Agent 互审参与远程 PR review:

- PR 创建/更新后,拉取 PR diff、已有 review comments、check 状态,启动 codex/claude review。
- findings 先内部记录,按 policy 决定发布为 GitHub review comments、`COMMENT` 或 `REQUEST_CHANGES`。
- GitHub 上人类 reviewer 的评论回流,插件发通知并可拉起 fixer agent 会话处理(替代原设计中"回流成 swarm 修复任务")。

```text
GitHub pull_request.synchronize webhook(或 ttmux plugin run github-review.review-pr 123)
  -> 校验签名 -> 拉 PR metadata/diff/comments/checks
  -> diff 对齐到本地 checkout
  -> agent.spawn codex reviewer -> findings 入 Finding API
  -> policy 决定发布模式: internal-only / COMMENT / REQUEST_CHANGES
  -> Diff Mapping 把 finding 行号映射到 PR diff 坐标,发布 review comments
  -> review summary 写成 GitHub Check Run
  -> 人类评论回流 -> 通知 + 可选 fixer agent
```

GitHub 侧技术约束(设计时必须考虑):

- PR review 是一组 review comments + 一个状态(`APPROVE` / `REQUEST_CHANGES` / `COMMENT`)。
- 行内评论要定位到 **PR diff 的行/position**,不是源文件行号,必须有 Diff Mapping。
- 过快批量发布会触发 secondary rate limiting,需要队列与节流。
- 机器状态、summary、annotations 更适合 Check Runs;需要作者处理的意见才用 review comments。

### 4.2 插件长什么样

**前后端组成:纯后端插件**(v2 可加 PR 状态面板)。无公网时靠手动命令/定时轮询 PR 状态替代 webhook,`gh` CLI 已登录的凭据可作为 v1 的 token 来源。

```text
github-review/
├── roam-plugin.json
├── dist/main.js
├── prompts/pr-reviewer.md
└── schemas/config.schema.json     # 仓库映射、发布模式、节流参数
```

manifest 关键部分:

```json
{
  "id": "roam.github-review",
  "main": "dist/main.js",
  "permissions": {
    "workspace": ["read"],
    "agents": ["spawn"],
    "findings": ["read", "write"],
    "scm": ["read", "write"],
    "secrets": ["githubToken"],
    "webhooks": ["receive"],
    "notifications": ["publish"],
    "watchers": ["register"]
  },
  "activationEvents": [
    "onCommand:github-review.review-pr",
    "onWebhook:github.pull_request",
    "onSchedule:github-review.poll"
  ],
  "contributes": {
    "commands": [
      { "id": "github-review.review-pr" },
      { "id": "github-review.publish-findings" },
      { "id": "github-review.sync-comments" }
    ],
    "webhooks": [
      { "id": "github.pull_request", "path": "/plugins/github-review/webhook", "handler": "handleWebhook" }
    ],
    "watchers": [
      { "id": "github-review.poll", "schedule": "every 5m", "handler": "pollPRs" }
    ],
    "agentTools": [
      { "id": "github-review.createPrFinding" },
      { "id": "github-review.replyToReviewComment" }
    ],
    "configuration": { "schema": "schemas/config.schema.json" }
  }
}
```

### 4.3 它用到的底层能力

| 底层能力 | 使用方式 |
|---|---|
| SCM / PR API(v1.5) | 读 PR、diff、reviews、comments、checks;提交 review——GitHub/GitLab 共用抽象,API 细节不散进 Agent prompt |
| Diff Mapping API | finding 文件/行号 → PR diff line/position,由底座统一提供,插件不自己猜 |
| Finding API | finding 与 GitHub review comment 双向关联(`externalProvider/externalCommentId/...`) |
| Webhook 网关 或 轮询 watcher | 事件进入方式二选一,轮询是无公网环境的兜底 |
| Secret API | GitHub token / webhook secret;v1 可引用 `gh` 已有凭据 |
| Agent API | 拉起 reviewer,产出可发布 comments |
| Policy | `REQUEST_CHANGES`、批量 comment、自动 resolve 默认禁止,需显式授权 |
| 限速队列 | 控制发布节奏 |
| Notification API | 回流评论 → 通知 → 可选 fixer agent(v1 的"修复任务"形态) |

---

## 5. 倒推的底层能力矩阵(v1 不含 swarm)

| 底层能力 | review-mesh | monitor | feishu | github-review | 分期 |
|---|---:|---:|---:|---:|---|
| Manifest / Registry / Host / RPC | 是 | 是 | 是 | 是 | v1 |
| Command contribution | 是 | 是 | 是 | 是 | v1 |
| 权限声明 + 宿主 API 约束 + 审计 | 是 | 是 | 是 | 是 | v1 |
| 事件日志与订阅(session/agent/notification) | 是 | 是 | 是 | 部分 | v1 |
| Workspace API | 是 | 部分 | 部分 | 是 | v1 |
| Agent API(provider 抽象) | 是 | 是 | 部分 | 是 | v1 |
| Session API | 是 | 是 | 部分 | 部分 | v1 |
| Finding API | 是 | 部分 | 部分 | 是 | v1 |
| Watcher 调度器 | 否 | 是 | 否 | 部分 | v1 |
| Notification API | 是 | 是 | 是 | 是 | v1 |
| MCP 桥(agentTools) | 是 | 否 | 否 | 是 | v1 |
| Secret API | 否 | 部分 | 是 | 是 | v1.5 |
| Webhook 网关 | 否 | 否 | 是 | 是 | v1.5 |
| Command Intent + Approval API | 部分 | 是 | 是 | 是 | v1.5 |
| SCM / PR API + Diff Mapping | 否 | 否 | 否 | 是 | v1.5 |
| Check Publisher | 否 | 否 | 否 | 是 | v1.5 |
| Web View contribution | 是 | 是 | 是 | 是 | v2 |
| Swarm 事件与 hooks | — | — | — | — | 阶段 5(v1 明确不做) |

结论:

- v1 = review-mesh + monitor 两个故事完整跑通:manifest/host/RPC、commands、session 事件、watcher、Agent API、Finding、Notification、审计。
- 飞书与 GitHub 是 v1.5:它们引入 secret、外部回调、身份绑定、intent/approval,安全面更大;但 v1 的 Notification API 必须为它们预留 sink 形态。**飞书派活(含代码开发)是 v1.5 的核心验收场景**,它把 intent/approval/身份绑定/常驻插件四个能力一次性验真。
- 全部四个故事都不需要 swarm 就能成立;swarm 化(如 member.completed 触发互审、finding 阻塞集成门禁)是阶段 5 的增强,不是前提。

## 6. Plugin、Skill、Workflow 的关系

Roam 里会同时存在 plugin、skill、workflow、MCP/connector,不能混成一团:

| 类型 | 本质 | 负责什么 | 不负责什么 |
|---|---|---|---|
| Plugin | 可执行能力包(后端进程) | API、命令、事件、存储、权限、外部系统接入 | 不决定 Agent 应该怎样思考 |
| Skill | Agent 操作手册 | 审查策略、流程、提示词、判断标准、何时调用插件工具 | 不持有密钥、不提供常驻后台服务 |
| Workflow | 可编排流程 | 把插件能力和 skill 步骤串成状态机 | 不实现底层 API |
| Connector / MCP | 外部授权数据面 | GitHub、飞书、文档等授权访问 | 不承载 Roam 内部状态机 |

一句话:**Plugin 提供"能做什么",Skill 定义"怎么做好",Workflow 管"何时做、做到哪一步"。**

以 github-review 为例:GitHub API 变了只改 plugin;review 策略变了只改 skill;团队流程变了只改 workflow/policy;Agent 不需要知道 GitHub API 细节,只调用 `github-review.publishFindings` 这类稳定工具。

插件可以附带 skill(`contributes.skills`,阶段 3+):

- 安装插件时注册 skill(按仓库现有约定装成 `<名>/SKILL.md` 目录形式,见 `skills/sync-skills.sh`),标记来源和版本。
- skill 只能调用它声明且被授权的插件工具;插件禁用时对应 skill 同步失效。
- 权限链:`Agent -> Skill -> Plugin Tool -> 宿主权限检查 -> 审计 -> 外部 API`,任何一步不能绕过;skill 不能直接读 secret,高危动作可要求 human approval。
