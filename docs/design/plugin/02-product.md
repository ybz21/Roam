# 产品设计:定位、插件类型、用户旅程、治理

> 返回 [插件机制设计主文档](README.md)

## 1. 产品定位

插件机制不是给 Roam 增加"脚本目录",而是把 Roam 变成一个可扩展的开发工作空间平台:插件能组织会话、拉起并串联 claude / codex 等 Agent、订阅事件、对接外部系统,形成智能工作流。

插件要服务三类用户:

| 用户 | 需求 | 可用版本 |
|---|---|---|
| 普通开发者 | 一键安装团队常用能力,例如代码互审、自动监控、飞书通知、PR 巡检 | v1 |
| 第三方开发者 | 用稳定 API 接入自己的 Agent、平台、流程 | v1 |
| 团队管理员 | 统一分发插件、限制权限、锁定版本、审计执行记录 | v2+(依赖多用户体系,见下文校准) |

**校准**:Roam 当前是单口令单用户(`backend/auth/auth.go`,HMAC token + 可选 TOTP),没有多用户与 RBAC。"团队管理员"的统一分发/限权诉求在 v1 只能通过**提交到仓库的 policy 文件**近似实现(`.ttmux/plugin-policy.json`),真正的组织治理依赖后续多用户体系。审计日志的"操作者"字段在 v1 取值为本机用户/Agent 会话名。

## 2. 插件的组成形态:后端为主体,前端可选

**插件不是纯前端的。插件的主体是一个后端进程**(manifest 里的 `main`,由插件宿主拉起、通过 JSON-RPC 通信),前端 UI 是可选附件:

| 形态 | 组成 | 例子 |
|---|---|---|
| 纯后端插件(v1 主流) | 仅 `main` 进程:命令 handler、watcher、事件订阅、外部 API 调用 | **飞书消息插件就是纯后端程序**:常驻订阅 Roam 通知 → 调飞书 API 发卡片;经宿主 webhook 网关接收飞书回调。没有自己的页面也完全成立 |
| 后端 + 设置页 | `main` + 配置 schema(宿主自动渲染设置表单,插件不用写前端) | 飞书插件的 app id/secret 配置、监控插件的巡检间隔 |
| 后端 + 自带 UI(v2) | `main` + `ui`(iframe 沙箱里的静态页,postMessage 与宿主桥通信) | 评审插件的 finding 面板、CI 状态卡 |

**v1 不支持纯前端运行时插件**:任何运行时能力(哪怕只是展示)都需要 `main` 进程作为数据来源与权限主体;v1 甚至不提供 UI 注入(`views` contribution 是 v2),插件的展示面是 CLI 输出、通知流和宿主自动渲染的设置表单。后续可考虑无 `main` 的"纯 manifest 插件"(只贡献命令别名、配置 preset、文档入口等静态声明),不在 v1 范围。详见 [04-architecture.md](04-architecture.md) 第 3 节。

## 3. 插件类型(按产品能力分)

| 类型 | 示例 | 主要入口 | 版本 |
|---|---|---|---|
| Command 插件 | `ttmux plugin run acme.ci.run` | CLI / Web 命令面板 / Agent tool | v1 |
| Watcher 插件 | 会话巡检、服务健康检查、卡死检测 | watcher 调度器 | v1 |
| Agent Tool 插件 | 数据库查询、代码知识库检索、CI 日志分析 | MCP 桥暴露给 claude/codex | v1 |
| Notification 插件 | 飞书、Slack、邮件通知通道 | notification sink | v1 |
| Workspace 插件 | 项目扫描、初始化、质量门禁 | workspace 事件 / 命令 | v1.5 |
| Webhook 插件 | 飞书回调、GitHub PR 事件 | 宿主 webhook 网关 | v1.5 |
| Web UI 插件 | Dashboard 卡片、详情面板、设置页 | Web contribution(iframe) | v2 |
| Swarm 插件 | 任务拆解器、角色模板、依赖门控、验收器 | swarm lifecycle hooks | **后移(阶段 5),v1 明确不做** |

## 4. 用户旅程

### 4.1 安装

```bash
ttmux plugin install ./local-plugin              # v1:本地目录
ttmux plugin install github.com/acme/roam-ci     # v1.5:GitHub 源
ttmux plugin install @acme/ci                    # v2:registry
```

安装后进入 `installed` 状态,不自动启用。

### 4.2 授权(启用时)

首次启用时展示 manifest 声明的权限与网络域名:

```text
插件 @acme/feishu-notify 请求以下能力:
- notification.subscribe: 订阅 finding、监控告警、审批请求
- network: https://open.feishu.cn
- secret: feishuAppId, feishuAppSecret

注意:v1 权限声明用于审阅与审计,插件进程以当前用户身份运行。
请只启用来源可信的插件。

启用?[当前工作区] [全局] [取消]
```

授权提示的 UI 文案属于产品 UI,落地时必须走项目 i18n 标准(zh-CN / en-US 同变更提供),不得硬编码。

### 4.3 使用

插件能力出现在三个地方:

- **CLI**:`ttmux plugin run acme.ci.run`;v1 不把第三方命令挂到 `ttmux` 顶层,避免命名冲突。
- **Web**:命令面板与通知流(v1);设置页表单(v1);自带面板(v2)。
- **Agent**:claude / codex 通过 plugind 的 MCP 桥调用插件 `agentTools`。

### 4.4 管理

```bash
ttmux plugin ls [--json]
ttmux plugin info <id> [--json]
ttmux plugin enable <id> / disable <id>
ttmux plugin update <id>
ttmux plugin audit [<id>] [--json]
ttmux plugin logs <id> [--follow]
ttmux plugin uninstall <id>
```

Web 设置页提供同等管理能力(经 backend exec CLI `--json`,保持薄封装)。

## 5. 治理分层

| 层级 | 说明 | 默认信任 |
|---|---|---|
| Built-in | Roam 随仓库发布的官方插件(`plugins/builtin/`) | 高 |
| Organization | 团队私有仓库、GitHub org allowlist(v1.5) | 中 |
| Community | 第三方公开插件(v2) | 低 |

管理策略:

- 工作区 `.ttmux/plugin-policy.json`(可提交仓库)可锁定允许的插件来源、版本范围、权限上限。
- 插件的每次宿主 API 调用(命令执行、Agent 拉起、通知发送、secret 读取)都写入审计日志。
- Web UI 与 `ttmux plugin info` 展示插件来源、版本、权限声明、网络域名、最近执行记录。
- 升级时展示权限 diff;权限新增默认要求重新确认。
