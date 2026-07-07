# Roam

[English](README.md) ｜ **简体中文**

> **把你的开发机变成一个随身 AI 编程工作站。**

**Roam** 让你在任何地方、任何时间，用手机、平板或电脑连回自己的开发机，
继续写代码、跑测试、看日志、调浏览器，并监督 Claude Code、Codex 等
AI coding agent 持续工作。

它解决的是一个很具体的问题：**复杂开发任务不应该被你的设备、网络和时间切碎。**
代码、终端、开发服务、浏览器和 Agent 都留在开发机上持续运行；你换设备、断线、
离开桌面后，回来仍然接着同一个现场继续。除非你主动关闭，开发机上的工作不会因为
本地命令行退出、浏览器关闭或笔记本合盖而消失。

**一眼看懂 Roam 的价值：**

- **远程开发不断线**：手机查看进度，平板补充指令，电脑接手编码，工作现场始终在开发机上。
- **长任务持续跑**：测试、构建、迁移、日志和调试会话不因合盖、断网、换设备而中断。
- **现场不会丢**：终端、服务、浏览器状态和 Agent 对话都留在开发机上，除非你主动关闭。
- **AI Agent 可管理**：Claude Code、Codex 等 Agent 可以被分组、追踪输出、随时追加指令。
- **复杂任务可编排**：把多个 Agent/任务串成带目标、依赖、看板和消息流的协作系统。

Roam 不是另一个云 IDE。它连接你的真实开发机，把终端、浏览器、文件、任务和
AI Agent 放进一个可远程接管的工作空间里。你看到的是一个控制台，背后仍然是你
熟悉的开发环境和工具链。

![Roam Web 控制台](docs/roam-web-console.png)

## 核心能力

- **随身开发**：手机、平板、电脑都能连接同一台开发机，查看终端、日志、任务和 Agent 进度。
- **上下文不丢**：会话跑在开发机上，断网、关浏览器、换设备后仍可继续接回原来的
  工作现场。
- **长任务不断**：构建、测试、迁移、调试、爬日志和 Agent 执行都可以在后台持续
  运行。
- **Agent 更好用**：Claude Code、Codex 等工具可以被命名、分组、追踪、收集输出，
  也能随时追加指令。
- **swarm 串联复杂任务**：把一个大目标拆成多个成员，设置依赖关系，通过共享看板和
  广场消息流推进协作。
- **浏览器也在开发机上**：远程调试 UI、登录态、截图和复现流程都能留在同一个工作现场。
- **适合人和 Agent 一起用**：人可以从 Web 控制台接管，Agent 可以读取状态、收集输出、继续推进。

## 为什么需要它

远程开发在小任务里很简单，但一旦任务变复杂，就会遇到很多断点：

- 开发服务要一直跑着
- 测试、日志、构建需要多个终端
- 浏览器状态对复现问题很重要
- Agent 需要独立上下文和后续指令
- 长任务要能在你离线后继续执行
- 你需要快速知道现在到底哪些任务还在跑

Roam 把开发机作为唯一真实工作现场。服务器负责保持工作持续运行，Web 控制台负责让
你从任何设备接入；需要自动化时，再通过脚本接口把会话、任务、日志和 Agent 编排接入流程。

## 典型使用方式

1. 在开发机上启动 Roam。
2. 从手机、平板或另一台电脑打开 Web 控制台。
3. 进入已有终端，继续之前的开发现场。
4. 让 Claude Code、Codex 或其他 Agent 在开发机上执行长任务。
5. 离开浏览器或关闭本地命令行后，开发机上的终端、服务、日志和 Agent 仍继续运行。
6. 稍后从任意设备回来，继续查看进度、追加指令或接手编码。

Roam 的重点不是“多一个终端工具”，而是让开发机变成一个持续在线的工作空间。你在
开发机上打开的终端、运行中的服务、调试浏览器、AI Agent 对话和任务状态，不会因为
本地设备关机、SSH 断开、浏览器关闭而主动消失。

## 安装与启动

一行安装 CLI 并构建 Web 控制台：

