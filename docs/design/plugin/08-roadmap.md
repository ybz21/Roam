# 分阶段落地计划与 MVP

> 返回 [插件机制设计主文档](README.md)
>
> 原则:先让最小的东西端到端跑通(hello 插件),再堆平台能力;每个阶段都有可验收的插件作为出口。**swarm 扩展点放在最后一个功能阶段,v1 明确不做。**

## 阶段 0:协议冻结

产出(不写运行时代码):

- `roam-plugin.json` JSON Schema;contribution point v1 列表;权限 v1 列表。
- 宿主 ↔ 插件 JSON-RPC 协议草案(initialize / activate / invoke / event / deactivate,requestId + 取消 + 超时)。
- 事件类型与延迟语义表([04-architecture.md](04-architecture.md) 第 6 节)冻结。
- 与《智能评审插件设计》对齐:finding 数据模型、manifest 字段逐项核对,消除两文档分叉。
- 四个故事的端到端验收脚本(review / monitor / feishu / github-review)。

验收:示例 manifest 能通过 `ttmux plugin dev validate`(schema 校验先行实现,作为阶段 0 的唯一代码)。

## 阶段 1:最小闭环(hello 插件)

目标:第三方插件可以本地安装、启用、声明命令,并通过 CLI 调用。**不含任何事件/watcher/平台 API**。

范围:

- meta.db 新增 plugins 注册表;`ttmux plugin install ./path | ls | info | enable | disable | uninstall | run`。
- `ttmux-plugind` 最小实现:单例(tmux 会话 + 文件锁 + 冷却)、unix socket、Host Manager 拉起/停止插件子进程。
- JSON-RPC over stdio;`commands` contribution;`onCommand` 激活;激活/调用超时。
- Node SDK 骨架(`@roam/plugin-sdk`:activate/ctx.commands/ctx.log)。
- 审计日志(命令调用留痕)。
- Web:`GET /api/plugins`、enable/disable/invoke(exec CLI `--json`),插件管理页(文案走 i18n)。

验收:

- `hello` 插件安装→启用→`ttmux plugin run hello.greet`→输出;禁用后命令不可调用,host 进程被停止。
- plugind 被 kill 后任意 plugin 命令能自动恢复它;连续崩溃的插件被标记 unhealthy。

## 阶段 2:智能工作流底座(review-mesh + monitor 跑通)

目标:支撑 Code Review 与自动监控两个故事的完整闭环。

范围:

- **前置重构**:`internal/command/spawn/agent.go` 硬编码两分支 → Agent Provider 接口。
- events 表 + 写路径落事件;plugind 事件游标消费 + session 事件合成(list diff / 静默指纹)。
- `onSessionEvent` / `onSchedule` / `onNotification` / `workspaceContains` 激活。
- Watcher 调度器(持久化、重启恢复);`watchers` contribution。
- Workspace API、Agent API、Session API、`command.exec`(白名单强制)。
- Finding API(meta.db,含外部引用字段)、Notification API(dedupe + 限速)。
- MCP Bridge:`ttmux plugin mcp`,`agentTools` contribution,claude/codex 可调用插件工具。
- 权限模型宿主 API 侧强制;workspace policy 文件。

验收:

- review-mesh 对当前 diff 生成结构化 finding(reviewer agent 经 MCP 写回),quality gate 输出来自宿主执行记录。
- monitor 发现卡住 session,classifier agent 分类后产生 alert,进入统一 notification 流并在 Web SSE 中可见。
- 以上动作全部出现在审计日志,禁用插件后 watcher 与 MCP 工具同步消失。

## 阶段 3:外部系统进出(feishu + github-review 跑通)

范围:

