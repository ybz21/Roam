# 13 · 移动端响应式布局重做

> 图纸：[13-mobile-responsive/index.html](./13-mobile-responsive/index.html)
> （P0 现状对照 · P1 断点与令牌 · P2 导航与会话坞 · P3 会话页 · P4 页面塌陷 · P5 平板与横屏 · P6 规格表）
>
> 独立评审页：[项目](./13-mobile-responsive/projects.html) · [文件](./13-mobile-responsive/files.html) ·
> [会话](./13-mobile-responsive/session.html) · [浏览器](./13-mobile-responsive/browser.html) ·
> [手机](./13-mobile-responsive/phone.html) · [插件](./13-mobile-responsive/plugins.html) ·
> [设置](./13-mobile-responsive/settings.html) · **[expanded 档（平板/小笔电）](./13-mobile-responsive/expanded.html)**
>
> 后补两稿：[三页分工（概览/项目/会话）](./13-mobile-responsive/ia.html) ·
> **[二级页：Git / Worktree / 返回键](./13-mobile-responsive/panels.html)**（§6 剩下那两行的落地图纸，含自审）
>
> 状态：**设计草案，未实现**。落地范围见 §10 分期。

---

## 1. 现状：没有响应式系统，只有一个布尔开关

Roam 的三端适配在 [04-frontend §2](./04-frontend.md) 里写的是「`AppShell` 是唯一感知端的组件，
按断点切三档」。实现出来的是另一回事——**全站没有一个响应式系统，只有散落各处的一个布尔量**。

### 1.1 断点判定散在 6 处，阈值互不相同

| 位置 | 判定 | 阈值 |
|---|---|---|
| `App.tsx:269` | `!screens.md` | 768 |
| `App.tsx:210`（FilesPage） | `!screens.md` | 768 |
| `PluginsPanel.tsx:75` | `!screens.md` | 768 |
| `chat/ChatShell.tsx:44` | `!screens.md` | 768 |
| `WorktreePanel.tsx:327` | `!screens.md` | 768 |
| `GitPanel.tsx:135` | `window.innerWidth >= 900` | **900** |
| `Swarm.tsx:1037` | `window.innerWidth` 算抽屉宽 | 裸值 |
| `FileWorkspace.tsx:208` | `matchMedia('(pointer: coarse)')` | 指针类型 |
| `index.css:282` | `@media (max-width: 760px)` | **760** |

`index.css` 全文 907 行，媒体查询只有 **5 条**，其中 4 条是 `pointer: coarse`，
唯一一条宽度查询是 `max-width: 760px`（还是给桌面浮层用的）。
**布局适配几乎全靠 JS 分支 + 行内样式**，改一个断点要翻六个文件。

### 1.2 一半以上的页面根本没有移动端分支

`Projects.tsx`（1522 行，08 设计里的唯一主入口）、`Swarm.tsx`、`Overview.tsx`、`Race.tsx`、
`CronPanel.tsx`、`HostMonitorPanel.tsx`、`EnvPage`（App.tsx 内）——**没有任何断点判断**，
窄屏下就是桌面布局硬塞。具体后果：

- `Swarm.tsx:378` 写死 `gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)'`，360px 屏上两列各 174px。
- `CronPanel.tsx` 表格固定列宽 `130 + 170 + 190`，加上名称列必然横向滚动，且没有滚动提示。
- `EnvPage` 的输入框固定宽 `120 / 130 / 150 / 180 / 220px`，label 左对齐，窄屏下换行成阶梯。
- `Projects.tsx` 的 `.prj-tabs` 五个 tab 平铺无横滑容器；`.prj-composer` 的 pill 组换行成三行。

### 1.3 768–904px（iPad 竖屏）是块彻底的破地

`hasSider = screens.md`（≥768）就走桌面三栏。在 iPad mini 竖屏（768）上打开一个终端后：

```
Sider 208 + Content(flex 0 0 300) + 把手 18 + 终端坞(minWidth 480) = 1006px > 768px
```

`Content` 是 `flex: 0 0 300px` 不可收缩，终端坞 `minWidth: 480` 也不让步 → 直接溢出。
**桌面档的下界（768）比桌面布局的最小可用宽度（约 1000）低了 230px。**

### 1.4 会话页：五层 chrome 把终端挤成一条缝

手机上打开会话是全屏覆盖层（`App.tsx:701`），从上到下五层：

| 层 | 来源 | 高度 |
|---|---|---|
| 标签条 `.tt-tabs` | `index.css:111` padding 6 + tab 28 | 41 |
| 工具条 `.tt-tbar` | `index.css:112` padding 5 + 按钮 27，**14 个控件** | 38 |
| 移动输入行 | `App.tsx:1232` padding 8 + antd Input 32 | 40 |
| 快捷键条 | `App.tsx:1240` padding 8 + antd Button 32，**17 个按钮** | 49 |
| | **chrome 合计** | **168px** |
| 终端区 padding | `App.tsx:1205` | +12 |
| | **终端画布之外合计** | **180px** |

360×640 的安卓机，浏览器可视高约 560px，13px 字号（xterm 行高约 15px）：

- 键盘收起：终端画布 380px ≈ 25 行，尚可。
- **键盘弹起（约 300px）：可视区 260px − 180px = 终端画布 80px ≈ 5 行。**