```bash
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
```

`install.sh` 是 `scripts/` 之上的瘦编排器——先做系统检查，再跑三个模块：
**[1]** ttmux CLI + skills、**[2]** chrome + Node + Playwright、**[3]** 构建后端
（前端 `dist` + Go 二进制）。它把 `ttmux`/`chrome` 装到 `~/.local/bin` 并构建好
产物，但**不启动任何服务**。经 `curl | bash` 运行时按需从 GitHub 拉各模块，在
clone 里则直接 source 本地模块。`TTMUX_SKIP_BACKEND=1` 只装 CLI/chrome。

然后在仓库目录里启动 Web 控制台：

```bash
cp .env.example .env
./start.sh             # 直接启动已构建产物（不重新编译）
# ./start.sh --dev     # 开发模式：每次重新编译前端+后端
```

`start.sh` 还支持 `stop` / `status` / `logs` / `fg`。

默认监听 `0.0.0.0:13579`，局域网设备可以直接访问。正式使用前请修改 `.env` 里的
访问口令；远程访问建议走 Tailscale、Cloudflare Tunnel、SSH forwarding 或 frp。

通过 **frp 暴露并保持 HTTPS**（让手机语音输入、剪贴板经隧道仍可用）的配置见
**[docs/deploy/frp.md](docs/deploy/frp.md)**（中英双语）。

完整安装、部署、远程访问和命令行自动化说明见 **[docs/install/](docs/install/)**。

## 给 Claude Code / Codex 用

如果开发机上装了 Claude Code、Codex 或其他命令行编程工具，你可以直接在 Roam 的
持久终端里运行它们。它们的执行过程、输出、上下文和后续指令入口都会留在开发机上；
你从手机或平板回来时，可以继续看它们跑到哪里，也可以继续追加要求。

更复杂的任务可以用 Roam 的 swarm 能力拆成多个成员：有人负责 API，有人负责前端，
有人负责测试，有人负责文档；共享看板和消息流用于同步进度，依赖完成后再解锁下一步。

## 命令行和自动化

Roam 也提供命令行入口，方便脚本、自动化流程和 AI Agent 调用。这里不是普通用户的
主入口；大多数时候你可以先从 Web 控制台开始。

- `ttmux`：管理持久会话、后台任务、Agent worker、swarm 和机器可读状态。
- `chrome`：驱动开发机上的 Chrome，用于 UI 调试、截图、表单操作和自动化验收。

命令细节不放在首页展开，避免 README 变成工具手册。需要时请看
**[docs/install/](docs/install/)**、`ttmux help` 和 `chrome help`。

## 开发与贡献

每个 clone 只需安装一次仓库 Git hooks：

```bash
bash scripts/dev/install-git-hooks.sh
```

pre-commit hook 会运行快速质量门禁；CI 会在 push 和 pull request 上运行完整门禁：

```bash
scripts/dev/quality/check.sh quick
scripts/dev/quality/check.sh full
```

构建并运行 Web 控制台：

```bash
./start.sh --dev fg
```

只跑前端：

```bash
cd frontend
npm install
npm run dev
```

只跑后端：

```bash
cd backend
TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=dev go run ./cmd
```

CLI smoke test：

```bash
TTMUX=./ttmux bash tests/test_ttmux.sh
```

## 安全提醒

Roam 能控制你的开发机终端、文件、浏览器和 Agent，安全级别接近 SSH。正式部署时请：

- 使用强访问口令，并按需开启两步验证。
- 外网访问优先走 Tailscale、Cloudflare Tunnel、SSH forwarding 或 frp。
- 不要把 Web 控制台端口直接暴露到公网。
- 只在你信任的机器和账号上运行。

## 文档

- [docs/install/](docs/install/) — 安装与部署
- [docs/design/](docs/design/) — 设计文档（蜂群编排 / 广场看板 / Web 接入）
- [backend/README.md](backend/README.md) — 后端实现细节

## License

GNU Affero 通用公共许可证 v3.0（AGPL-3.0）。详见 [LICENSE](LICENSE)。
