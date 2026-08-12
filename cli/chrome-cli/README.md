# chrome-cli — `chrome` 的模块化源码

`chrome` 是 ttmux 家族里**独立的浏览器自动化 CLI**：用 [Playwright](https://playwright.dev) 的
`connectOverCDP` 接全局 Chrome 的调试端口（默认 `127.0.0.1:9222`）——与 ttmux Web 镜像
**同一台**，所以自动化能在控制台「浏览器」标签里实时围观。`connectOverCDP` 复用已开的
Chrome，**不下载 Playwright 自带浏览器**，依赖只有一个 `playwright-core`。

与根目录的 `ttmux` 一样，分发的是**单文件**（`install.sh` / `curl | bash` 直接装），源码在此拆开维护。

## 文件

| 文件 | 作用 |
|------|------|
| `driver.mjs` | Playwright 驱动（真源）：解析动词 → 调 Playwright API。 |
| `launcher.sh` | bash 启动器模板：装依赖、确保 Chrome、跑 `node driver.mjs`；含 `@@DRIVER@@` 内联标记。 |
| `build.sh` | 把 `driver.mjs` 内联进 `launcher.sh` 的 `@@DRIVER@@` 处 → 生成 仓库根/`chrome`。 |
| `package.json` | 运行时依赖声明（`playwright-core`）。 |

## 工作流

```bash
vim cli/chrome-cli/driver.mjs      # 改驱动逻辑
bash cli/chrome-cli/build.sh       # 重新生成根目录 chrome（末尾自带 bash -n 自检）
bash install.sh                    # 可选：装到 ~/.local/bin + npm i playwright-core
```

> ⚠ 不要手改根目录的 `chrome`——它是 `build.sh` 的生成物，下次 build 会被覆盖。

## 运行时落盘

首次使用（或 `chrome setup`）会在 `~/.local/share/ttmux/chrome/`（`$TTMUX_DATA/chrome`）
写出 `driver.mjs` 并 `npm i playwright-core`。`install.sh` 会在安装时预热这一步。

热路径上有个常驻 daemon（unix socket，空闲自杀）持有 CDP 连接，它把 driver 代码**读进内存**
长跑：所以内嵌 driver 内容一变，`_write_driver` 会顺手请它退场，下一条命令拉起装着新代码的
——否则 `build.sh` 之后改动要等它空闲超时才生效，调试时极易误判「改了没用」。

## 用法

```bash
chrome setup                      # 安装/更新依赖
chrome goto https://example.com   # 打开网址
chrome text h1                     # 取文本
chrome eval "document.title"       # 页面内执行 JS
chrome screenshot shot.png --full  # 整页截图
chrome screenshot shot.png --mobile             # 手机视口（iPhone）截图
chrome screenshot shot.png --device pixel       # 指定机型: iphone|iphone-se|pixel|ipad
chrome screenshot shot.png --fresh --goto https://example.com --viewport 1280x800
chrome tabs                        # 列标签页
chrome help                        # 全部动词与选项
```

批量截图建议使用 `--fresh --goto <url>`：它会临时启动一个干净 Chrome，截图后关闭；
需要复用已登录状态或在控制台围观自动化时，继续使用默认共享 Chrome 模式。

## 和「浏览器」设置页共用一套配置

CLI 不自带一套默认值，**跟着后端走**——否则「设置里选了有头、CLI 却又开一台无头的」，
两台 Chrome 各干各的，Web 镜像里看不见 CLI 的动作：

- **目标端口**：读后端记录的 `<数据目录>/browser-cdp-port`（后端发现 9222 被占会自动换端口
  并记下来），没有记录才回落 `9222`。数据目录同后端解析：`ROAM_DATA` > `TTMUX_DATA` >
  `ROAM_HOME` > `TTMUX_HOME` > `~/.roam`。
- **自己拉起 Chrome 时的参数**：读 `<数据目录>/browser-config.json`（就是设置页「浏览器」
  存的那份）——模式（`auto`/`on`/`off`）、窗口尺寸、`--force-device-scale-factor`、
  profile 目录、可执行路径，与后端 `ensureChrome` 取同一份值、同一套判定（`auto` = 没显示器
  或 WSL 才无头）。语义的权威出处是 `backend/browser/{config,browser}.go`。

## 只有一台

同一个 profile 只该有一台 Chrome，这件事不靠「碰巧」，有三道闸：

1. **端口上有 Chrome 就附着**，不再拉起（后端、CLI 都一样）。
2. **端口不对也认**：同 `user-data-dir` 的实例已经在别的端口上跑着时，两边都改用它的调试端口
   （后端还会把端口记进 `browser-cdp-port`，CLI 跟着读）。同 profile 的 Chrome 本来就是单例，
   这时再拉一个只会把命令行转交给它然后自己退出、端口永远不开——从前的表现是「启动后随即
   退出」这种没头没尾的报错。
3. **并发只有一个能拉**：CLI 用 `flock`（`<运行时目录>/launch.lock`）跨进程串行，拿到锁后
   重新探一遍。agent 一次并发甩十几条 `chrome` 命令是常态，没这道闸就是十几次启动互相打架。

端口上已经有 Chrome 时**只附着，不改参数**——那台是谁按什么参数起的就什么样，改了设置要
在设置页点「重启 Chrome」才换得上。启动参数与后端 `ensureChrome` **逐字一致**，所以「这台
Chrome 是谁起的」不影响它的行为。

两处刻意不一致，都是为了「跟着镜像走」：

- **自签证书**由 driver 按 CDP 逐标签放行（`Security.enable` + `setIgnoreCertificateErrors`，
  见 `allowInsecureTLS`），不加 `--ignore-certificate-errors` 启动开关——开关只在「CLI 抢到
  启动」时才轮得到，且一加就是整个浏览器全站放行，把镜像里的正常上网也松掉了。
- **端口被占时不自己换端口**：后端会换（并记下来），CLI 只报错。CLI 换到一个镜像不知道的
  端口，等于开一台没人看得见的 Chrome。

环境变量：`TTMUX_CHROME_CDP`（固定目标地址，优先于上面的端口记录）、`TTMUX_CHROME_SCALE`
（默认 2）、`TTMUX_CHROME_WINDOW`（默认 `1920,1080`）——后两个只在设置里没存值时兜底。