而这正是手机上唯一真正要用的场景——打字。同时 14 个控件的工具条是单行横滑
（`.tt-tbar { overflow-x: auto }`），**右段的字号 / 重绘 / 重连永远在视口外，且没有任何"还能往右滑"的提示**。

### 1.5 触控目标普遍不达标

| 控件 | 实际高度 | 44px 标准 |
|---|---|---|
| `.tt-tbtn` 工具条按钮 | 27 | ✗ |
| `.tt-tgroup .tt-tbtn` 分段组内按钮 | 23 | ✗ |
| `.tt-tab` 会话标签 | 28 | ✗ |
| `.tt-tab .tt-x` 关闭键 | 18×18 | ✗ |
| antd 默认 Button / Input（快捷键条、输入行） | 32 | ✗ |
| `.prj-pill` 项目页胶囊 | 26 | ✗ |
| `.prj-tab` 项目页 tab | ~35 | ✗ |
| `.tt-file-close` | 24×24 | ✗ |

这些尺寸在鼠标下是「精致克制」，在拇指下是**连点三次点不中**。

### 1.6 二级页机制不统一，z-index 各自为政

只有 `FilesPage` 用了 `MobileSubPage`（Android Fragment 式全屏二级页）。其余：
`WorktreePanel` 用 antd `Drawer width='100%'`、`Swarm` 用 `Drawer`、`GitPanel` 用手写 `position: fixed`、
`Projects` 用手写全屏 `fixed` 遮罩、`FloatingFileDrawer` 用 `fixed` 右侧栏。

结果是层级靠"打架打出来的数字"：

```
50(底栏) 90(二级页) 100(会话覆盖) 1000(Projects 遮罩/antd Drawer) 1199(GitPanel/FileBrowser)
1200(FloatingFileDrawer) 1201(.tt-file-detail @media) 1300(WorktreePanel/弹层基座) 9999(拖拽幽灵)
```

而且这些 fixed 层**全都没处理安全区**：`FloatingFileDrawer` 是 `top:0; bottom:0`，
在刘海屏上顶进状态栏、底部压在手势条下面；`MobileSubPage` 只补了 `padding-top`，没补底部。

### 1.7 软键盘只在一个地方被认真对待

`index.html` 里配了 `interactive-widget=overlays-content`，`main.tsx` 里设了
`virtualKeyboard.overlaysContent = true`，然后 `env(keyboard-inset-height)` 全站只用在
`App.tsx:1272` **一处**。任何别的带输入框的弹层（重命名、粘贴、快捷命令、Projects composer、
Git 提交信息）在键盘弹起后都可能被遮住。而且 `keyboard-inset-height` 在 iOS Safari 不支持，
没有 `visualViewport` 兜底。

**一句话：移动端不是被设计出来的，是从桌面版"降级掉了几个组件"剩下的。**

---

## 2. 设计目标

| 目标 | 落到界面上 |
|---|---|
| **一处判定** | 全站只有 `useLayout()` 一个断点入口 + `<html data-size>` 一套 CSS 钩子；删掉 6 处散阈值 |
| **手机是一等形态** | 每个页面都要回答"compact 档长什么样"，不允许再有"桌面布局硬塞" |
| **拇指够得着** | 所有可点元素命中区 ≥ 44×44；主操作落在屏幕下 1/3 |
| **内容优先** | 会话页 chrome 从 168px 压到 107px；键盘弹起时终端从 5 行回到 7 行 |
| **一套二级页机制** | 全屏二级页 / 底部 sheet 两个基元，覆盖今天的 6 种弹层写法 |
| **层级可解释** | z-index 收进 9 个具名令牌，不再有 1199/1200/1201 |
| **边界安全** | 安全区四边 + 软键盘高度做成 CSS 变量，所有浮层统一吃 |

**不做**：不改任何功能语义与数据流；不引入 UI 框架（antd-mobile 之类）；不做手机专属路由表
（同一套 hash 路由，同一份状态，旋转屏幕不丢选中项——这条 04 设计里已定，本次只是终于兑现）。

---

## 3. 断点与令牌

### 3.1 四档窗口尺寸

对齐 Material 3 window size class（业界通用、和 antd Grid 能整数对齐），实践四档：

| 档 | 宽度 | 典型 | 布局形态 |
|---|---|---|---|
| **compact** | `< 600` | 手机竖屏 360/390/414 | 单栏 + 底栏 + 全屏二级页 |
| **medium** | `600 – 904` | 手机横屏 667/844、小平板竖屏 768/834 | 单栏 + 左侧导航轨(rail) + 详情走 sheet |
| **expanded** | `905 – 1279` | 平板横屏、小笔电 | 64px 导航轨 ｜ 页面；终端是覆盖式面板（§13.1） |
| **large** | `≥ 1280` | 桌面 | 三栏：Sider ｜ 页面 ｜ 终端坞（现状） |

关键改动：**桌面三栏的下界从 768 抬到 1280**。§1.3 的溢出根因就是 768 太低。
768–1279 之间不再挂常驻终端坞，终端走 sheet / 二级页，页面拿到完整宽度。

补一条**姿态**判定（不是宽度）：`compact-landscape` = `高度 < 480 且宽 > 高`（手机横屏）。
此时底栏改成左侧 56px 轨道，把纵向像素还给内容。

### 3.2 唯一入口 `useLayout()`