- Secret API(加密落盘、按 key 发放、读取审计)。
- Webhook 网关(路径隔离、签名、重放、限速);飞书优先验证**长连接模式**以绕开公网入口。
- Command Intent + Approval API;身份绑定(飞书用户 ↔ Roam 操作者)。
- SCM / PR API、Diff Mapping、Review/Check Publisher、发布限速队列与 policy(REQUEST_CHANGES 默认禁止)。
- `skills` contribution:插件附带 skill 注册/失效(复用 `skills/sync-skills.sh` 分发约定)。

验收:

- **飞书派活闭环(核心场景)**:在飞书群 @ 机器人下达一个代码开发任务 → 身份绑定校验 → intent + policy 裁决 → 拉起 claude 开发会话 → 进度回帖同一话题 → 完工回帖 diff 摘要卡片 → 话题内追加指令到达同一会话;全链路每一步可在审计日志还原。
- blocking finding 推送飞书群;飞书按钮完成一次可审计的 approval;未绑定用户派活被拒绝。
- PR 更新(webhook 或轮询)触发本地 review;finding 发布为 GitHub review comment;summary 写成 Check Run;人类评论回流成通知并可拉起 fixer agent。

## 阶段 4:Web 插件面板

范围:`views` contribution;iframe 沙箱 + postMessage 宿主桥;插件 UI 静态资源服务(防穿越、独立 CSP);插件设置页;宿主外壳 i18n。

验收:插件面板在会话详情页展示状态卡;设置页保存配置;禁用插件后 UI 入口消失。

## 阶段 5:Swarm 扩展点 + 生态治理

swarm 部分(此前所有阶段不涉及 swarm):

- swarm 写路径落事件(`member.completed`、`swarm.integrating` 等,复用阶段 2 的事件日志机制)。
- `swarmHooks` contribution 与 `onSwarmEvent` 激活;Swarm API(board / plaza / block / unblock)。
- v1 原则:插件只做 hook(参与规划、补充建议、更新看板、触发任务),核心状态机仍由 Roam 管,不开放可替换调度核心。
- 典型增强:member.completed 自动触发 review-mesh;blocking finding 阻塞 swarm 集成门禁。

生态治理:GitHub source 安装、版本锁定与更新、签名校验、组织 allowlist、升级权限 diff 与回滚、插件打包/校验命令。

## MVP:拆成两个独立可合并的版本

阶段 2 主干(Agent Provider、MCP、事件、watcher、Finding、Notification、policy)体量仍然大,一次做完风险过高。MVP 拆成两刀,各自独立可合并、可回滚:

**MVP-A(= 阶段 1,"hello 能跑")**——第一个可合并 PR 的全部范围:

1. manifest + meta.db 注册表 + `ttmux plugin` 管理命令 + `run`。
2. plugind 最小实现(单例 + socket + Host Manager)+ JSON-RPC(Content-Length framing)。
3. `commands` contribution + `onCommand` 激活 + 命令白名单 + 审计日志。
4. Node SDK 骨架 + hello 示例插件。

**MVP-B(= 阶段 2 主干,"review-lite 有用")**——在 A 之上按依赖顺序追加,每项可单独合并:

1. Agent Provider 重构(独立前置 PR)。
2. events.db + 写路径落事件 + session 合成事件 + 事件激活。
3. Workspace / Agent / Session API;Watcher 调度器。
4. Finding / Notification / Job API;MCP 桥;policy 文件。
5. review-lite(对当前 diff 生成 finding)+ monitor-lite(卡死告警)两个内置插件作为验收。

明确不做(v1.5/v2):飞书 webhook 回调、GitHub review 发布、skill 自动注册、Web iframe 面板、插件签名与市场、容器沙箱、**一切 swarm 扩展点**。

裁剪理由:MVP-B 出口是"review-lite 和 monitor-lite 两个智能插件真实可用",验证的是"智能插件"而不是"菜单插件";同时不碰公网入口、密钥管理和 UI 沙箱这三块安全面最大的区域。各阶段对应的 plugind 模块切片见 [04-architecture.md](04-architecture.md) 2.6 节。
