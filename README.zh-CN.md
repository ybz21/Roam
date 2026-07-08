# Roam

[English](README.md) ｜ **简体中文**

> **把你的开发机变成一个随身 AI 编程工作站。**

**Roam** 让你**在任何地方、任何时间，用手机、平板或电脑连回自己的开发机**，
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

![Roam —同一台开发机，从笔电和手机看到的样子](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/hero.zh.png)

<sub>远程接入同一台开发机：桌面控制台和手机看到的是同一批会话、蜂群和 Agent 实时状态。</sub>

## 核心能力

- **合上盖子，活儿照跑**：终端、开发服务、测试、Agent 对话都留在开发机上，断网或
  关掉笔电都不会让现场消失。
- **换设备如同回到同一张桌子**：手机、平板、笔电打开 Web 控制台，直接落回你离开时的
  那个终端——零安装，没有原生 App 要更新。
- **长任务不用你盯着**：构建、迁移、爬日志、Agent 执行都在后台继续；随时从任意设备
  回来看它跑到哪了。
- **Agent 真正可管**：给 Claude Code、Codex 等命名、分组、追踪，收集输出，不丢上下文
  地追加指令。
- **swarm 把一个目标分给多双手**：API 交给一个成员、前端交给另一个、测试交给第三个——
  共享看板和消息流让他们同步，依赖关系自动解锁下一步。
- **调试浏览器也在开发机上**：登录态、截图、复现流程都原地保留，远程调 UI 接着上次
  继续。
- **人和 Agent 共用一个工作现场**：人可以从 Web 控制台亲手接管，Agent 也能读状态、
  收输出、继续推进。

## 界面截图

**所有会话与 Agent，一个列表管起来。** 按 Claude / Codex / 蜂群 或状态(待确认、
空闲)筛选，一眼看出哪个 Agent 需要处理，点进去就是终端。

![会话列表：Agent 标签与筛选](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/sessions.zh.png)

**Agent、终端、文件树，同屏一览。** 看着 Claude Code 或 Codex 干活，旁边就能浏览、
打开文件；在手机上还有底部按键条可以直接敲。

![终端里运行的 Agent 与文件树](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/terminal.zh.png)

**蜂群一屏看懂。** 每个成员的实时依赖拓扑、共享协作墙(广场)、可拖拽流转的看板——
一个被拆给多个 Agent 的复杂目标，依然清清楚楚。

![蜂群仪表盘：拓扑、广场、看板](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/swarm.zh.png)

**在控制台里直接操控一台真浏览器。** 开发机上的 Chrome 被镜像进控制台——开标签、
导航、点击、输入都行。调试网页、保住登录态,或让 Agent 复现一整套流程,全在开发机上完成。

![浏览器镜像：控制台里操控一个真实 Chrome 标签](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/browser.zh.png)

**在控制台里直接操控一台真手机。** 通过 adb 镜像 Android 设备——实时画面、串流指标、
远程导航栏都在——用来复现移动端流程,或在终端旁边顺手看个 App。

![手机镜像：控制台里的一台真实 Android 设备](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/phone.zh.png)

## 移动办公：随时随地接着干

**整套工作现场，装进一部手机。** 用任意手机浏览器打开控制台——无需装 App——直接落回
同一批会话、蜂群和 Agent。地铁上看进度、沙发上催 Agent、咖啡馆里接手写代码。

![手机上的 Roam：概览与蜂群仪表盘](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/mobile-office.zh.png)

**在手机上直接和 Agent 对话。** 打开一个会话,就能在终端里和 Claude Code 或 Codex
聊——底部按键条加发送键,随手追加指令、看回复、把活儿往前推,不用开电脑。

![在手机上和 Claude Code 对话](https://cdn.jsdelivr.net/gh/ybz21/Roam@main/docs/screenshots/mobile-chat.zh.png)

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

- [docs/features.zh-CN.md](docs/features.zh-CN.md) — 完整功能列表
- [docs/install/](docs/install/) — 安装与部署
- [docs/design/](docs/design/) — 设计文档（蜂群编排 / 广场看板 / Web 接入）
- [backend/README.md](backend/README.md) — 后端实现细节

## License

GNU Affero 通用公共许可证 v3.0（AGPL-3.0）。详见 [LICENSE](LICENSE)。