```ts
// frontend/src/layout.ts —— 全站唯一断点入口
export type WindowSize = 'compact' | 'medium' | 'expanded' | 'large'

export function useLayout(): {
  size: WindowSize
  phone: boolean        // size === 'compact' || 'medium'  ← 取代今天所有 !screens.md
  desktop: boolean      // size === 'expanded' || 'large'
  landscape: boolean    // 高 < 480 且横向
  coarse: boolean       // pointer: coarse
  keyboard: number      // 软键盘高度 px（0 = 收起）
}
```

同时在 `<html>` 上写 `data-size` / `data-orient` / `data-pointer`，纯样式适配走 CSS：

```css
html[data-size="compact"] .prj-tabs { overflow-x: auto; scrollbar-width: none; }
html[data-pointer="coarse"] .tt-tbtn { min-height: var(--tap); }
```

**判定不用 `window.innerWidth`**（旋转/键盘时不稳），用 `matchMedia` + `visualViewport`。

### 3.3 密度令牌

写进 `index.css` 的 `:root`，compact 档整体覆盖一次——**触控放大、留白收紧**：

```css
:root {
  --tap: 44px;            /* 最小命中边长 */
  --ctl-h: 32px;          /* 控件高（桌面） */
  --pad-page: 16px;       /* 页面四周留白 */
  --gap: 10px;
  --fs-body: 14px;  --fs-meta: 12px;  --fs-chip: 12.5px;
  --r-card: 12px;   --r-sheet: 16px;

  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --kb: 0px;              /* 软键盘高度，JS 回填，见 §8 */
}
html[data-size="compact"] {
  --ctl-h: 40px;          /* 控件长高：拇指够得着 */
  --pad-page: 12px;       /* 留白收紧：360px 屏上多出 8px 内容宽 */
  --gap: 8px;
  --fs-body: 15px;        /* 正文反而放大：手机阅读距离更近但屏更小 */
  --fs-meta: 12.5px;
}
```

**终端字号不跟密度走**：`--fs-body` 在 compact 档放大到 15px 是给正文的；xterm 的字号继续
由终端自己的偏好控制（12 稿的 `A− / A＋`）。否则用户在手机上调好的行宽，会因为换了台设备
被密度令牌改掉——14 §8.3 在桌面侧写的是同一句话。

**为什么 compact 下控件变高、留白变小？** 两者不矛盾：留白是给眼睛的，触控区是给手指的。
360px 宽的屏幕上 16px×2 的页面 padding 吃掉 9% 宽度，收到 12px 能多放一个标签；
而 27px 的按钮再怎么留白也点不准，必须长到 40+。

### 3.4 命中区扩展，不靠撑大视觉

图标按钮视觉上可以还是 28px，但命中区必须 44。用伪元素扩，不改布局：

```css
html[data-pointer="coarse"] .tt-tab .tt-x::after,
html[data-pointer="coarse"] .tt-tbtn.tt-ico::after {
  content: ''; position: absolute; inset: 50% auto auto 50%;
  width: var(--tap); height: var(--tap); transform: translate(-50%, -50%);
}
```

### 3.5 层级令牌

九个具名层，取代今天的九个魔数：

```css
:root {
  --z-sticky: 10;    /* 页面内粘性头 */
  --z-fab: 30;       /* 悬浮按钮 / 方向键簇 */
  --z-nav: 50;       /* 底栏 / 导航轨 */
  --z-subpage: 90;   /* 全屏二级页 */
  --z-session: 100;  /* 会话全屏 */
  --z-scrim: 900;    /* 遮罩 */
  --z-sheet: 1000;   /* 底部 sheet / 抽屉 */
  --z-popup: 1300;   /* antd 弹层基座（ConfigProvider zIndexPopupBase） */
  --z-toast: 1500;
  --z-drag: 9999;    /* 拖拽幽灵 */
}
```

规则：**同层不叠**。今天 `FloatingFileDrawer(1200)` 和 `GitPanel(1199)` 并排显示靠差 1，
新规则里它们是同一层的两个 sheet，由 sheet 栈管理器决定谁在上，不再手算数字。

---

## 4. 导航与信息架构

### 4.1 底栏：6 格 → 4 格 + 更多

今天底栏是 `概览 / 项目 / 文件 / 浏览器 / 手机 / 更多` 六格。360px 宽下每格 60px，
其中「浏览器」（内嵌 Chrome 镜像）和「手机」（安卓镜像）在手机上是**用手机看手机**——
低频、且窄屏下几乎不可用（`BrowserView.tsx:23` 地址栏固定宽 150px，`PhoneView.tsx:237`
设备选择器固定宽 240px）。

按 08 设计「项目页是唯一主入口」重排：

```
[ 项目 ]  [ 概览 ]  [ 文件 ]  [ 更多 ]        ← 4 格，每格 90px
```

「更多」不再是 antd `Dropdown` 小菜单，改成**半屏 sheet**，每项 48px 高、带图标和说明。
理由：Dropdown 在底栏上弹出的菜单项高度 32px、贴着屏幕边缘，是全站最难点中的控件之一。

sheet 内部按 14 §4.4 的同一条分层拆成两段，**不把功能页和账户动作平铺成一列**：

```
工具    浏览器 · 手机镜像 · 插件
──────────────────────────────────────
账户    [头像] 当前设备                    ›   ← 二级：设置 / 主题 / 全屏 / 退出
```

「退出登录」不出现在第一层：它和「浏览器」并排时误触代价差了几个数量级。
桌面把它收进账户菜单，手机收进账户行的二级 sheet——**两端同一条规则，只是容器不同**。

