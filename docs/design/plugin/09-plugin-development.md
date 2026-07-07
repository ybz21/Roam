# 插件开发指南:从 hello 到发布

> 返回 [插件机制设计主文档](README.md)
>
> 本篇面向插件开发者,描述目标状态的开发体验(随阶段落地,命令以 [08-roadmap.md](08-roadmap.md) 为准)。

## 1. 心智模型

- 插件的主体是一个**后端进程**:你写一个 `main`(Node 或任意可执行文件),由 `ttmux-plugind` 在激活事件命中时拉起,通过 stdio 上的 JSON-RPC 与宿主对话。**不用写前端**——设置界面由宿主根据你的 config schema 自动渲染;v2 才有可选的自带面板。
- **规范:不要直接碰 tmux / sqlite / claude 命令行**,一切经 `ctx` 上的平台 API([06-platform-api.md](06-platform-api.md))。要说明的是:v1 的进程模型**并不能技术上阻止**你绕过(见 [07-security.md](07-security.md) 的信任模型)——但绕过意味着没有权限记录、没有审计、没有"证据由宿主记录"的可信性,官方与组织的插件 review 会直接拒绝这类实现,`plugin dev validate` 也会对可疑模式告警。
- 常驻逻辑(定时巡检)不要自己 `setInterval` 后台跑:声明 `watchers`,由宿主调度、持久化和恢复;你的进程随时可能被回收(空闲 10 分钟后 deactivate)。
- 事件是**至少一次**投递,handler 必须幂等;需要跨激活保存的状态放 `ctx.storage`。

## 2. 快速开始

```bash
ttmux plugin dev init my-plugin        # 脚手架
cd my-plugin
ttmux plugin dev validate .            # 校验 manifest(schema + 引用文件存在性)
ttmux plugin dev run . -- greet        # 不安装,直接以开发模式拉起并调用命令
ttmux plugin install .                 # 装到 ~/.ttmux/plugins/installed/
ttmux plugin enable my.plugin
ttmux plugin run my.plugin.greet
ttmux plugin logs my.plugin --follow   # 查看插件 stderr 日志
```

脚手架产物:

```text
my-plugin/
├── roam-plugin.json
├── README.md
├── src/main.js            # 构建到 dist/main.js
├── schemas/config.schema.json
└── package.json           # 依赖 @roam/plugin-sdk
```

## 3. 最小插件(hello)

`roam-plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "acme.hello",
  "publisher": "acme",
  "name": "hello",
  "displayName": { "zh-CN": "你好插件", "en-US": "Hello Plugin" },
  "version": "0.1.0",
  "engines": { "roam": ">=0.6.0" },
  "main": "dist/main.js",
  "runtime": { "kind": "node", "activation": "lazy" },
  "permissions": {},
  "activationEvents": ["onCommand:acme.hello.greet"],
  "contributes": {
    "commands": [
      { "id": "acme.hello.greet", "title": { "zh-CN": "打招呼", "en-US": "Greet" } }
    ]
  }
}
```

`src/main.js`:

```js
const { activate } = require('@roam/plugin-sdk')

activate(ctx => {
  ctx.commands.register('acme.hello.greet', async args => {
    ctx.log.info('greet invoked')            // -> stderr -> plugins/logs/acme.hello.log
    return { text: `hello, ${args.name ?? 'roam'}` }
  })
  // 返回可选清理函数;ctx 注册的资源在 deactivate 时由 SDK 自动注销
  return () => ctx.log.info('bye')
})
```

要点:

- **stdout 属于 RPC,严禁 console.log 到 stdout**;日志一律 `ctx.log`(走 stderr)。
- `activate` 必须在 10s 内完成(默认激活超时);重活放到命令/事件 handler 里做。
- 命令返回值是结构化 JSON,CLI 会渲染、Web 与 Agent 原样消费。

## 4. 用平台能力:一个"变更巡检"插件片段

```js
activate(ctx => {
  // 1) 命令:审查当前变更。会话名必须带 job id 防并发冲突,labels 是取回会话组的句柄
  ctx.commands.register('acme.qc.review', async () => {
    const jobId = await newJobId(ctx)               // 如 'j42',job -> 会话映射存 ctx.storage
    const diff = await ctx.workspace.diff({})
    const gate = await ctx.command.exec({           // 白名单命令,宿主执行并留痕
      argv: ['scripts/dev/quality/check.sh', 'quick'] })
    const reviewer = await ctx.agents.spawn({       // 受控拉起 codex
      provider: 'codex', role: 'reviewer',
      prompt: buildPrompt(diff, gate),
      sessionName: `qc-${jobId}-rv1`,
      labels: { job: jobId, role: 'reviewer' } })
    await ctx.storage.set({ key: `job:${jobId}`, value: { stage: 'reviewing' } })
    return { job: jobId, session: reviewer.sessionName }
  })

  // 2) Agent 工具:reviewer 经 MCP 写回结构化 finding
  ctx.agentTools.register('acme.qc.createFinding', async f =>
    ctx.findings.create({ ...f, source: 'acme.qc' }))

  // 3) 事件:自己 job 的 reviewer 会话退出后复核(按 label 过滤,不响应无关会话)
  ctx.events.on('session:agent.exited', { labels: { role: 'reviewer' } }, async ev => {
    const jobId = ev.labels.job
    const open = await ctx.findings.list({ status: 'open', source: 'acme.qc' })
    if (open.length) await ctx.notifications.publish({
      type: 'finding.blocking', severity: 'high',
      title: `qc ${jobId}: ${open.length} blocking findings`,
      dedupeKey: `acme.qc.blocking.${jobId}` })
  })

  // 4) watcher handler(schedule 在 manifest 里声明)
  ctx.watchers.handle('acme.qc.patrol', async () => { /* ... */ })
})
```

