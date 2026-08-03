# 14 · 桌面工作区优化设计

> 交互总览：[14-desktop-workspace/index.html](./14-desktop-workspace/index.html)
>
> 独立评审页：
> [D1 概览](./14-desktop-workspace/overview.html) ·
> [D2 项目工作台](./14-desktop-workspace/projects.html) ·
> [D3 终端分栏](./14-desktop-workspace/terminal-split.html) ·
> [D4 终端 Focus](./14-desktop-workspace/terminal-focus.html) ·
> [D5 超宽屏](./14-desktop-workspace/ultrawide.html) ·
> [D6 概览/项目/会话 三页桌面排布](./14-desktop-workspace/desktop-ia.html)
>
> D6 是后补的一稿：三页的**分工**在
> [13-mobile-responsive/ia.html](./13-mobile-responsive/ia.html) 里定完之后，
> 桌面仍在用手机那批组件——列表拉到 1174 宽，内容贴左、时间贴右，中间 570–700px 是空的。
> D6 定的是同一套信息在桌面怎么排：对齐成列、中间的宽度换成「位置」列（⎇ 分支 / 目录）、
> 破坏性动作随 hover。已实现。
>
> 状态：**设计草案，未实现**。本稿只定义 `large ≥ 1280` 的桌面形态；`< 1280`
> 的手机、平板与小笔电由 [13 · 移动端响应式布局重做](./13-mobile-responsive.md) 负责，
> 两稿的分工、expanded 档的覆盖式终端面板与四档同构的信息序列见 [13 §13](./13-mobile-responsive.md#13-与-14-桌面稿的接缝)。

---

## 1. 结论先行

桌面版不应该只是「手机内容旁边常驻一个终端」。它要成为一个稳定的工作台：

1. **导航负责定位**：侧栏只回答「我在哪」，低频系统操作收进账户菜单。
2. **顶栏负责调度**：采用 VS Code 式 40px Command Center，只放全局搜索、快捷创建与连接状态。
3. **页面负责决策**：概览先给出需要处理的事，再给项目状态；不平均分配视觉权重。
4. **终端负责执行**：终端是可停靠的同级工作区，不再把左页挤到固定 300/420px。
5. **大屏增加并行信息，不放大留白**：Canvas 宽到 1180 出活动侧轨、1320 项目卡升三列——
   看工作区实际拿到多少宽，不看窗口有多大。

这不是一次换皮。核心改动是把今天的「Sider｜页面｜终端」改成有明确尺寸契约的
**Workspace Shell**，让页面与执行区可以并排、聚焦和恢复。

---

## 2. 现状审计

### 2.1 桌面判断过早

当前 `App.tsx` 用 `screens.md`（768px）决定是否出现 Sider 和终端坞。只要宽度达到 768，
应用就当成桌面；但当前三栏的硬下限约为：

```text
Sider 208 + 页面 300/420 + 把手 18 + 终端 min 480 = 1006 / 1126px
```

这使 768–1125px 必然溢出。13 设计已把常驻三栏的下界抬到 1280，本稿沿用，不重复定义断点。

### 2.2 终端一打开，页面就退化成预览条

当前页宽由页面类型硬编码：

- Files：按窗口一半计算，限制在 520–900px；
- Sessions / Overview / Swarm / Settings / Phone：固定 420px；
- 其他页面：固定 300px；
- 终端始终 `minWidth: 480px`，拿走剩余空间。

这套规则的问题不是「有点窄」，而是**主次颠倒**：用户从项目页打开终端后，项目上下文被压成
300px，执行区反而拿走全部剩余宽度。不同页面还会在打开终端时突然跳宽，空间没有连续性。

### 2.3 分栏把手占 18px，却仍难理解

当前把手把整屏高度切成三等份：上半向左扩展，中间拖拽，下半向右收起，配竖排文字。
它同时承担「展开 / 最大化 / 调宽 / 折叠」四种语义：

- 视觉噪音持续存在；
- 鼠标需要先理解方向而不是直接拖；
- 操作对象实际是「页面宽」，用户心智却通常是「调整终端宽」；
- `dockMax` 时 Sider 一起消失，当前项目和导航上下文也被抹掉。

### 2.4 大屏没有真正被利用

概览根容器 `max-width: 1180px; margin: 0`，在 1920/2560 屏上：

- 内容贴左而不是居中；
- 右侧留下大片无语义空白；
- 最近活动被塞到页面底部，工作中最常扫的信息反而要滚动；
- 项目卡 `auto-fill minmax(340px, 1fr)` 没有与终端分栏状态协同，开关终端时反复跳列。

### 2.5 全局动作散在侧栏底部

关于、收起、全屏、退出与主要导航用同样的按钮形态竖排在底部。结果是：

- 导航项与账户/窗口动作没有层级；
- 退出登录长期暴露，占用高频位置；
- 侧栏收起后只剩一组无标签图标，靠 `title` 才能辨认；
- 没有全局搜索或命令入口，桌面增强里承诺的 `/` 搜索、`n` 新建、`g` 跳转没有可见承载。

---

## 3. 设计目标

| 目标 | 界面结果 |
|---|---|
| **上下文不丢** | 终端最大化时保留 64px Activity Bar；项目与会话合并进标签名 |
| **分栏可预测** | 页面最小 560px、终端最小 480px；不足时自动转单区聚焦 |
| **一眼看优先级** | 「需要你」成为概览第一视觉层，统计卡退为紧凑状态条 |
| **大屏有增量** | Canvas ≥1180 增加活动侧轨，≥1320 主卡三列（容器查询，不是媒体查询） |
| **键盘是一等输入** | `/` 搜索、`N` 新会话、`G P` 去项目、`⌘/Ctrl+J` 开关终端 |
| **密度可控** | 默认舒适密度；表格/会话列表可切紧凑密度并持久化 |
| **状态稳定** | 侧栏状态、终端宽度、聚焦模式和页面滚动位置刷新后恢复 |

不做：不改变现有路由与数据语义；不把所有页面重做成 dashboard；不引入另一套组件库；
不要求后端新增聚合 API，图纸中的数据均可由现有 `/projects`、`/sessions`、`/swarms`、
`/activity` 与探测接口得到。

---

## 4. Workspace Shell

### 4.1 五个结构区

```text
┌──────────────┬──────────────────────────────────────────────────────────────┐
│              │  Command Center：全局搜索 / 创建 / 系统状态                 │ 40
│ Navigation   ├────────────────────────────────┬───────┬─────────────────────┤
│ 224 / 64     │                                │  8px  │                     │
│              │  Canvas：页面工作区             │ split │  Dock：终端/对话    │
│              │                                │ rail  │                     │
│              │                                │       │                     │
└──────────────┴────────────────────────────────┴───────┴─────────────────────┘
```

| 区 | 展开 | 收起 | 规则 |
|---|---:|---:|---|
| Navigation | 224 | 64 | 展开时是 Primary Side Bar，收起后是 VS Code 式 Activity Bar |
| Command Center | 40 高 | — | 横跨 Canvas + Dock，不承载页面标题或项目路径 |
| Canvas | `min 560` | — | 页面主工作区 |
| Split rail | 8 宽 | 8 | 常态是一条分隔线 + 居中细抓手，hover/focus/拖拽时变蓝加长 |
| Dock | `clamp(480px, 42vw, 880px)` | 0 | 宽度按用户最后一次拖拽恢复 |

Command Center 横跨页面与终端，位置不因 Dock 开合跳动。页面标题留在 Canvas，
项目与会话上下文进入工作区标签，不再在顶栏和 Dock 上方各重复一遍。

### 4.2 三种空间状态

| 状态 | 触发 | 布局 |
|---|---|---|
| **Page** | 无打开会话或用户收起终端 | Navigation｜Canvas |
| **Split** | 打开会话且宽度足够 | Navigation｜Canvas｜Dock |
| **Focus** | 用户最大化终端/页面，或可用宽度不足 | Navigation rail｜当前工作区 |

`Split` 不是任何宽度都硬撑。约束计算：

```ts
const canSplit = workspaceWidth >= canvasMin + dockMin + splitRail
// 560 + 480 + 8 = 1048px（不含 Navigation）
```

加上 224px 侧栏是 1272px，落在 13 设计的 `large` 下界 1280 之内；也就是说 1280 一开窗，
Split 就必须成立。1280 以下不是「窄一点的分栏」而是**另一种形态**——导航收成 64 轨、
终端改成覆盖式面板，见 13 §13.1。用户把窗口收窄时，**先把 Navigation 收到 64px Activity Bar，再从 Split 平滑切 Focus**，
绝不制造横向滚动。

Dock 默认宽度 `clamp(480px, 42vw, 880px)` 还要再钳一次上界：

```ts
const dockMax = Math.min(880, workspaceWidth - splitRail - canvasMin)
```

否则 1280 展开侧栏时 `42vw = 538`，Canvas 只剩 510px，自己先破了 560 的契约。
**拖拽、双击复位、恢复偏好三条路径都走同一个钳制**，这是 §11 里「不横向溢出」的唯一保证。

### 4.3 分栏交互

8px rail 的命中区扩到左右各 6px，视觉与命中分开：

- 拖拽：直接改变 Dock 宽度，Canvas 吃剩余空间；
- 双击：恢复该档默认宽（1280→480 / 1600→42vw / ≥1920→`clamp(640, 40%, 880)`）；
- 收起 Dock 走 Command Center 的开关按钮或 `⌘/Ctrl+J`，rail 上不再放第三种语义的箭头；
- 方向键 16px 一档、`Home/End` 到最小/最大，rail 可 Tab 聚焦；
- `⌘/Ctrl+Shift+J`：Dock Focus；
- 拖到 Canvas `< 560px`：出现磁吸提示，松手后进入 Dock Focus；
- 宽度写入 `preferences.desktopDockWidth`，按窗口宽度做上限钳制。

不再使用全高竖排「扩展/收起」文字，不再按页面类型写死页宽。

### 4.4 Navigation

导航分三组：

```text
Roam
⌕ 搜索 / 跳转                                  ⌘K

工作区
  概览
  项目                                      3
  文件

工具
  浏览器
  手机
  插件

────────────────────────────────────────────
● P2P 已连接                           24 ms
[头像/主机图标] 当前设备                    ⋯
```

- 「设置 / 关于 / 主题 / 全屏 / 退出」进入底部账户菜单；
- `P2P` 正常时只显示小状态行，异常时才升为带说明的告警；
- 当前项使用 3px 左侧强调线 + 低饱和蓝底，不用整块高亮夺走内容注意力；
- 收起态保留 Logo、分组间距、状态点和账户入口，所有图标有 Tooltip；
- 导航 badge 只显示需要行动的数量，不显示普通总数。

### 4.5 Command Center

```text
                         [⌕ 搜索项目、会话和文件  ⌘K]  [+ 新建]  ● 在线
```

- 中：全局搜索，宽度 `min(480px, 42vw)`，对齐 VS Code Command Center；
- 右：快捷创建、连接状态；账户菜单留在 Activity Bar 底部；
- 页面标题、项目路径不进 Command Center，避免 Focus 时形成无意义的两层头部；
- 页面内筛选与排序留在页面自己的 sticky subheader；
- Command Center 在 Canvas 与 Dock 上方稳定，不因终端开合发生横向跳动。

---

## 5. 概览页 D1

### 5.1 信息顺序

```text
第一层  问候 + 当前工作状态 + 快捷创建
第二层  需要你（待输入 / 待收尾 / 待解锁）
第三层  活跃项目卡
第四层  运行概况
侧轨    最近活动（Canvas ≥1180 时出现）
```

当前实现先给一排 5 个等权统计，再给活跃项目。新稿把「数量」降成一条状态概况：

```text
● 4 个任务运行中    ◐ 2 个等待输入    ⚑ 3 项待收尾    ⬡ 1 个蜂群
```

数字是导航入口，但不再各自占一张卡。桌面首页最宝贵的首屏应该留给「下一步做什么」。

### 5.2 「需要你」改为行动队列

不再是一个大黄框里平铺五行，而是最多三张行动卡：

- 等待输入：显示项目、会话、最后输出摘要，主按钮「进入会话」；
- 待收尾：显示分支 / ahead-behind / 改动数，主按钮「去收尾」；
- 蜂群待解锁：显示成员与依赖，主按钮「查看看板」。

超过三项时显示「查看全部 N 项」，避免黄框随数据增长把项目卡推到首屏以下。
零事项时整层消失，问候区显示安静的「当前没有待处理事项」状态。

### 5.3 项目卡是稳定栅格

| 可用 Canvas 宽 | 列数 | 单卡最小宽 |
|---|---:|---:|
| 560–899 | 1 | 480 |
| 900–1319 | 2 | 400 |
| ≥1320 | 3 | 380 |

「可用 Canvas 宽」是容器查询看到的宽度，**单卡最小宽是扣掉 `--page-pad-x` 之后的内容宽**：
Canvas 560 减去两侧 28px 内边距只剩 504，所以 1 列档的下限是 480 而不是 520。

这里用 **Canvas 宽度容器查询**，不用 viewport 媒体查询。终端开合只影响 Canvas，卡片列数应由真实
可用宽度决定。卡片内部固定四段：项目头、状态摘要、任务前 3、蜂群/收尾提示；没有数据的段落不占位。

### 5.4 最近活动侧轨

Canvas 可用宽度 ≥1180 时，概览内部再分：

```text
行动 + 项目（minmax(0, 1fr)）｜ 最近活动（320px）
```

活动侧轨 sticky，按时间线展示 commit、收尾留痕、会话状态变化。窄于 1180 时回到底部双列，
保证 Split 模式下不出现「页面里套三栏」。

判定同样看 Canvas 而不是 viewport，于是**同一块屏会因为终端开合而有无侧轨**——这是对的：

| viewport | Dock | Canvas（侧栏 224） | 侧轨 | 项目卡 |
|---|---|---:|:--:|:--:|
| 1600 | 收起 | 1376 | 有 | 3 列 |
| 1600 | 开（672） | 696 | 无 | 1 列 |
| 1920 | 收起 | 1696 | 有 | 3 列 |
| 1920 | 开（768） | 920 | 无 | 2 列 |

---

## 6. 项目工作台 D2

项目页保留 08 设计的「项目是唯一主入口」，桌面只重排 chrome：

### 6.1 项目列表

- 顶部 sticky subheader：标题、搜索、筛选、排序、新建；
- 卡片改成 `320–360px` 的稳定列，不因为右侧终端开关跳成一条极窄列表；
- Pinned 与 Active 用同一栅格，通过 section header 分组；
- hover 才出现次要操作，键盘 focus 时同样可见；
- 双击项目或 `Enter` 进入，`Space` 快速预览，支持上下键移动选中。

### 6.2 项目详情

```text
项目头：repo / branch / 同步状态 / 主操作
Tabs：任务｜文件｜Git｜Worktree｜蜂群｜活动
内容：列表/图/编辑器
```

- 项目头 64px，Tabs 40px；二者 sticky；
- 原本散在卡片里的「新建会话 / 新建蜂群 / Fork / Race」集中到 `+ 开始` split button；
- 终端 Split 时，任务列表保留 `min 560px`，详情通过行内展开或终端标签表示；
- Files / Git 本身是高密度工作区，进入它们时 Canvas 可请求 `workspaceMode='wide'`，默认把 Dock 收到 36%。

### 6.3 页面与终端联动

从项目任务行打开会话后：

1. 该行保持选中，并显示细蓝边；
2. Dock 标签写成 `项目 · 会话`，分支放 Tooltip，不再额外增加 context strip；
3. 切终端 tab 时，若它属于另一个项目，只更新当前标签，**不强制切走当前页面**；
4. 标签右键菜单提供「打开所属项目」；
5. 关闭最后一个终端后 Canvas 恢复原宽与原滚动位置。

这避免「终端 tab 是跨页常驻的，却反过来劫持页面路由」。

---

## 7. 终端工作区 D3

### 7.1 结构

```text
Session tabs    ● roam · api-refactor   ● tests   +         38
Toolbar         对话/终端 | 文件 Git | tmux | 字号 | 更多    36
Terminal / Chat                                              flex
Input / prompt bar（需要时）                                  auto
```

12 设计已经统一了会话标签与工具条的线性语言，本稿不推翻它，只补桌面空间行为：

- 不增加独立 context strip；跨项目上下文由 `项目 · 会话` 标签与 Tooltip 承担；
- tabs 可拖拽排序，排序持久化；
- tab 宽 `min 132 / max 220`，名字中间省略，状态点不省略；
- tab 超过可用宽度进入水平滚动，两侧有渐隐与滚轮横移；
- toolbar 的危险/低频动作继续留在「更多」，不因屏幕宽就全部摊开。

### 7.2 Focus 模式

Dock Focus 时：

- Navigation 收到 64px Activity Bar，不消失；
- 40px Command Center 保留，搜索框继续居中；
- 终端铺满剩余空间；
- 工具条右侧的 `Focus` 原地变成「返回分栏」——不额外插一条只在 Focus 出现的横条；
- `Esc` 只退出 Focus，不关闭终端、不离开页面。

页面 Focus 对称实现，适合文件编辑器、Git diff、浏览器镜像等需要宽度的页面。

### 7.3 多终端布局

本轮只设计，不要求首期实现：

- 单 Dock 最多支持 2×2 pane；
- `⌘/Ctrl+\\` 纵分，`⌘/Ctrl+Shift+\\` 横分；
- 每个 pane 内仍可有 tabs，但同一会话只能挂在一个 pane；
- 小于 1440px 禁止创建第二列，避免每块终端小于 480px；
- layout 写入 URL 可选参数，普通分享链接默认只还原 tabs，不强制还原复杂 pane。

---

## 8. 大屏与密度

### 8.1 三档桌面

| Viewport | Shell | 概览（Dock 收起时） | 终端默认 |
|---|---|---|---|
| 1280–1599 | 默认 64px Activity Bar，用户可展开 224 | 2 列，无侧轨 | 480px |
| 1600–1919 | 展开 224 Sider | 3 列 + 320 活动轨 | 672px（42%） |
| ≥1920 | 展开 224 Sider | 3 列 + 320 活动轨 | `clamp(640, 40%, 880)` |

概览那一列写的是 **Dock 收起时**的形态；Dock 打开后一切以 Canvas 宽度重算，见 §5.4 的表。
1280 档默认收起 Sider，是因为展开侧栏后 Canvas 只剩 568px——够，但没有余量，
所以把展开留给用户显式选择，而不是默认给。

应用内容最大宽不是一个全局 `max-width`：

- 表单 / 设置：`max 920px`，居中；
- 概览：`max 1680px`，居中；
- 项目列表：`max 1600px`，居中；
- 文件 / Git / 浏览器 / 终端：不设 max，吃满工作区。

### 8.2 桌面令牌

```css
:root {
  --nav-w: 224px;
  --nav-rail: 64px;
  --topbar-h: 40px;
  --canvas-min: 560px;
  --dock-min: 480px;
  --dock-max: 880px;
  --split-rail: 8px;
  --split-hit: 20px;
  --activity-rail: 320px;
  --page-pad-x: clamp(16px, 2vw, 28px);
  --page-pad-y: 20px;
  --content-overview: 1680px;
  --content-form: 920px;
  --row-cozy: 42px;
  --row-compact: 34px;
}
```

**与 13 的令牌关系**：13 已经在 `:root` 定义了 `--tap / --ctl-h / --pad-page / --gap / --fs-*` 等
全站令牌，本稿只**新增桌面壳层的尺寸**，不重定义已有名字。`--page-pad-x/y` 是 `large` 档对
13 `--pad-page` 的覆盖，实现时写成同一个变量的档位覆盖，不要另起一套页面内边距。

图纸里的字号是压缩过的（元信息 9–10px），只为在一张图里塞下完整信息量；**实现按 13 的
`--fs-body: 14 / --fs-meta: 12` 来**，不要照抄图纸的字号。

### 8.3 密度不是缩放

用户可在账户菜单切「舒适 / 紧凑」：

- 只改变表格行、列表行、卡片内间距与 metadata gap；
- 不缩小正文、图标或焦点环；
- 按用户偏好持久化；
- 终端字号仍由终端自己控制，不受密度模式影响。

**属性名用 `data-density="cozy | compact"`，写在 `<html>` 上**。13 已经占用了
`html[data-size="compact"]` 表示「手机档窗口」，同名不同义会在 CSS 里撞车：
密度是用户偏好，窗口档是环境事实，两者可以同时出现（大屏 + 紧凑）。

---

## 9. 键盘、无障碍与状态

### 9.1 快捷键

| 快捷键 | 动作 |
|---|---|
| `⌘/Ctrl+K` 或 `/` | 全局搜索 / 命令面板 |
| `N` | 当前上下文新建：项目页新会话，概览页打开创建菜单 |
| `G` `O/P/F/B` | 概览 / 项目 / 文件 / 浏览器 |
| `⌘/Ctrl+J` | 开关终端 Dock |
| `⌘/Ctrl+Shift+J` | 终端 Focus / 返回 Split |
| `[` / `]` | 上一个 / 下一个终端 tab |
| `?` | 快捷键帮助 |

输入框、编辑器、终端聚焦时，字母单键快捷键禁用；带 `⌘/Ctrl` 的全局快捷键仍可用。

### 9.2 Focus 与可访问性

- rail 使用 `role="separator"`、`aria-orientation="vertical"`、`aria-valuenow`；
- 可用方向键每次调 16px，`Home/End` 到最小/最大；
- 所有 hover 才出现的动作在 `:focus-within` 同样出现；
- 选中不能只靠蓝色，辅以左侧线、字重或图标；
- 状态颜色满足 WCAG AA；低饱和背景上文字不用仅 11px；
- `prefers-reduced-motion` 下关闭卡片入场、分栏弹簧与背景光效。

### 9.3 持久化

```ts
type DesktopWorkspacePreference = {
  navCollapsed: boolean
  dockOpen: boolean
  dockWidth: number
  workspaceFocus: 'none' | 'page' | 'dock'
  density: 'comfortable' | 'compact'
}
```

布局偏好存本地并可通过现有 preferences 同步；路由只记录对分享有意义的终端 ids，
不记录像素宽度。恢复时先按当前 viewport 钳制，不能用旧大屏宽度挤爆新窗口。

---

## 10. 组件与落地分期

### 10.1 建议组件边界

```text
frontend/src/shell/
├── WorkspaceShell.tsx
├── Navigation.tsx
├── WorkspaceTopbar.tsx
├── SplitWorkspace.tsx
├── TerminalDock.tsx
├── CommandPalette.tsx
└── useWorkspaceLayout.ts

frontend/src/components/
├── PageHeader.tsx
├── SectionHeader.tsx
├── AttentionQueue.tsx
└── StatusSummary.tsx
```

`WorkspaceShell` 是唯一决定 `Page / Split / Focus` 的组件；业务页面只声明能力：

```ts
useWorkspacePage({
  title: t('nav.projects'),
  contentWidth: 'wide',
  preferredDockRatio: 0.40,
})
```

业务页面不得直接读 `window.innerWidth`、不得修改 Dock DOM、不得按当前 tab 写死 page width。

### 10.2 分期

**Phase A · Shell（必须先做）**

- 接入 13 的 `useLayout()`，`large` 才允许常驻三栏；
- 抽出 Navigation / Topbar / SplitWorkspace；
- 8px rail + Page/Split/Focus + 宽度持久化；
- 删除 `defaultDockWidth` 按页面硬编码和全高 18px 三段把手。

**Phase B · 概览**

- 状态卡压成 summary；
- Attention Queue 三卡；
- 容器查询项目栅格（900 / 1320 两个阈值）；
- Canvas ≥1180 的活动侧轨。

**Phase C · 项目与终端**

- 项目 sticky header / tabs；
- 项目·会话标签与选中联动；
- Dock Focus、快捷键与命令面板；
- 页面滚动位置恢复。

**Phase D · 全站收口**

- 每页声明 content width；
- 设置/插件表单居中，文件/Git/镜像吃满；
- 舒适/紧凑密度；
- 中英文、暗亮主题、1280/1440/1600/1920 截图回归。

---

## 11. 验收清单

- 1279px 不出现常驻三栏，1280px 不横向溢出；
- Split 下 Canvas ≥560px、Dock ≥480px，达不到自动进入 Focus；
- Dock 最大化不隐藏 Navigation，上下文始终可找回；
- 拖拽 rail、双击复位、键盘调宽均可用；
- 打开/关闭终端后，页面选中项和滚动位置不丢；
- 1600/1920 大屏没有无语义大片空白，概览项目卡不超过三列；
- 所有新增产品文案进入 `zh-CN` 与 `en-US`；
- 亮色主题下链接/警示/蜂群强调色重新取值满足 AA，不直接沿用暗色主题的高亮色；
- 暗色、亮色、舒适、紧凑四种组合基本可用；
- `prefers-reduced-motion`、200% 缩放、仅键盘操作通过；
- `npm run i18n:check`、`npm run typecheck`、`npm run build` 通过。