### 4.2 会话坞（Session Dock）——手机上最缺的那块

今天手机上的会话只有两态：**全屏覆盖**或**完全看不见**。回到项目页那一刻，你就不知道
还有几个会话在跑、哪个在等你确认了——而这恰恰是 Roam 存在的理由。

在底栏之上加一条 **50px 的常驻会话坞**（无会话时整条消失）：

```
┌──────────────────────────────────────────────┐
│ ● claude-api-refactor    ⚠2 等待   ⌃  │ 3 │  │  ← 会话坞 50px
├──────────────────────────────────────────────┤
│  项目      概览      文件      更多           │  ← 底栏 60px + safe-b
└──────────────────────────────────────────────┘
```

- 左：状态点 + **`项目 · 会话`**——与 14 的 Dock 标签是同一串文案，分支名进长按气泡。
  空间不足时**先截项目名，会话名不省略**（会话名才是你要找的那个东西）
- 中：**等待输入**的会话数（琥珀色，`detectPrompt` 已有的信号），零则不显示
- 右：会话总数徽标
- **点**：展开全屏会话页（当前会话）
- **上滑**：同上（拇指手势，比点更快）
- **点徽标 / 长按**：会话切换 sheet——列表每行 56px，带状态点、Agent 标记、等待标记、关闭键

这条坞取代了今天「会话开着但你看不见」的黑洞，也让底栏不必再为终端留一格。

**badge 只标「要行动的」**（14 §4.4 同款规则）：底栏与导航轨上的角标只显示等待输入、待收尾
这类需要你动手的数量，不显示「一共有几个」。坞右侧的会话总数是唯一例外——坞的职责就是
回答「还有几个在跑」，那不是装饰性计数。

### 4.3 两个二级基元，覆盖今天的六种弹层

| 基元 | 用途 | 行为 |
|---|---|---|
| `<MobileSubPage>` | 详情页、Git 面板、Worktree 管理、插件详情、文件预览 | 全屏、`history.pushState` 让**安卓物理返回键=返回** ✓、四边吃安全区 ✓、portal 到 body ✓；右滑边缘返回未做 |
| `<MobileSheet>` | 溢出菜单、会话切换、筛选排序、设备/策略选择、快捷命令 | 底部升起，高度 `auto / 50% / 88%` 三档，下拉关闭，`--kb` 抬起，圆角 16 |

compact/medium 档下，**所有 antd `Drawer` 自动降级为底部 sheet**（`placement="bottom"`），
所有 `Modal` 宽度改 `calc(100vw - 24px)` 且不居中垂直、贴底升起。

今天 `WorktreePanel` 在窄屏是 `width='100%'` 的右侧抽屉（`WorktreePanel.tsx:417`）——
视觉上和全屏页没区别，但入场动画从右边横切、关闭要点右上角 × ——**既不是页也不是 sheet**。
统一后它是二级页，有返回箭头、吃物理返回键。

### 4.4 medium 档：底栏 → 左侧导航轨

手机横屏和小平板竖屏（600–904）纵向像素金贵，底栏 60 + 会话坞 50 + 安全区 = 一百多像素。
改成左侧 **56px 导航轨**：图标竖排 + 会话坞变成轨底的会话徽标。内容区拿回全部高度。

---

## 5. 会话页重做（手机主战场）

### 5.1 顶栏：两行 79px → 一行 50px

```
┌─────────────────────────────────────────────────────┐
│ ←   ● claude-api-refactor ⌄ ③      ✳  ◉      ⋯     │  50px
└─────────────────────────────────────────────────────┘
```

| 位 | 内容 | 说明 |
|---|---|---|
| `←` | 收起会话，回到下层页面 | 命中区 48×48 |
| 中间胶囊 | 状态点 + `项目 · 会话` + `⌄` + 会话数徽标 | **点开 = 会话切换 sheet**（取代横滑标签条）；窄屏先截项目名 |
| `✳ ◉` | Claude / Codex 视图切换 | 该 Agent 在跑才出现，是唯一保留在栏内的开关 |
| `⋯` | 溢出菜单 sheet | 其余 12 个控件全进这里 |

**为什么标签条要变成 sheet？** 横滑标签条在两三个会话时还行，五个以上时当前标签会滑出视口
（`App.tsx:874` 已经在用 `scrollIntoView` 打补丁）。一个 56px 行高的列表 sheet 能一屏看到 8 个会话，
带状态、带等待标记、带关闭键——**信息量和可点性都是横滑标签条的数倍**。

**溢出菜单 sheet 分组**（沿用 12 设计的三段断句，只是从横排变竖排）：

```
会话动作   重命名 · 在新标签打开 · tmux 基操 ▸
面板       文件 · Git · 语音输入 · 弹框提醒        ← 开关型，右侧带 Switch
画面       字号 A− A+ · 上翻 · 回底 · 重绘 · 重连   ← 只读工具，一行四格图标
```

### 5.2 底部输入面板

两态，都贴 `--kb`（软键盘高度）：

```
键盘收起  ┌────────────────────────────────────┐
         │  ⌨  输入…                    [发送] │   57px
         └────────────────────────────────────┘
                          总 chrome = 50(顶栏) + 57 = 107px

键盘弹起  ┌────────────────────────────────────┐
         │ Esc  Tab  ^C  ^D  /  q  y  n   ▸    │   43px  ← 单行横滑，边缘渐隐提示
         ├────────────────────────────────────┤
         │  ⌨  git status               [发送] │   57px
         └────────────────────────────────────┘
                          总 chrome = 40(压缩顶栏) + 43 + 57 = 140px
```