对应的 manifest 权限声明(缺一不可,未声明的 API 调用会被宿主拒绝并计入审计):

```json
"permissions": {
  "workspace": ["read"],
  "commands": { "allow": ["scripts/dev/quality/check.sh"] },
  "agents": ["spawn"],
  "findings": ["read", "write"],
  "notifications": ["publish"],
  "watchers": ["register"]
}
```

## 5. RPC 协议(非 Node 语言 / 不用 SDK 时)

`runtime.kind: "exec"` 的插件直接实现**标准 JSON-RPC 2.0**,帧格式为 LSP 式 `Content-Length` framing(与 LSP/MCP 相同,不是裸换行 JSON;帧外字节按协议错误计数,见 [04-architecture.md](04-architecture.md) 4.3 节):

```text
Content-Length: 118\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

方法与方向(完整 schema 在阶段 0 冻结):

```jsonc
// Host -> Plugin(请求)
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pluginId":"acme.qc","workspace":"...","storageDir":"...","locale":"zh-CN","permissions":{...}}}
{"jsonrpc":"2.0","id":2,"method":"plugin/invokeCommand","params":{"command":"acme.qc.review","args":{...},"actor":"cli:user"}}
{"jsonrpc":"2.0","id":3,"method":"plugin/onEvent","params":{"type":"session:agent.exited","payload":{...}}}
{"jsonrpc":"2.0","id":9,"method":"plugin/deactivate","params":{"reason":"idle"}}   // 5s 内退出,否则 SIGKILL

// Plugin -> Host(反调平台 API,同样是标准请求)
{"jsonrpc":"2.0","id":101,"method":"roam/workspace.diff","params":{}}
{"jsonrpc":"2.0","id":102,"method":"roam/agent.spawn","params":{"provider":"codex","sessionName":"qc-j42-rv1","labels":{"job":"j42"}}}

// 响应与错误:标准 result / error(含 code/message/data)
{"jsonrpc":"2.0","id":101,"result":{...}}
{"jsonrpc":"2.0","id":102,"error":{"code":-32001,"message":"permission denied: agents:spawn","data":{"audit":"..."}}}

// 取消与进度:LSP 惯例的通知
{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":2}}
{"jsonrpc":"2.0","method":"$/progress","params":{"id":2,"message":"spawning reviewer"}}
```

- 双向都是 JSON-RPC 2.0 客户端+服务端;所有请求可取消、有超时。
- 长任务不要占着 RPC:创建 Agent 会话 / job,立即返回,靠事件收尾。

## 6. 配置、i18n、密钥

- **配置**:`schemas/config.schema.json`(JSON Schema)→ 宿主自动渲染设置表单 → 插件用 `ctx.config.get()` 读取,变更时收到 `config.changed` 事件。
- **i18n**:面向宿主展示的 `displayName` / `title` / `description` 用 locale map 提供 zh-CN 与 en-US;命令返回的用户可见文本建议同样按 `ctx.locale` 输出。
- **密钥**(v1.5):manifest 声明 `secrets: ["myToken"]`,用户经 `ttmux plugin secret set <id> myToken` 或设置页写入;代码里 `ctx.secrets.get('myToken')`,禁止写日志/落盘。

## 7. 调试与测试

- `ttmux plugin dev run . --inspect`:以开发模式拉起(Node 时附加 `--inspect` 调试端口),manifest 改动热重载。
- `ttmux plugin logs <id> --follow`:插件 stderr;`ttmux plugin audit <id>`:该插件的全部宿主 API 调用记录——排查"为什么被拒绝"先看这里。
- plugind 本体跑在 `_ttmux-plugind` tmux 会话里,`ttmux attach _ttmux-plugind` 可看宿主日志。
- 单测:SDK 提供 `createMockContext()`,平台 API 全部可 mock,handler 可在插件仓库内独立测试。

## 8. 打包与分发

```bash
ttmux plugin dev validate .   # schema + 权限声明 lint(如声明了未用到的高危权限会警告)
ttmux plugin dev pack .       # 产出 my-plugin-0.1.0.tgz(含 manifest、dist、schemas)
```

- v1 分发 = 发 tarball / git 仓库,用户 `ttmux plugin install <path|url>`。
- 版本号遵循 semver;`engines.roam` 声明兼容宿主版本;升级若新增权限,用户会看到权限 diff 并需重新确认。
- 团队内分发:仓库提交 `.ttmux/plugins.json`(启用清单)与 `.ttmux/plugin-policy.json`(来源/权限上限),成员 `ttmux plugin sync` 一键对齐(阶段 3+)。

## 9. 最佳实践清单

- [ ] stdout 只走 RPC(Content-Length framing),日志走 `ctx.log`;SDK 已把 console.log patch 到 stderr,别绕开。
- [ ] `activate` 轻;重活进 handler;常驻逻辑用 watcher,不自开定时器。
- [ ] 会话名带 job id(如 `qc-${jobId}-rv1`)防并发冲突;spawn 必打 labels,事件订阅按 labels 过滤,不响应无关会话。
- [ ] 事件 handler 幂等;跨激活状态放 `ctx.storage`;通知带 `dedupeKey`。
- [ ] 全部副作用经宿主 API,不直接 exec tmux/git/claude——否则没有审计与证据,也过不了 review。
- [ ] 权限最小声明;高危动作设计成可被 policy 关闭并降级(如"自动重启"降级为"仅告警")。
- [ ] `deactivate` 里不留活口:SDK 自动清理 ctx 注册的资源,自建资源必须在返回的清理函数里释放。
