# 手机 (Phone) 接入方案 — MVP

状态：**Android(Linux) 已实现并真机(redroid)联调通过**；**iOS(macOS) 后端已实现(代码完成，Linux 下编译 + darwin 交叉编译均通过，未在真 Mac 上联调)**。后端 `backend/phone/`(`android.go`+`ios.go`，按 `runtime.GOOS` 路由) + 前端 `frontend/src/PhoneView.tsx` + 「手机」标签 + 设置页「手机」标签三选一。本文档既是设计依据，也记录已落地的结构。

## 0. 目标与设计原则

新增一个平台无关的「手机」标签，像现有「浏览器」标签一样：在控制台里实时镜像一台手机画面，可远程点按/输入，并提供 `phone` CLI 给 agent 操作。与 Web 镜像同一台手机，所以 agent 的自动化能在控制台里实时围观。

一个抽象、两个后端实现，前端 / CLI / 路由共用一套。按宿主平台路由：

- **Linux → Android**（`adb`，redroid 容器 / 官方模拟器）
- **macOS → iOS**（`simctl` + `idb`，Xcode Simulator）

完全复刻 `backend/browser/` 的三支柱（生命周期 / 画面镜像 / 远程操作），只把底层换成平台原生的手机工具链。平台选择在后端启动时按 `runtime.GOOS` 决定，前端无感知——前端只跟「一台手机」对话。

```
        前端 PhoneView.tsx  +  phone CLI  +  /phone/* 路由   ← 平台无关
                              │
                     Device 接口 (Go)
                    ┌─────────┴─────────┐
            androidDevice            iosDevice
          (Linux: adb)          (macOS: simctl/idb)
```

## 1. MVP 范围

**进 MVP：** 启动/附着一台手机、画面镜像（JPEG 轮询，复用现有管线）、点按/滑动/输入文字/返回/Home、列 App + 启动 App、健康状态。

**不进 MVP：** H.264 低延迟流、scrcpy/视频解码、多实例、装 APK/IPA、剪贴板、旋转传感器、自适应码率优化（先固定一档）。

> 关键取舍：画面用 **screencap 轮询出 JPEG**（约 5-10fps），这样能**直接复用 `backend/browser/screencast.go` 的二进制帧格式 + 信用背压**，几乎不碰难点。视频流是 v2 的事。

## 2. 平台对照

| 能力 | Android (Linux) | iOS (macOS) |
|---|---|---|
| 实例 | `redroid` Docker 容器 / 官方 `emulator -no-window` | `xcrun simctl boot <udid>`（Xcode 自带 Simulator） |
| 控制通道 | `adb`（自带） | `simctl` + **`idb`**（Facebook iOS Bridge，需装） |
| 截屏 | `adb exec-out screencap`（裸 RGBA，免 PNG 解码） | `xcrun simctl io booted screenshot --type=jpeg -` |
| 点按/滑动 | `adb shell input tap/swipe` | `idb ui tap/swipe` |
| 输入文字 | `adb shell input text` | `idb ui text` |
| 返回/Home | `adb shell input keyevent 4/3` | `idb ui button HOME`（返回走手势/按钮） |
| 列 App | `adb shell pm list packages` | `simctl listapps booted` |
| 启动 App | `adb shell am start -n <pkg>/<act>` | `simctl launch booted <bundleId>` |

**依赖闸门：**

- **Linux：** Docker + redroid 内核模块（`binder`/`ashmem`），或 Android SDK + KVM。
- **macOS：** Xcode（Simulator）+ `idb`（`brew install idb-companion` + `pip install fb-idb`）。**simctl 自身无通用 tap**，所以 iOS 的输入强依赖 idb——这是 macOS 侧的硬依赖。无 idb 时 MVP 可降级为「只镜像 + simctl 启动 App，不能 tap」。

## 3. 后端结构

照 `backend/browser/` 抄：

```
backend/phone/
  phone.go        // Device 接口 + 平台工厂 + 通用生命周期(ensure/health/shutdown)
  android.go      // androidDevice: adb 封装
  ios.go          // iosDevice: simctl + idb 封装
  screencast.go   // /phone/stream WS 桥(复用 browser 帧格式 + 背压)
  handlers.go     // gin handlers: tap/swipe/text/apps/launch/health
```