（终端内边距同时从 `6px` 收到 `4px`——6px 在桌面上是让画布不贴边，手机上是白扔 4px。）

两条关键：

- **快捷键条只在输入态出现**。今天它常驻 49px，而不打字时它一个键也用不上。
- **键盘弹起时顶栏自动压到 40px**：只留 `←` + 会话名 + `⋯`，Agent 切换和徽标暂时收起
  （正在打字时不会去切视图）。省下的 8px 直接给终端。

### 5.3 方向键簇（D-pad）

今天 `↑ ↓ ← →` 是快捷键条里四个 32px 的按钮，夹在 17 个按钮中间——在 TUI（Claude/Codex 的
选项列表、tmux copy-mode）里选一项要连点五六次，每次都得在横滑条里重新找到那个键。

改成右下角悬浮方向簇：

```
        ┌───┐
        │ ↑ │            · 键 48×48，十字排布
   ┌───┐├───┤┌───┐       · 长按 = 连发（首发 400ms，之后 90ms/次）
   │ ← ││ ⏎ ││ → │       · 中心 = Enter
   └───┘├───┤└───┘       · 长按中心 = 收起簇
        │ ↓ │            · 双指拖动 = 换到左手位（记进 preferences）
        └───┘
```

默认显示，可在溢出菜单关掉。位置记忆走 `preferences`（已有的偏好通道，跨设备同步）。

### 5.4 收益

以 360×640 安卓机、Chrome 可视高 560px、13px 字号（xterm 行高约 15px）为基准。
终端内边距同时从 6px 收到 4px：

| | 现状 | 新版 | 变化 |
|---|---|---|---|
| 无键盘 chrome | 168px | 107px | **−36%** |
| 无键盘终端画布 | 380px ≈ 25 行 | 445px ≈ 29 行 | **+17%** |
| 键盘弹起 chrome（键盘 300px） | 168px | 140px | −17% |
| 键盘弹起终端画布 | **80px ≈ 5 行** | **112px ≈ 7 行** | **+40%** |
| 会话切换可见条目 | 横滑 2–3 个 | sheet 一屏 8 个 | — |
| 方向键点击成本 | 横滑找键 → 点 | 常驻 + 长按连发 | — |

「键盘弹起 7 行」仍然不宽裕——这是 300px 键盘吃掉半屏的物理下限。真要再多，
只能靠 §5.3 的方向簇把「打字」换成「点键」，让键盘根本不必弹起。

---

## 6. 逐页塌陷规则

塌陷只有四个手法，每个页面从中选：**① 多栏→单栏 ② 表格→卡片 ③ 并排详情→二级页/sheet
④ 工具栏→溢出菜单**。

| 页面 | compact 下的问题 | 规则 |
|---|---|---|
| **项目列表** | 卡片网格 `minmax(270px,1fr)` 单列尚可；排序 Segmented + 新建按钮换行 | ① 卡片改行卡（高度 −30%）；④ 排序/筛选收进顶栏 sheet |
| **项目主页** | `.prj-tabs` 五 tab 溢出无提示；composer 的 pill 组换行成三行 | tab 条横滑 + 两侧渐隐；composer 折叠为「一行输入 + 展开更多」；worktree 分叉图左缩进 40→24 |
| **概览** | `.p6-stats` 六格 `flex:1 1 120px` 排成三行 | 走 14 稿 §5 的同一条信息序列：六格统计压成**一条状态概况**（不是 2×3 网格），「需要你」升为最多三张行动卡的单列队列，活跃项目单列、任务限 3 条，最近活动落到页尾。见 §13.2 |
| **会话平铺** | 行内动作按钮 hover 才显 | 动作常显 ✓（`html[data-pointer="coarse"]` 兜底已覆盖项目行/项目卡/分叉图/Git 段落四处）+ 长按出菜单（未做） |
| **文件** | 已走 `MobileSubPage` ✓ | 保留；`FileWorkspace`（多 tab 编辑器）不进 compact，compact 用 FileBrowser + 二级页 |
| **Git 面板** | ~~fixed 抽屉 `width: min(420px, 92vw)`，压在底栏上、不吃安全区~~ ✓ | ③ compact 走全屏二级页；提交树横向滚动区独立。**已实现**（`shell/AdaptivePanel`，两个调用点合一） |
| **Worktree** | ~~`Drawer width='100%'`，像页又像抽屉~~ ✓ | ③ 改二级页，吃物理返回键。**已实现**（返回键走 `shell/useBackDismiss`） |
| **蜂群** | `Swarm.tsx:378` 写死两列；拓扑图在 360px 上不可读 | ① 单列；拓扑图 compact 下换成**成员列表**（拓扑是桌面增强，不是必需） |
| **浏览器镜像** | 地址栏固定 150px；工具按钮溢出 | ④ 地址栏 `flex:1`，工具进 `⋯`；镜像画面按容器宽等比缩放 |
| **手机镜像** | 设备选择器固定 240px | ③ 设备选择改 sheet |
| **插件** | 已有 `isMobile` 内联分支 | ③ 统一改走 `MobileSubPage`，删掉内联分支 |
| **设置 / Env** | Form label 左对齐 + 输入框固定宽 120–220px | compact 下 `layout="vertical"` + 输入框 `width:100%`（一条全局 antd Form 覆盖，不逐个改） |
| **定时任务** | Table 固定列宽合计 490px，必横滚 | ② 换卡片列表：标题 + 表达式 + 下次运行 + 启停开关 |
| **主机监控** | `minmax(280px,1fr)` 自适应 ✓ | 保留 |
| **并行竞赛对比** | 三栏对比 `flex: 1 1 220px` | ① Segmented 切换单栏对比 |

