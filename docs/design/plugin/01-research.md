# 竞品调研:VS Code / JetBrains / Figma

> 返回 [插件机制设计主文档](README.md)

## 1. VS Code:Manifest + Contribution Points + Activation Events + Extension Host

VS Code 的扩展机制可以拆成四层:

| 层 | 作用 | 关键启发 |
|---|---|---|
| Manifest | `package.json` 描述扩展身份、入口、兼容版本、激活条件和贡献点 | 插件元数据必须机器可读,且静态部分先于代码加载 |
| Contribution Points | 扩展通过 `contributes` 声明命令、菜单、视图、配置、语言、任务、AI 工具等 | 静态声明让宿主先构建 UI 与能力索引,不必先执行插件代码 |
| Activation Events | `onCommand`、`onLanguage`、`workspaceContains` 等事件触发插件激活 | 延迟激活是性能和安全关键,不应启动时加载全部插件 |
| Extension Host | 插件运行在独立扩展宿主,可有 local / web / remote 多种位置 | 插件运行位置应与能力需求匹配,不能默认和主进程混跑 |

VS Code 官方文档明确:扩展通常结合 Contribution Points 和 VS Code API 扩展功能;`activate` 在激活事件发生后执行,`deactivate` 用于清理。扩展宿主负责运行扩展,桌面、Web、远程开发场景下可存在不同宿主位置和运行时。

**特别注意**:VS Code 的安全模型本质是"安装即信任"——扩展进程与用户同权,`package.json` 里没有运行时权限 enforce,Workspace Trust 只控制"是否在不可信工作区启用扩展"。这对 Roam v1 的信任模型定位(见 [07-security.md](07-security.md))是最重要的参照:**不要假装普通子进程模型能做到 Figma 级别的沙箱**。

对 Roam 的直接启发:

- 插件必须有 `roam-plugin.json`,先声明能力,再执行代码。
- UI、命令、配置、事件订阅都应是声明式 contribution。
- 插件默认惰性激活,只有命令调用、事件命中、工作区条件满足时才启动。
- 插件代码不跑在 `ttmux-web` 或 CLI 主进程里,至少进程级隔离。

## 2. JetBrains IntelliJ Platform:plugin.xml + Extension Points + Dynamic Plugins

- `plugin.xml` 描述插件信息、依赖、兼容版本、扩展、扩展点、动作、监听器等。
- 平台和插件都可以定义 extension point;其他插件声明实现某个 extension point。
- extension point 分两类:接口型扩展点让第三方提供代码实现,Bean 型扩展点让第三方提供数据。
- 动态插件要求安装、更新、卸载时不重启 IDE,但必须满足一系列限制:不使用旧 Components、只使用动态扩展点、正确清理资源、不缓存会阻止卸载的对象。

对 Roam 的直接启发:

- Roam 不只要"插件扩展 Roam",后续也要允许"插件定义二级扩展点",使生态可以分层。
- 插件必须有清晰生命周期:install、enable、activate、deactivate、disable、uninstall。
- 动态卸载的难点在资源引用:长任务、watcher、PTY、浏览器会话、Agent 进程、缓存都必须可归属到插件并可清理。
- extension point 要标注是否支持动态加载;不能动态卸载的插件应声明 `requiresServiceRestart`。

## 3. Figma:Manifest + 权限 + 网络访问白名单 + UI iframe

Figma 插件也以 `manifest.json` 为入口,包含 `main`、`ui`、`editorType`、菜单、参数、权限、capabilities、networkAccess 等。其特别值得参考的点是权限与网络声明:

- 插件声明可访问的外部域名,未声明的网络访问会被阻止。
- 权限、能力和网络访问会展示给用户。
- 插件 UI 和主逻辑分离,UI 通过受控通道与宿主通信。

**关键前提**:Figma 能真正阻断未声明的网络访问,是因为插件主逻辑跑在浏览器沙箱(realm/iframe)里,宿主控制了全部 I/O 出口。Roam v1 的 Node/任意可执行文件子进程模型不具备这个前提,网络白名单在 v1 只能做"声明 + 展示 + 审计",不能宣称阻断。

对 Roam 的直接启发:

- 权限、网络域名必须显式声明并展示给用户——即便 v1 无法强制,声明本身就是信任决策的输入。
- Web 插件面板(v2)应以 iframe 沙箱运行,通过 `postMessage`/RPC 与宿主通信——UI 层是可以做到真隔离的。
- 插件提交到组织仓库时,权限声明是产品信任的一部分。

## 4. 对比结论

| 设计问题 | VS Code | JetBrains | Figma | Roam 取舍 |
|---|---|---|---|---|
| 插件身份 | `publisher.name` | 稳定 plugin id | 平台分配 id | `publisher.name`,后续加签名发布 id |
| 静态能力 | `contributes` | `extensions/actions` | `menu/capabilities` | `contributes` 统一描述命令、watcher、通知、工具 |
| 运行入口 | `main` / `browser` | JVM class | `main` / `ui` | `main` 为插件后端进程入口,`ui`(v2)为 Web 资源入口 |
| 激活方式 | activation events | extension point / listener | 用户菜单触发 | command / event / schedule / workspace 条件 |
| 隔离 | extension host(同权) | plugin classloader | 浏览器沙箱 + UI iframe | v1 进程隔离(同权,安装即信任);v2 容器/受限用户 |
| 动态更新 | 扩展宿主管理 | 严格动态插件规则 | 重新运行插件 | 默认支持启停;长任务插件需声明清理能力 |
| 权限 | Workspace Trust(粗粒度) | IDE 权限模型 | manifest 权限 + 网络白名单(真阻断) | 声明式权限 + 宿主 API 侧约束 + 审计;真阻断留给 v2 |

## 5. 参考资料

- VS Code Extension Anatomy: https://code.visualstudio.com/api/get-started/extension-anatomy
- VS Code Contribution Points: https://code.visualstudio.com/api/references/contribution-points
- VS Code Activation Events: https://code.visualstudio.com/api/references/activation-events
- VS Code Extension Host: https://code.visualstudio.com/api/advanced-topics/extension-host
- IntelliJ Plugin Configuration File: https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html
- IntelliJ Extension Points: https://plugins.jetbrains.com/docs/intellij/plugin-extension-points.html
- IntelliJ Dynamic Plugins: https://plugins.jetbrains.com/docs/intellij/dynamic-plugins.html
- Figma Plugin Manifest: https://developers.figma.com/docs/plugins/manifest/
- GitHub Pull Request Reviews API: https://docs.github.com/en/rest/pulls/reviews
- GitHub Webhook Events and Payloads: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- GitHub Check Runs API: https://docs.github.com/en/rest/checks/runs