抽象接口：

```go
type Frame struct{ W, H int; JPEG []byte }

type Status struct {
    OK       bool   `json:"ok"`
    Platform string `json:"platform"` // android | ios
    Error    string `json:"error,omitempty"`
}

type App struct {
    ID    string `json:"id"`   // 包名 / bundleId
    Name  string `json:"name"`
}

type Device interface {
    Ensure() error                              // 拉起/附着,轮询就绪(抄 ensureChrome 的串行+冷却)
    Shutdown()
    Health() Status                             // 含失败原因,回显 UI
    Frames(stop <-chan struct{}) <-chan Frame   // 截屏轮询源
    Tap(x, y int) error
    Swipe(x1, y1, x2, y2, ms int) error
    Text(s string) error
    Key(name string) error                      // back/home/enter
    Apps() ([]App, error)
    Launch(id string) error
}

func NewDevice() Device {       // 平台工厂
    if runtime.GOOS == "darwin" {
        return &iosDevice{}
    }
    return &androidDevice{}      // linux
}
```

坐标换算：前端发的是观看区 CSS 坐标，后端按当前帧分辨率折算成设备像素再注入（逻辑同 `BrowserView` 现有 mouse 换算）。

## 4. 路由

`backend/server/server.go`，挂认证组：

```
GET    /phone/stream            // 画面镜像 WS(?quality= 先固定)
GET    /phone/health            // 可用性 + 失败原因 + 平台(android/ios)
POST   /phone/tap        {x,y}
POST   /phone/swipe      {x1,y1,x2,y2,ms}
POST   /phone/text       {text}
POST   /phone/key        {name: back|home|enter}
GET    /phone/apps                // 列表
POST   /phone/apps/:id/launch     // 启动
```

## 5. 前端 `frontend/src/PhoneView.tsx`

复用 `BrowserView.tsx` 的 stage / 质量 / WS 渲染骨架：

- 一块手机画面 canvas（竖屏比例），点击 → `tap`，拖动 → `swipe`，键盘输入 → `text` / `key`。
- 顶部一行：返回 / Home / App 抽屉（列 `/phone/apps`，点一个 `launch`）。
- `health` 不可用时显示原因（如「未装 idb」「redroid 未就绪」）。

**i18n 必走**（见 [i18n.md](i18n.md)）：所有按钮 / 状态 / 空态文案进 `frontend/src/i18n/locales`，key 前缀 `phone.*`。

## 6. agent 操作：直接用原生工具（不做封装）

**不自造 `phone` CLI。** 与 `chrome`（Playwright 包了一层）不同，手机这边 agent 直接调用各平台**原生命令行**——
`adb`(Android) / `simctl`+`idb`(iOS)。原因：这些是业界标准工具，模型在训练里见得多、理解和纠错都更好；
再包一层自造动词只会增加模型要学的间接层，得不偿失。

agent 与 Web 镜像操作的是**同一台**设备，所以原生命令的效果能在控制台「手机」标签里实时围观——
和浏览器体验一致。

**Android（Linux）**

```bash
adb devices                                   # 确认已连接
adb shell pm list packages -3                 # 列第三方 App
adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1   # 启动
adb shell input tap <x> <y>
adb shell input swipe <x1> <y1> <x2> <y2> <ms>
adb shell input text "hello%sworld"           # 空格用 %s
adb shell input keyevent 4|3|66               # back|home|enter
adb exec-out screencap -p > shot.png
```

**iOS（macOS）**

```bash
xcrun simctl list devices booted              # 确认已启动
xcrun simctl listapps booted                  # 列 App（plist）
xcrun simctl launch booted <bundleId>         # 启动
idb ui tap <x> <y>                            # 点按/输入靠 idb（simctl 无通用 tap）
idb ui swipe <x1> <y1> <x2> <y2> --duration <s>
idb ui text "hello"
idb ui button HOME
xcrun simctl io booted screenshot shot.png
```

**后端要做的**：只负责把设备拉起/就绪（见 §7）并保证 `adb` / `simctl` / `idb` 在 PATH 上、
`/phone/health` 回显当前平台与目标设备标识（如 `ANDROID_SERIAL` / 模拟器 udid），让 agent 知道该对哪台操作。
具体命令交给模型自己组织。