---

## 7. 触控与手势

- **命中区 ≥ 44×44**（§3.4 用伪元素扩，不改视觉尺寸）；相邻可点元素间距 ≥ 8px。
- **主操作在下 1/3**：sheet 的确认按钮贴底、会话坞在底栏之上、方向簇在右下——都在拇指弧内。
- **hover-only 的信息全部补 coarse 兜底**：今天 `.cc-dl` `.cc-copy` `.tt-x` `.cc-msg-copy`
  已有 `@media (pointer: coarse)` 分支，但 `.prj-row .acts`（opacity .55→1）、
  `.prj-card .prj-acts`（opacity .25→1）、`.prj-fork .wt-acts`、`.cc-git-section-act` 没有。补齐。
- **手势表**：

| 手势 | 位置 | 动作 |
|---|---|---|
| 左边缘右滑 | 二级页 | 返回（并同步 history） |
| 下拉 | sheet | 关闭 |
| 上滑 | 会话坞 | 打开会话全屏 |
| 左右滑 | 会话坞 | 切上一个 / 下一个会话 |
| 长按 | 列表行 | 出上下文菜单（= 桌面右键） |
| 长按 | 方向簇按键 | 连发 |

- **禁止**：全局左右滑切页（和终端里的 tmux copy-mode 横向选择冲突）；
  双击缩放（viewport 已锁 `maximum-scale=1`）。

---

## 8. 安全区与软键盘

### 8.1 安全区

四个变量（§3.3）+ 一条规则：**所有 `position: fixed` 的层必须显式吃安全区**。今天违规的有
`FloatingFileDrawer`、`GitPanel:853`、`Projects:1483`、`VoiceInput:137`、`MobileSubPage`（只吃了 top）。

### 8.2 软键盘高度 `--kb`

`env(keyboard-inset-height)` 依赖 `virtualKeyboard.overlaysContent`，**iOS Safari 不支持**。
统一用 JS 回填一个 CSS 变量，两种来源取大值：

```ts
// layout.ts —— 键盘高度探测（VirtualKeyboard API 优先，visualViewport 兜底）
const vv = window.visualViewport
const update = () => {
  const byVV = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
  document.documentElement.style.setProperty('--kb', `${Math.round(byVV)}px`)
}
vv?.addEventListener('resize', update)
vv?.addEventListener('scroll', update)
```

CSS 侧统一：`padding-bottom: max(var(--kb), var(--safe-b))`
——键盘弹起时安全区被键盘盖住，两者取大而非相加。

### 8.3 会话页的特殊处理

xterm 的尺寸由 `FitAddon` + `ResizeObserver` 算。键盘弹起改变的是 `visualViewport.height`
而不是容器高度（因为 `overlays-content` 不压缩布局视口）——**必须在 `--kb` 变化后主动
触发一次 fit + 同步 PTY 尺寸**，否则 tmux 以为终端还是原来那么高，输出会画到键盘底下。
这条今天没有做，是「键盘弹起后 TUI 花屏」的一个未被归因的来源。

---

## 9. 明暗主题与横屏

- **明暗**：不新增任何颜色。compact 档只覆盖尺寸令牌，颜色全部继续走 `THEME_TOKENS`。
  唯一新增是底栏/坞/sheet 的背景要比页面高一级（`--bg-container` → `--bg-elevated`），
  两个主题都已有该 token。
- **横屏**（`compact-landscape`）：底栏 → 左轨（§4.4）；会话页顶栏压到 40px；
  方向簇自动移到右侧中部（横屏时拇指在屏幕两侧而非底部）。
- **旋转不丢状态**：选中项、滚动位置、终端连接都在 React state + URL 里，本次改造
  不得引入"按断点卸载重挂"的写法——`useLayout()` 只切样式与容器，不切组件树。
  （这是今天 `FilesPage` 的隐患：`isMobile` 分支返回完全不同的子树，旋转即重挂、编辑器状态全丢。）
- **返回不丢位置**：从项目列表进会话或二级页，再返回时**滚动位置与选中行必须还原**。
  14 §6.3 在桌面上的说法是「关掉终端后 Canvas 恢复原宽与原滚动位置」，手机上这条更要紧——
  桌面只是被压窄，手机是整页被盖住，回来找不到刚才那一行等于重新翻一遍。
  实现上二级页与会话覆盖层**不卸载下层页面**，只盖在它上面。
- **`prefers-reduced-motion`**：关掉 sheet 升起、二级页横切、卡片入场与方向簇的长按脉冲，
  一律降到 120ms 内的淡入淡出。**手势和功能一个不少**——减少动效不是减少能力。
  （14 §9.2 对分栏弹簧与背景光效有同一条。）
- **偏好只有一份**：方向簇位置/开关、密度、底栏顺序，与 14 §9.3 的 `navCollapsed / dockOpen /
  dockWidth / workspaceFocus / density` 合并成同一个 `WorkspacePreference`，走已有的 preferences
  通道。跨端同步时按当前档钳制：手机记的「方向簇左手位」不该影响桌面，桌面记的 Dock 宽度
  也不该被手机读出来。

