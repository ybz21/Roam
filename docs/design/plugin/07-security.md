# 安全设计:信任模型、权限、威胁模型、审计

> 返回 [插件机制设计主文档](README.md)
>
> Roam 的权限接近 SSH:插件跑在开发机上,以当前用户身份运行。安全设计必须默认保守,**并且诚实**。

## 1. v1 信任模型:安装即信任(与 VS Code 相同)

必须先说清一个技术事实:v1 的插件是**普通子进程**。进程隔离保护的是宿主的稳定性(崩溃不连带),**不构成沙箱**——插件代码自身可以执行任意命令、访问任意网络,宿主无法在进程模型下阻断。Figma 能真正阻断网络,是因为插件跑在浏览器沙箱里;Roam v1 不具备这个前提。

因此 v1 的安全定位:

| 机制 | v1 的真实作用 |
|---|---|
| manifest 权限声明 | **信任决策输入**:安装/启用/升级时展示给用户审阅;权限 diff 触发重新确认 |
| 宿主 API 侧强制 | 插件经**宿主 API** 做的事(command.exec 白名单、workspace 路径限制、secret 按声明发放、session 写操作)是真实强制的 |
| 审计日志 | 每次宿主 API 调用留痕,事后可追责 |
| 来源治理 | policy 锁定插件来源/版本;v1 只建议安装 built-in 与自有插件 |
| ~~网络白名单阻断~~ | **v1 做不到**,只做声明与展示;不得在产品文案中宣称阻断 |

产品文案必须如实表达(启用对话框示例见 [02-product.md](02-product.md)):"插件进程以当前用户身份运行,请只启用来源可信的插件"。

**推论**:插件遵守规矩(通过宿主 API 做事)时,权限、白名单、审计全部生效——这约束的是"正规插件的失误半径"(prompt 注入让 Agent 误调工具、插件 bug 误删文件等),这是日常价值所在;它不防"蓄意恶意的插件",防恶意靠来源治理与 v2 沙箱。

## 2. 权限清单

| 权限 | 说明 | 风险 | 强制点 |
|---|---|---|---|
| `workspace:read` / `workspace:write` | 经宿主 API 读/写项目文件 | 中 / 高 | 宿主 API(路径防穿越) |
| `commands` (allow/deny) | 经 `command.exec` 执行白名单命令 | 高 | 宿主 API |
| `sessions:read` / `sessions:write` | capture / send·kill 会话 | 中 / 高 | 宿主 API + policy |
| `agents:spawn` | 拉起 claude/codex | 高 | 宿主 API |
| `findings:read/write` | 读写 finding | 低 / 中 | 宿主 API |
| `notifications:publish/subscribe` | 通知发布/订阅 | 中 | 宿主 API + 限速 |
| `watchers:register` | 持久巡检任务 | 中 | 宿主调度器 |
| `network.allowedDomains` | 外网访问声明 | 中/高 | **v1 仅声明展示** |
| `secrets:<key>` | 读取指定密钥 | 高 | 宿主 API(按 key 发放 + 审计) |
| `webhooks:receive` | 接收外部回调 | 高 | 宿主网关(签名/重放/限速) |
| `intents:create` / `approval.decide` | 外部输入转指令 / 代表人类决策 | 高 | intent 流程 + 身份绑定 |
| `scm:read` / `scm:write` | 读 PR / 发布 review·comment·check | 中 / 高 | 宿主 API + policy |
| `skills:register` | 注册插件附带 skill | 中 | 宿主 |

授权原则:

- manifest 声明"想要什么",workspace policy 决定"最多给什么",用户授权决定"实际给什么";三者取交集。
- 高危权限必须可细粒度约束:命令白名单、路径白名单、secret 按 key、SCM 按发布模式。
- Agent 经 MCP 调插件工具,沿用同一套权限与审计,不因自动化绕过;高危动作可要求 human approval。

## 3. 威胁模型

| 风险 | 例子 | v1 缓解 | v2 缓解 |
|---|---|---|---|
| 恶意插件任意执行 | 安装后偷跑 `rm -rf` / 上传源码 | **来源治理**(policy allowlist、只装可信来源)+ 审计事后追责;技术上不可阻断 | 容器/受限用户沙箱、签名 |
| 正规插件被滥用 | prompt 注入使 Agent 误调高危工具 | 宿主 API 权限 + 白名单 + approval + 审计(真实有效) | 同左 |
| 数据外泄 | 读 `.env` 后发外网 | secret 按 key 发放、workspace API 路径限制、网络声明展示 | 网络出口代理/阻断 |
| 供应链攻击 | 插件升级后夹带恶意行为 | 版本锁定、升级权限 diff 重新确认 | 签名校验、registry 扫描 |
| 外部回调伪造/重放 | 伪造飞书/GitHub 回调 | 网关签名校验、重放保护、限速;外部输入一律走 intent | 同左 |
| 越权审批 | 无关飞书用户点"批准" | 身份绑定,未绑定只读;approval 全量审计 | 多用户体系 + RBAC |
| UI 钓鱼(v2) | 插件面板伪装登录页 | iframe 沙箱、插件标识、独立 CSP | 同左 |
| 持久化后门 | 安装时写 cron / shell hook | 安装过程不执行插件代码(只读 manifest);激活前审阅 | 安装产物扫描 |

## 4. 审计

### 4.1 Actor 格式(先定死,否则 audit 与 approval 后面返工)

v1 虽是单用户,但操作发起方已有多种,审计与审批的 `actor` 字段从第一天用统一格式 `<kind>:<id>`:

| actor | 含义 |
|---|---|
| `cli:<os用户>` | 终端里的人 |
| `web:<会话指纹>` | Web 登录会话 |
| `agent:<会话名>` | 经 MCP 调工具的 claude/codex 会话 |
| `plugin:<插件id>` | 插件自身发起(watcher 触发等) |
| `watcher:<watcherId>` | 定时巡检触发 |
| `feishu:<open_id>` / `github:<login>` | 外部身份(v1.5,经身份绑定映射) |

intent/approval 记录**因果链上的两个 actor**:发起者(如 `feishu:ou_xxx`)与决策者(如 `web:…`),不混为一个字段。

### 4.2 审计记录

- 每次宿主 API 调用(含 Agent 经 MCP 的调用)记录:时间、插件 id+版本、工作区、actor(上述格式)、action、target、决策、结果。
- 落盘 `~/.ttmux/plugins/audit/<日期>.jsonl`,`ttmux plugin audit` / Web 可查,按天滚动。
- 外部动作(SCM 写、通知外发、approval)必须在审计里可还原完整因果链(哪个事件 → 哪个插件 → 哪个 intent → 谁批准)。

## 5. v1 必须做到 / v2 再做

**v1 边界**:插件进程隔离与崩溃遏制;manifest 权限声明与启用授权;宿主 API 侧强制(命令白名单、路径限制、secret 发放);审计日志;禁用/卸载可靠停止插件进程并注销资源;policy 文件锁来源与权限上限。

**v2+**:插件签名与 registry;容器 / 受限用户 / WASM 沙箱(网络白名单从"声明"升级为"阻断");组织策略中心与多用户 RBAC;自动安全扫描。