### 操作覆盖

| 操作 | Android (`adb`) | iOS (`simctl` / `idb`) |
|---|---|---|
| 截图 | `adb exec-out screencap -p > a.png` | `xcrun simctl io booted screenshot a.png` |
| 录屏 | `adb shell screenrecord /sdcard/a.mp4` | `xcrun simctl io booted recordVideo a.mp4` |
| 点按 | `adb shell input tap x y` | `idb ui tap x y` |
| 滑动 | `adb shell input swipe x1 y1 x2 y2 ms` | `idb ui swipe x1 y1 x2 y2 --duration s` |
| 输入文字 | `adb shell input text "a%sb"` | `idb ui text "ab"` |
| 按键 | `adb shell input keyevent 4/3/66` | `idb ui button HOME`（无系统 back） |
| 列 App | `adb shell pm list packages -3` | `xcrun simctl listapps booted` |
| 启动 App | `adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1` | `xcrun simctl launch booted <id>` |
| 装包 | `adb install a.apk` | `xcrun simctl install booted A.app` |
| 开链接 | `adb shell am start -a android.intent.action.VIEW -d <url>` | `xcrun simctl openurl booted <url>` |
| **读屏幕结构** | `adb shell uiautomator dump`（UI 层级 XML） | `idb ui describe-all`（无障碍元素树） |

> 截图/录屏在两平台原生工具里都是一等公民，无需封装。
> **读屏幕结构**最值得优先暴露：给模型 UI 元素树（带坐标/文案/可点性），它就能「看结构→算坐标→tap」，
> 不必纯靠像素猜坐标，可靠性高一档。唯一硬缺口是 iOS 输入全依赖 `idb`。

## 6.5 后端目标配置（设置页「手机」标签，两级：平台 → 来源）

后端目标由 `backend/phone/config.go` 持久化(`<dataDir>/phone-config.json`)。配置 `{platform, mode, address, resolution}`，
`Current()` 按 **platform** 选后端（android→adb / ios→simctl+idb），**与主机系统解耦**——Mac 上也能选 Android。

**平台 Android**（mode 子档）：

| mode | 含义 | 地址 |
|---|---|---|
| `local` | 本地 redroid（同机容器） | 默认 `localhost:5555` |
| `remote` | 远程 redroid（**ARM 主机原生跑 arm App，绕反模拟器**） | 它的 adb `host:port` |
| `device` | 真机（**Linux/Mac 都支持**，adb 在 Mac 也有） | 无线 `host:port`；USB 填 serial（空=默认） |

**平台 iOS**（仅 macOS）：`address` = 模拟器 UDID（空=已 booted）；需 Xcode + idb。

`host:port` 形式在 `Ensure` 时先幂等 `adb connect` 再当 `-s` 目标。API：`GET/PUT /phone/config`、`POST /phone/connect`。
旧配置（mode 曾编码平台）自动迁移：`mode=ios`→`{ios,simulator}`，其余→`{android, mode}`。

**依赖按平台自适应安装**：`scripts/phone/install-phone.sh`（已并入 `install.sh`）——Linux 装 `adb`；macOS 装 `idb`+`adb`（Mac 同时支持 iOS 模拟器与接 Android 真机）。

> **反模拟器 App（同花顺/东方财富等）的正解 = 远程 redroid 跑在 ARM64 主机**，或真机。x86 上 arm 翻译会被 native 检测识破（详见调研记录）。
> **Jetson 实测**：ARM64 合适,但 NVIDIA L4T 内核 `CONFIG_KPROBES` 未开、无 `CONFIG_ANDROID_BINDER` → 现成内核装不了 binder（anbox 模块需 kprobes），**要重编内核**(加 `CONFIG_ANDROID_BINDER_IPC=m`+`CONFIG_ANDROID_BINDERFS=m`+`CONFIG_KPROBES=y`)才能跑 redroid。

## 7. 生命周期细节

抄 `ensureChrome`（`backend/browser/browser.go`）的健壮性：

- **串行 + 冷却 + 收尸**：防并发拉起多实例（Android 容器/模拟器、iOS 模拟器都该单实例）。
- **附着优先**：adb 已连 / Simulator 已 booted 就直接用，不重起。
- **就绪轮询**：Android 等 `adb wait-for-device` + `boot_completed`；iOS 等 `simctl bootstatus`。
- **Shutdown**：Linux 停容器 / kill 模拟器；macOS `simctl shutdown`（可选保留，因为模拟器复用快）。