---

## 10. 落地分期

| 期 | 内容 | 可见变化 |
|---|---|---|
| **M1 地基** | `layout.ts`（`useLayout` + `--kb` + `data-size`）、密度令牌、z 层令牌、安全区变量；替换 6 处散断点；`<MobileSubPage>` 补齐 + 新增 `<MobileSheet>` | 无（纯重构，视觉零差异） |
| **M2 外壳** | 底栏 4 格 + 更多 sheet；会话坞；二级页手势 + 物理返回键；antd Drawer/Modal 在 compact 下降级 | 导航改版 |
| **M3 会话页** | 顶栏合一、会话切换 sheet、溢出菜单 sheet、输入面板、方向簇、键盘变化触发 fit | 会话页改版 |
| **M4 逐页塌陷** | 按 §6 表逐页；触控区与 hover-only 兜底补齐 | 各页窄屏可用 |
| **M5 平板与横屏** | medium 档导航轨；桌面三栏下界抬到 1280；expanded 档的轨 + 覆盖式终端面板（§13.1） | iPad 可用 |

M1 是纯重构且零视觉变化，可以先合；M2/M3 建议同一个 PR（导航和会话页耦合在会话坞上）。

**一个 Shell，四档形态。** 14 §10.1 要建的 `frontend/src/shell/WorkspaceShell.tsx` 就是本稿
M2 的那层外壳，**不要两边各建一套**：`WorkspaceShell` 消费本稿的 `useLayout()`，
compact / medium 渲染底栏 + 会话坞，expanded 渲染导航轨 + 覆盖式终端面板（§13.1），
large 渲染 Navigation｜Canvas｜Dock。四档共用一棵组件树，只切样式与容器——
这正是 §9「不得按断点卸载重挂」的落地形式。业务页面一律不读 `window.innerWidth`、
不判断 `isMobile`，只声明自己要多宽。

因此 **M1/M2 与 14 的 Phase A 动的是同一层**，建议同一个 PR 或前后脚合，
否则必然出现两个 Shell 抢同一个根节点。

## 11. 验收

按 [web-ui-checklist](../../development/web-ui-checklist.md) 的 adb + CDP 跑法，
每档一个视口，**五个视口全过才算完**：

| 视口 | 档 | 必过断言 |
|---|---|---|
| 360×640 | compact | 无横向滚动；键盘弹起后终端 ≥ 7 行；发送按钮 `elementFromPoint` 命中自身 |
| 390×844 | compact | 同上 + 底栏与坞不被手势条遮挡 |
| 667×375 | compact-landscape | 左轨生效；内容区高度 ≥ 屏高 − 80 |
| 768×1024 | medium | **不出现终端坞**；无横向滚动（今天此项必挂，见 §1.3） |
| 1280×800 | large | 三栏形态与现状一致（回归） |

外加一条全档通用断言：`document.querySelectorAll('button,a,[role=button]')` 里
命中矩形短边 < 44 的元素数为 0（compact / medium 档）。

## 12. i18n 影响

新增文案集中在导航与会话页，均需同时提供 `zh-CN` / `en-US`：

| key | zh-CN | 用途 |
|---|---|---|
| `mobile.sessions` | 会话 | 会话坞标题 / 切换 sheet 标题 |
| `mobile.switchSession` | 切换会话 | 坞徽标 aria-label |
| `mobile.waitingCount` | {count} 个等待输入 | 坞上的等待提示 |
| `mobile.moreTitle` | 更多 | 更多 sheet 标题（`common.more` 已有，作按钮文案） |
| `mobile.groupAction` / `.groupPanel` / `.groupView` | 会话动作 / 面板 / 画面 | 溢出菜单三个分组标题 |
| `mobile.keys` | 快捷键 | 输入面板的快捷键条 aria-label |
| `mobile.dpad` | 方向键 | 方向簇开关 |
| `mobile.dpadSide` | 方向键位置 | 左手位/右手位切换 |
| `mobile.terminalPanel` | 终端面板 | expanded 档覆盖式面板标题 / aria-label |
| `mobile.closePanel` | 收起面板 | 覆盖面板关闭键与遮罩 aria-label |
| `nav.account` | 当前设备 | 「更多」sheet 的账户行（桌面账户菜单共用） |

其余全部复用现有 key（12 设计已把工具条文案 i18n 化，溢出菜单直接沿用）。

**和 14 共用的文案不加 `mobile.` 前缀**：概览的「查看全部 N 项」「当前没有待处理事项」、
会话标签的 `项目 · 会话` 拼装规则，四档是同一份 key，不要按端各写一套。

---

## 13. 与 14 桌面稿的接缝

[14-desktop-workspace](./14-desktop-workspace.md) 定义 `large ≥ 1280` 的桌面工作台，本稿定义
其余三档。两稿必须是**同一套壳的两端**，而不是两套设计：

| 谁定义什么 | 归属 |
|---|---|
| 四档断点、`useLayout()`、`data-size` / `data-orient` / `data-pointer` | **13**（本稿 §3） |
| 密度令牌 `--tap / --ctl-h / --pad-page / --gap / --fs-*`、z 层令牌、安全区与 `--kb` | **13**（§3.3 / §3.5 / §8） |
| `large` 档内的 Shell（Navigation / Command Center / Canvas / Dock / Focus）与桌面栅格 | **14** |
| 页面内的信息序列（先给要处理的事，再给状态） | 两稿共用，见 §13.2 |

