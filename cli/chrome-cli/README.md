# chrome-cli — `chrome` 的模块化源码

`chrome` 是 ttmux 家族里**独立的浏览器自动化 CLI**：用 [Playwright](https://playwright.dev) 的
`connectOverCDP` 接 `127.0.0.1:9222` 上的全局 Chrome——与 ttmux Web 镜像**同一台**，所以
自动化能在控制台「浏览器」标签里实时围观。`connectOverCDP` 复用已开的 Chrome，**不下载
Playwright 自带浏览器**，依赖只有一个 `playwright-core`。

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

环境变量：`TTMUX_CHROME_CDP`（默认 `http://127.0.0.1:9222`）、`TTMUX_CHROME_SCALE`（默认 2）。
