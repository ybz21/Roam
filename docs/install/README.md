# 安装与部署

ttmux 有 **两种使用模式**，按需取用，也可叠加：

| 模式 | 场景 | 装什么 | 必需依赖 |
|------|------|--------|----------|
| **① 本地 CLI** | 在终端 / 服务器上直接编排并行任务、Agent、蜂群 | `ttmux` 单文件脚本 | `tmux`（`sqlite3`、Claude Code 按需） |
| **② 远程控制台** | **远程办公**：手机 / 平板 / 笔记本随地查看·操控（实时终端 + 浏览器镜像） | Web 控制台（Go + React）+ frp 内网穿透 | `go`、`node` + `npm`（远程暴露用 frp） |

> 模式 ② 跑在你的开发机 / 服务器上，模式 ① 是它的底座——**远程控制台本质是 CLI 的网页封装**，
> 读 = 代理 `ttmux <cmd> --json`，写 = 调对应子命令，行为与 CLI 永远一致。
>
> 只在终端用 → 只装 [① CLI](#一本地-cli)。要随地远程控制 → 再加 [② 远程控制台](#二远程控制台) + [frp 远程办公](#四远程办公--frp-内网穿透)。

- [一、本地 CLI](#一本地-cli)
- [二、远程控制台](#二远程控制台)
- [三、配置项（.env）](#三配置项env)
- [四、远程办公 —— frp 内网穿透](#四远程办公--frp-内网穿透)
- [五、可选能力](#五可选能力)
- [六、升级与卸载](#六升级与卸载)
- [七、故障排查](#七故障排查)

---

## 依赖速查

| 依赖 | 用途 | 没有它会怎样 | 安装 |
|------|------|--------------|------|
| `tmux` | CLI 的运行基座 | CLI 无法工作 | `apt install tmux` / `brew install tmux` |
| `sqlite3` | 蜂群 swarm 的元数据库 | 仅 `swarm` 子命令不可用 | `apt install sqlite3` / `brew install sqlite3` |
| Claude Code | `spawn --agent` / 蜂群成员 | 仅 Agent 类任务不可用 | 见 [claude.ai/code](https://claude.ai/code) |
| `go` ≥ 1.21 | 编译 Web 后端 | Web 控制台起不来 | [go.dev/dl](https://go.dev/dl/) |
| `node` ≥ 18 + `npm` | 构建 Web 前端 + `chrome` 自动化 | Web 控制台起不来 / `chrome` 不可用 | [nodejs.org](https://nodejs.org/) |
| `google-chrome` | 浏览器镜像页 + `chrome` 自动化 | 「浏览器」标签 / `chrome` 不可用 | 系统包管理器 |

---

## 一、本地 CLI

### 1. 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
```

`install.sh` 是 `scripts/` 之上的**瘦编排器**——先做系统检查（平台/架构识别、装 `tmux`），
再按顺序跑模块：

- **[1] ttmux**：把 `ttmux` 装到 `~/.local/bin/ttmux`；Claude Code skills 装到
  `~/.claude/skills/`（`ttmux/SKILL.md`、`cc-swarm/SKILL.md`）；装 Tab 补全。
- **[2] chrome**：装 Node（缺则按平台自动装）→ `chrome` CLI → `npm i playwright-core`
  （`connectOverCDP` 复用已开 Chrome，不下载浏览器）。
- **[3] backend**：**在 clone 里**构建 Web 控制台产物（前端 `dist` + 后端二进制），
  **只构建不启动**；纯 `curl|bash`（无源码）则跳过。`TTMUX_SKIP_BACKEND=1` 可只装 CLI/chrome。

并创建数据目录 `~/.local/share/ttmux/{logs,groups}`。

> 模块化：逻辑都在 `scripts/`（`lib/common.sh`、`lib/platform.sh`、`lib/github.sh`、
> `preflight.sh`、`install-ttmux.sh`、`install-chrome.sh`、`install-backend.sh`）。
> `curl|bash` 远程运行时按需从 GitHub raw 拉各模块；clone 里则直接 source 本地模块。
> 用 `TTMUX_INSTALL_BRANCH=xxx` 可指定远程拉取的分支。

若 `~/.local/bin` 不在 `PATH`，脚本会提示你追加：

```bash
export PATH="$HOME/.local/bin:$PATH"   # 写进 ~/.bashrc 或 ~/.zshrc
```

### 2. 手动安装

已 clone 仓库时，在仓库根目录执行 `bash install.sh` 即可（自动识别本地文件，免下载）。或纯手动：

```bash
cp ttmux ~/.local/bin/ && chmod +x ~/.local/bin/ttmux
ttmux completion          # 安装 Tab 补全
```

### 3. 从源码构建

根目录的 `ttmux` 是**单文件分发版**，由 `cli/ttmux-cli/lib/*.sh` 各模块拼接而成。改了模块要重新生成：

```bash
vim cli/ttmux-cli/lib/swarm.sh   # 改模块（不要直接改根目录的 ttmux，会被覆盖）
bash cli/ttmux-cli/build.sh      # 重新生成根目录 ttmux（末尾自带 bash -n 语法自检）
bash install.sh              # 可选：装到 ~/.local/bin
```

细节见 [`../../cli/ttmux-cli/README.md`](../../cli/ttmux-cli/README.md)。

### 4. 验证

```bash
ttmux help
ttmux new dev
ttmux spawn build "lint" "echo ok" "test" "echo pass"
ttmux status build
```

---

## 二、远程控制台

远程控制台（`ttmux-web`）目前**从源码运行**：克隆仓库 → 配 `.env` → 一键脚本。装在你的开发机 / 服务器上，本节先让它在本机 / 局域网跑起来；要从外网随地访问，见 [四、远程办公](#四远程办公--frp-内网穿透)。

### 1. 前置

确认已装 `go`、`node`+`npm`（或 `bun`），且 CLI 已可用（后端会调用 `ttmux`）。

### 2. 一键启动

```bash
git clone https://github.com/ybz21/ttmux.git
cd ttmux

cp .env.example .env          # 按需改口令/端口（见下方「配置项」）
bash install.sh               # 构建产物：前端 dist + 后端二进制（[3] backend 模块）
./start.sh                    # 直接启动已构建产物（不重新编译）
```

两种启动模式：

- `./start.sh` —— **直接启动** `install.sh` 已构建的产物，不重新编译（最快）。
- `./start.sh --dev` —— **开发模式**：每次增量编译前端+后端，并刷新 CLI/skills 再启动。

`start.sh` 默认**后台守护**运行（`setsid` 脱离终端，关终端 / Ctrl-C 都不影响），并打印访问地址：

```
==> 启动 ttmux-web  http://0.0.0.0:13579  （口令: ******）
==> 手机/平板（同 WiFi）: http://192.168.x.x:13579
```

浏览器打开该地址，用 `TTMUX_WEB_PASSWORD` 登录。

> 增量构建（`--dev`）：前端/后端**有改动才重新编译**，没改动直接复用产物，二次启动很快。

### 3. 进程管理

```bash
./start.sh stop      # 停止
./start.sh status    # 查看是否在跑 + 端口/PID
./start.sh logs      # 跟随日志（tail -f）
./start.sh --dev fg        # 前台运行（调试用，Ctrl-C 即停）
```

### 4. 手动运行（不用脚本）

```bash
# 前端构建一次
cd frontend && npm install && npx vite build && cd ..

# 后端编译并运行（flag 覆盖环境变量）
cd backend && go build -o ttmux-web ./cmd
TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=secret \
  ./ttmux-web -addr 127.0.0.1:13579 -web ../frontend/dist
```

### 5. 开发模式（前后端分离热更新）

```bash
cd backend  && TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=dev go run ./cmd   # 后端 :8080
cd frontend && npm run dev                                             # 前端 :5173（代理 /api 含 WS）
```

后端分层与 API 见 [`../../backend/README.md`](../../backend/README.md)，完整设计见 [`../design/web/`](../design/web/)。

---

## 三、配置项（.env）

仓库根的 `.env` 由 `start.sh` 自动加载；**已存在的真实环境变量优先于 `.env`**。命令行 flag（`-addr`/`-web`）又优先于环境变量。

| 变量 | 默认 | 说明 |
|------|------|------|
| `TTMUX_WEB_PASSWORD` | 脚本默认 `BladeAI2026!!`；直跑二进制时随机生成 | 登录口令。**务必改成强口令。** |
| `TTMUX_WEB_BIND` | `start.sh` → `0.0.0.0:13579`；裸二进制 → `0.0.0.0:8080` | 监听地址。`0.0.0.0` = 局域网可达；`127.0.0.1` = 仅本机。 |
| `TTMUX_BIN` | `start.sh` 设为仓库内 `./ttmux` | 后端调用的 ttmux 路径。 |
| `TTMUX_WEB_2FA` | 关闭 | 设为 `off/0/false/no` 让初始 TOTP 种子失效；两步验证也可在控制台「系统配置」里开关。 |
| `TTMUX_WEB_TOTP_SECRET` | 空 | 两步验证密钥初始种子（base32）；启用后状态以 `totp.json` 为准。 |
| `TTMUX_WEB_LOCK_AFTER` | `10` | 连续登录失败多少次后锁定。 |
| `TTMUX_WEB_LOCK_SECS` | `30` | 锁定时长（秒）。 |
| `TTMUX_DATA` | `~/.local/share/ttmux` | 数据目录（日志、`totp.json` 等）。 |
| `TTMUX_CHROME_CDP` | `http://127.0.0.1:9222` | 浏览器镜像对接的 Chrome 调试端口。 |
| `TTMUX_CHROME_SCALE` | `2` | 浏览器镜像渲染像素密度（越大越清晰、越吃带宽）。 |
| `TTMUX_WEB_LOG` | `/tmp/ttmux-web.log` | 守护进程日志路径（仅 `start.sh`）。 |
| `TTMUX_WEB_PID` | `/tmp/ttmux-web.pid` | 守护进程 PID 文件（仅 `start.sh`）。 |

`.env` 示例：

```dotenv
TTMUX_WEB_PASSWORD=请改成强口令
TTMUX_WEB_BIND=0.0.0.0:13579
# TTMUX_BIN=/path/to/ttmux
```

---

## 四、远程办公 —— frp 内网穿透

家里/公司的开发机一般没有公网 IP，外网到不了。**frp** 用一台有公网 IP 的小服务器做中转，把内网的控制台穿透出来——这是远程办公最常用、自托管、零依赖第三方的方案。

```
 手机/笔记本(外网) ──► 公网服务器 frps ──► 内网开发机 frpc ──► ttmux-web(127.0.0.1:13579)
```

> ⚠ **远程控制台等于把 shell 执行能力搬上网。** 穿透前务必：强 `TTMUX_WEB_PASSWORD` + 开两步验证
> （控制台「系统配置」）+ 保留登录失败锁定（`TTMUX_WEB_LOCK_*`）。并把 `TTMUX_WEB_BIND` 收回
> `127.0.0.1:13579`，只让 frpc 在本机连，不再裸暴露局域网。

下载 frp：[github.com/fatedier/frp/releases](https://github.com/fatedier/frp/releases)（`frps` 放公网服务器，`frpc` 放开发机）。

**公网服务器**　`frps.toml`：

```toml
bindPort = 7000
auth.token = "换成一串强随机密钥"     # frps/frpc 必须一致
```

```bash
./frps -c frps.toml        # 放进 systemd / nohup 常驻
# 记得在云厂商安全组放行 7000，以及下方要用的对外端口
```

### 方案 A · 简单（对外开一个端口）

**开发机**　`frpc.toml`：

```toml
serverAddr = "公网服务器IP"
serverPort = 7000
auth.token = "同 frps 的 token"

[[proxies]]
name = "ttmux-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 13579        # 对应 TTMUX_WEB_BIND
remotePort = 13579       # 公网服务器对外端口
```

```bash
./frpc -c frpc.toml
```

浏览器/手机访问 `http://公网服务器IP:13579` 即可。手机也能用——这是远程办公最省事的路子。
代价：公网上有一个开放端口，**安全全靠控制台自身的口令 + 2FA**，请务必开齐。

### 方案 B · 推荐（不开任何公网端口，stcp 点对点）

`stcp` 加密隧道在公网**不监听端口**，只有持密钥的「访客端」能连——更适合长期远程办公。

**开发机**　`frpc.toml`：

```toml
serverAddr = "公网服务器IP"
serverPort = 7000
auth.token = "同 frps 的 token"

[[proxies]]
name = "ttmux-web"
type = "stcp"
secretKey = "再换一串强随机密钥"   # 访客端要一致
localIP = "127.0.0.1"
localPort = 13579
```

**你的笔记本（访客端）**　`frpc-visitor.toml`：

```toml
serverAddr = "公网服务器IP"
serverPort = 7000
auth.token = "同 frps 的 token"

[[visitors]]
name = "ttmux-web-visitor"
type = "stcp"
serverName = "ttmux-web"
secretKey = "同上面的 secretKey"
bindAddr = "127.0.0.1"
bindPort = 13579        # 映射到本机
```

```bash
# 开发机
./frpc -c frpc.toml
# 笔记本
./frpc -c frpc-visitor.toml
```

之后在笔记本上访问 `http://127.0.0.1:13579`——流量端到端加密，公网无暴露端口。
（缺点：访客端要跑 frpc，手机不便；手机场景用方案 A，或给 frps 配 `vhostHTTPSPort` + 域名走 https。）

### 替代方案

不想自己备公网服务器，也可用现成隧道：

- **Tailscale**：组网后用设备 tailnet IP 访问 `http://<tailscale-ip>:13579`，仅你的网络内可达，零端口暴露。
- **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:13579`，把 `TTMUX_WEB_BIND` 收回 `127.0.0.1`。

---

## 五、可选能力

### 浏览器镜像

「浏览器」标签把服务器上的一台 Chrome 实时投屏到网页（CDP screencast + 可接管输入 + 多 tab + F12 调试）。需要 `google-chrome` 可执行：

- 后端会在 `TTMUX_CHROME_CDP`（默认 `127.0.0.1:9222`）探测；端口没有 Chrome 时**自动拉起**一个带远程调试端口的实例（无显示器时自动 `--headless=new`）。
- 已有 Chrome 跑在该端口（如 Agent 自己起的）则直接附着，不重复拉起。
- 想清晰一点/省带宽一点，调 `TTMUX_CHROME_SCALE`。

### 浏览器自动化 —— `chrome`（独立 CLI）

`chrome` 是 ttmux 家族里**独立的浏览器自动化 CLI**（不是 `ttmux` 子命令），引擎是 **Playwright over CDP**。它 `connectOverCDP` 接的就是上面那台全局 Chrome（`TTMUX_CHROME_CDP`），所以**自动化能在 Web「浏览器」标签里实时围观**；没起 web 后端时，本命令也会按同一套 flag 自己拉起 Chrome。

依赖 `node` + `npm`，`install.sh` 会随 `chrome` 一起 `npm i playwright-core`（`connectOverCDP` 复用已开的 Chrome，**不下载 Playwright 自带浏览器**，很轻）。手动或重装：

```bash
chrome setup                       # 安装/更新依赖（node + playwright-core）
chrome goto https://example.com    # 打开网址
chrome text h1                      # 取文本
chrome eval "document.title"        # 页面内执行 JS
chrome screenshot shot.png --full   # 整页截图
chrome screenshot shot.png --fresh --goto https://example.com --viewport 1280x800
chrome tabs                         # 列标签页
chrome help                         # 全部动词与选项
```

动词：`goto / click / fill / type / press / text / html / attr / eval / wait / screenshot / pdf / tabs / new / close`；
通用选项 `--tab <序号>` / `--url <子串>` 选目标标签页、`--timeout <ms>`、`--cdp <地址>`。
批量截图优先用 `--fresh --goto <url>`；需要复用已登录状态或在 Web「浏览器」标签围观时再用默认共享 Chrome。
源码与开发见 [`../../cli/chrome-cli/README.md`](../../cli/chrome-cli/README.md)。

---

## 六、升级与卸载

**升级 CLI**：重跑一键脚本即可覆盖；或在仓库内 `git pull && bash cli/ttmux-cli/build.sh && bash install.sh`。

**升级 Web**：`git pull && ./start.sh --dev`（脚本检测改动并重编）。

**卸载**：

```bash
./start.sh stop                       # 先停 Web（如在跑）
rm -f ~/.local/bin/ttmux                   # CLI 二进制
rm -f ~/.claude/skills/ttmux.md ~/.claude/skills/cc-swarm.md   # skills
rm -rf ~/.local/share/ttmux                # 数据/日志（注意：会删任务组元数据）
rm -rf ~/.ttmux                            # 蜂群库（meta.db + 各群 swarm.db）
```

---

## 七、故障排查

| 现象 | 排查 |
|------|------|
| `command not found: ttmux` | `~/.local/bin` 不在 `PATH`，按[一-1](#1-一键安装推荐)追加。 |
| 启动报「需要先安装 tmux」 | 装 `tmux`。 |
| `swarm` 命令报缺 `sqlite3` | 装 `sqlite3`。 |
| 后端日志「找不到 ttmux」 | `TTMUX_BIN` 没指对，或 ttmux 不在 PATH。`start.sh` 会自动指向仓库内 `./ttmux`。 |
| 端口被占用 / 想换端口 | 改 `TTMUX_WEB_BIND`，或 `./start.sh stop` 清掉旧进程。 |
| 前端是「内嵌回退页」很简陋 | 说明没构建 React。跑 `./start.sh --dev` 或手动 `vite build`。 |
| 浏览器标签连不上 | 确认装了 `google-chrome`；检查 `TTMUX_CHROME_CDP` 指向的端口。 |
| 忘了口令 | 改 `.env` 的 `TTMUX_WEB_PASSWORD` 后 `./start.sh stop && ./start.sh`。 |
| 看后端日志 | `./start.sh logs`（默认 `/tmp/ttmux-web.log`）。 |