14 只**新增** `--nav-w / --nav-rail / --canvas-min / --dock-* / --content-*` 这类壳层尺寸，
不重定义本稿已有的名字；`--page-pad-x/y` 是 `large` 档对 `--pad-page` 的档位覆盖。

### 13.1 expanded（905–1279）：够不到三栏的那一档

> 图纸：[expanded.html](./13-mobile-responsive/expanded.html)（A 面板收起 · B 面板展开）

原稿只在 M5 写了一句「768–1279 的两栏形态」，没有设计。补齐如下。

**为什么不并排。** 14 稿的分栏契约是 Canvas ≥ 560、Dock ≥ 480、rail 8，合计 1048；
加上 64px 导航轨要 **1112**。这一档最宽 1279，真并排也只能挤出 561–735px 的 Canvas——
正好是 14 稿 §2.2 要消灭的「页面被压成预览条」。所以这一档的结论是：

**导航升级成轨，终端改成覆盖式面板，1280 才是常驻分栏的下界。**

| 区 | 尺寸 | 行为 |
|---|---:|---|
| 导航轨 | 64 | 与 14 的 Activity Bar 同宽同图标；顶部搜索、底部会话坞徽标 + 账户 |
| Canvas | 剩余全部 | 终端开合**不改变** Canvas 布局，因此不会跳列 |
| 终端面板 | 480 | 从右侧覆盖，带遮罩；`⌘/Ctrl+J` 开合、`Esc` 收起、点遮罩收起 |
| 会话胶囊 | 50 高 | 面板收起时停在右下角，等价于手机上的会话坞 |

- 面板头一行写 `项目 · 会话`，与 14 的 Dock 标签同一串文案，点开是会话切换 sheet；
- sheet 在这一档从底部升起改为**居中卡片**（横屏下底部 sheet 会顶到屏幕边缘，拇指也够不着）；
- medium（600–904）继续用本稿 §4.4 的 56px 轨，终端仍走全屏二级页——不给覆盖面板，
  因为 480 的面板会盖掉 600px 屏的八成。

**这一档不需要新的栅格规则**：14 的项目卡按 Canvas 宽度做容器查询，轨 64 之后 Canvas 是
841–1215，自然落进「900–1319 → 2 列」。档位是环境，列数是结果。

### 13.2 一条信息序列，四档同构

概览页在四档里是同一条序列，差别只在列数与「最近活动」的位置：

```text
问候 + 状态概况  →  需要你（行动卡）  →  活跃项目  →  运行概况  →  最近活动
```

| 档 | 状态概况 | 需要你 | 活跃项目 | 最近活动 |
|---|---|---|---|---|
| compact | 一行三格数字 | 单列，最多 3 张，超出折「查看全部」 | 单列行卡 | 页尾 |
| medium / expanded | 一行状态条 | 2 列 | 2 列 | 页尾 |
| large | 一行状态条 | 3 列 | 1–3 列（看 Canvas） | Canvas ≥1180 时进右侧 320 侧轨 |

原 §6 表里的「2×3 统计网格」作废：**统计不该在首屏占三行**，这条与 14 §5.1 是同一个判断。

14 §5.2 的两条边界规则在手机上同样生效，而且更硬：

- **超过 3 项显示「查看全部 N 项」**。手机一屏只有 640–840px，行动卡再多两张，
  活跃项目就整个掉出首屏——那等于把「需要你」做成了另一个待办列表。
- **零事项时整层消失**，问候区显示安静的「当前没有待处理事项」。
  今天的实现是一个常驻琥珀横幅，没事的时候它仍然在喊——**空状态不是把内容清空，是把这层收掉**。

### 13.3 全局搜索在四档的落点

14 引入了 `⌘K` 命令面板，本稿要回答它在没有键盘的地方长什么样：

| 档 | 入口 | 形态 |
|---|---|---|
| compact | 页面头的搜索行；全局搜索是「更多」sheet 第一项 | 全屏搜索页（二级页） |
| medium / expanded | 导航轨顶部的放大镜 | 居中面板；接了外接键盘则 `⌘K` 同样可用 |
| large | Command Center 常驻搜索框 | 居中面板 |

三档共用一个结果列表组件（项目 / 会话 / 文件 / 命令四段），只换容器。

### 13.4 密度与指针：与档位正交

14 给用户一个「舒适 / 紧凑」偏好，写作 `data-density="cozy | compact"`。注意它与本稿的
`data-size="compact"`（窗口档）**同名不同义**，务必分开两个属性，不要合并：

- `data-size` 是环境事实（窗口有多宽），由 `useLayout()` 写；
- `data-density` 是用户偏好（信息要多密），由设置写；
- `data-pointer` 决定命中区：`coarse` 下强制 44，`fine` 下允许 32。

三者正交，因此「大屏 + 紧凑 + 触控」是合法组合：iPad 横屏接键盘就是这一种。
**`coarse` 指针下忽略 `compact` 密度对行高的压缩**——密度可以省留白，不能省命中区。

### 13.5 验收补一档

§11 的五个视口之外，再加一个 expanded 视口：

| 视口 | 档 | 必过断言 |
|---|---|---|
| 1024×768 | expanded | 导航轨生效；终端面板覆盖而非挤压（开合前后 Canvas 宽度不变）；`Esc` 收面板不退出页面 |
