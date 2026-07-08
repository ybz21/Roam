# Manifest 规范、Contribution Points 与 Activation Events

> 返回 [插件机制设计主文档](README.md)

## 1. Manifest 草案(`roam-plugin.json`)

```json
{
  "manifestVersion": 1,
  "id": "acme.ci",
  "publisher": "acme",
  "name": "ci",
  "displayName": { "zh-CN": "Acme CI", "en-US": "Acme CI" },
  "version": "1.2.0",
  "description": { "zh-CN": "在 Roam 内运行 CI 检查并总结失败原因", "en-US": "Run CI checks and summarize failures inside Roam." },
  "engines": { "roam": ">=0.6.0" },
  "main": "dist/main.js",
  "runtime": { "kind": "node", "activation": "lazy" },
  "permissions": {
    "workspace": ["read"],
    "commands": {
      "allow": ["scripts/dev/quality/check.sh", "npm", "go", "pytest"],
      "deny": ["rm", "git reset"]
    },
    "network": { "allowedDomains": ["https://ci.acme.com"] },
    "sessions": ["read"],
    "agents": ["spawn"],
    "findings": ["read", "write"],
    "notifications": ["publish"],
    "watchers": ["register"],
    "secrets": ["ciToken"]
  },
  "activationEvents": [
    "onCommand:acme.ci.run",
    "onSessionEvent:agent.exited",
    "workspaceContains:.github/workflows/*.yml"
  ],
  "contributes": {
    "commands": [
      { "id": "acme.ci.run", "title": { "zh-CN": "运行 CI 检查", "en-US": "Run CI Checks" }, "category": "CI" }
    ],
    "watchers": [
      { "id": "acme.ci.poll", "schedule": "every 5m", "handler": "pollCi" }
    ],
    "agentTools": [
      { "id": "acme.ci.explainFailure", "description": "Explain the latest CI failure for the active workspace." }
    ],
    "configuration": { "schema": "schemas/config.schema.json" }
  },
  "dynamic": true
}
```

设计要点:

- `manifestVersion` 控制插件协议版本;`engines.roam` 约束宿主兼容性。
- `contributes` 只声明能力,不含实现;宿主不执行插件代码即可建立能力索引(命令面板、MCP 工具列表、watcher 计划)。
- `permissions` 是**声明上限**;实际授予 = min(声明, workspace policy, 用户授权)。其约束力边界见 [07-security.md](07-security.md)——v1 只在宿主 API 侧强制。
- `runtime.kind`:`node`(宿主用内置约定拉起,官方 SDK)或 `exec`(任意可执行文件,协议同为 JSON-RPC over stdio)。
- `runtime.resident: true`:常驻型插件(如维持飞书长连接的 feishu-bridge),激活后不适用空闲回收;需要对应权限且默认仅限 built-in / 高信任插件。
- `main` 是插件的**后端进程**入口——插件主体是后端程序,UI 是可选附件(v2 增加顶层 `ui` 字段)。
- 面向宿主展示的 `displayName` / `description` / `title` 支持 locale map(zh-CN / en-US)。
- `dynamic: false` + `requiresServiceRestart: true` 用于声明不满足动态卸载条件的插件。

## 2. Contribution Points

| 扩展点 | 用途 | 示例 | 分期 |
|---|---|---|---|
| `commands` | **人类入口**:CLI / Web 命令面板调用,返回面向人的结构化结果 | `acme.ci.run` | v1 |
| `configuration` | 插件设置 schema(宿主自动渲染表单) | CI token、巡检间隔 | v1 |
| `watchers` | 持久定时巡检 | 每 2 分钟巡检 session | v1 |
| `agentTools` | **Agent 专用入口**:经 MCP 桥暴露给 claude/codex,带严格参数 schema,返回机器可消费结果 | 解释 CI 失败、写 finding | v1 |
| `notificationSinks` | 外部通知通道 | 飞书、Slack、邮件 | v1(接口),v1.5(外发) |
| `webhooks` | 外部系统回调入口 | 飞书卡片按钮、GitHub PR 事件 | v1.5 |
| `scmProviders` | 源码托管 / PR 数据源 | GitHub PR、GitLab MR | v1.5 |
| `reviewPublishers` | 发布 review / check 结果 | GitHub PR Review、Check Run | v1.5 |
| `secretProviders` | 接入密钥来源 | 1Password、Vault、env | v2 |
| `views` | Web 面板、卡片、设置页区域(iframe) | finding 面板 | v2 |
| `menus` | Web 操作入口 | 命令面板、右键菜单 | v2 |
| `workspaceScanners` | 项目扫描与能力发现 | 识别 pnpm/go/python 项目 | v2 |
| `taskProviders` | 提供可运行任务 | 测试、构建、部署 | v2 |
| `skills` | 随插件分发 Agent 操作手册(SKILL.md 目录形式) | review comments 处理 skill | 阶段 3+ |
| `swarmHooks` | swarm 生命周期事件 | 成员完成后互审 | **阶段 5,v1 不做** |
| `extensionPoints` | 插件自定义二级扩展点 | `acme.ci.reportRenderer` | v2+ |

**`commands` 与 `agentTools` 的边界**:两者是不同受众的两个入口,不互通——

- `commands` 面向人(CLI/Web),**不会自动出现在 Agent 的 MCP 工具列表里**;Agent 若确需触发某插件命令,走 `plugin.command` 类型的 Command Intent(经权限/policy),而不是直接调用。
- `agentTools` 面向 Agent,参数用严格 JSON Schema 定义(MCP 侧会做校验),返回值设计成机器可消费的结构化数据;它也不出现在人的命令面板里。
- 同一个能力想同时给两边用,分别声明两个入口、共享内部实现——两个入口可以有不同的参数面和输出形态。

## 3. Activation Events

| 事件 | 触发条件 | 分期 |
|---|---|---|
| `onCommand:<id>` | 用户、Web 或 Agent 调用命令 | v1 |
| `onAgentTool:<id>` | Agent 经 MCP 调用插件工具 | v1 |
| `onSchedule:<watcherId>` | watcher 定时触发 | v1 |
| `onSessionEvent:<event>` | session 创建、退出、静默;agent 拉起/退出 | v1 |
| `onNotification:<type>` | finding、告警、审批等通知产生(`*` 表全部) | v1 |
| `workspaceContains:<glob>` | 当前项目包含匹配文件(仅轻量 glob,不执行插件代码) | v1 |
| `onStartupFinished` | plugind 启动完成后低优先级激活(常驻型插件,如飞书长连接) | v1 |
| `onWebhook:<id>` | 外部 webhook 命中 | v1.5 |
| `onScmEvent:<event>` | PR 更新、review 提交、comment 创建 | v1.5 |
| `onView:<id>` | Web 打开插件视图 | v2 |
| `onBrowserEvent:<event>` | chrome CLI 完成截图、导航、测试 | v2 |
| `onSwarmEvent:<event>` | swarm 生命周期事件 | **阶段 5** |
| `*` | 总是激活;默认禁用,仅 built-in / 高信任插件允许 | v1 |

激活规则:

- 默认 lazy;不允许插件在 plugind 启动时全量拉起(`onStartupFinished` 需要对应权限声明)。
- 同一插件多事件命中只启动一个进程;激活超时默认 10s(可配),超时标记 `unhealthy`。
- 事件为至少一次投递,handler 必须幂等(见 [04-architecture.md](04-architecture.md) 第 6 节)。