## 8. 分步骤实施

每步都有明确**验收标准**，做完能独立验证再进下一步。先单平台（Linux/Android）打通整条链路，再补 iOS。

> ✅ **步骤 1-4（Android）已完成。** 后端 `backend/phone/{phone,android,screencast,handlers}.go`，
> 路由挂在 `backend/server/server.go` 的 `/phone/*`；前端 `PhoneView.tsx` + App.tsx「手机」标签 + `phone.*` i18n。
> 画面走「按需截屏」背压（截一帧需有信用），点按/滑动/输入经 WS，App 列表/启动/系统键/UI 结构走 REST。
> 剩余：步骤 5（iOS）+ 真机联调（步骤 0 闸门）。

**步骤 0 — 可行性闸门（0.5 天）**
- 做：Linux 起 redroid/模拟器，手敲 `adb exec-out screencap -p > a.png` 出图、`adb shell input tap` 有反应；macOS `simctl boot` 一台、`idb ui tap` 跑通。
- 验收：两台宿主各能手动截一张图 + 点一下。**这是最大不确定性，过不了就先解决宿主，不写代码。**

**步骤 1 — Device 接口 + Android 实现（2 天）**
- 做：`backend/phone/{phone.go,android.go}`。定义 `Device` 接口（见 §3），`androidDevice` 用 `adb` 实现 `Ensure/Health/Frames/Tap/Swipe/Text/Key/Apps/Launch`。`Frames` 走 `adb exec-out screencap` 轮询 → JPEG。
- 验收：写个临时 main 调 `Ensure()` + 存一帧 JPEG + `Tap()` 生效。

**步骤 2 — screencast WS + 路由 + handlers（1.5 天）**
- 做：`backend/phone/{screencast.go,handlers.go}`，把 `Frames` 源接到**复用** `browser/screencast.go` 的二进制帧格式 + 背压；注册 §4 路由到 `server.go`（认证组）。
- 验收：浏览器开 `/phone/stream` 能看到实时画面；`curl POST /phone/tap` 设备有反应。

**步骤 3 — 读屏幕结构（0.5 天）**
- 做：加 `GET /phone/ui`，Android 返 `uiautomator dump` 解析后的元素列表（含 bounds/text/clickable）。
- 验收：返回的 JSON 里能找到当前界面的可点元素及坐标。（给 agent 用，价值最高、成本很低，故单列。）

**步骤 4 — PhoneView 前端 + i18n（2 天）**
- 做：`frontend/src/PhoneView.tsx`，复用 `BrowserView` 渲染骨架：画面 canvas + 点击/拖动/键盘 → 路由；顶部 返回/Home/App 抽屉。文案进 i18n（`phone.*`）。
- 验收：控制台「手机」标签能看画面、点得动、列/启 App；中英文都对。

**步骤 5 — iOS 实现（2 天）**
- 做：`backend/phone/ios.go`，用 `simctl`+`idb` 实现同一 `Device` 接口；`NewDevice()` 按 `runtime.GOOS` 路由。`/phone/ui` 走 `idb ui describe-all`。
- 验收：macOS 上同一前端无改动即可镜像并操作 iOS 模拟器；无 idb 时 `health` 明示降级。

合计：单平台（步骤 0-4）约 1 周；补齐 iOS（步骤 5）再约 0.5 周。

## 9. 风险 / 闸门

- **Linux：** redroid 需内核模块 + x86_64/ARM；无则退官方模拟器，但云机常无 KVM → 慢到不可用。**先测**。
- **macOS：** `idb` 安装链（idb_companion + fb-idb）较脆，是 iOS 输入的单点依赖；无 idb 时 MVP 降级为「只镜像 + simctl 启动 App，不能 tap」。
- **画面：** screencap 轮询 CPU 偏高、帧率低 —— MVP 可接受，产品验证后再上 scrcpy / idb 视频流（v2）。

## 10. 下一步

先做**阶段 0**（半天），把两台宿主的可行性闸门各测掉一张截图 + 一次 tap——这是整件事最大的不确定性。测过再进阶段 1。
