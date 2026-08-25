# ttmux Web 控制台 — 设计文档

> 给 ttmux 加一个 **响应式 Web 控制台**，在 **手机 / 平板 / 电脑** 三端统一适配，
> 让你能远程 **查看**（sessions / groups / agents / 日志 / 终端）并 **操控**
> （spawn、send、kill、env、批准 agent）。
>
> 状态：设计草案 v0.3 — 未实现。

## 文档导航

| # | 文档 | 内容 |
|---|---|---|
| 1 | [01-overview.md](./01-overview.md) | **总体设计** — 背景、目标、三端适配策略、技术选型、系统架构 |
| 2 | [02-backend.md](./02-backend.md) | **后端设计** — Go 分层、CLI 薄封装、REST API、实时通道 |
| 3 | [03-auth-security.md](./03-auth-security.md) | **认证与安全** — 登录流程、Token、防爆破/CSRF、远程暴露策略 |
| 4 | [04-frontend.md](./04-frontend.md) | **前端设计** — 前端架构、响应式布局系统、设计语言、状态数据流 |
| 5 | [05-pages.md](./05-pages.md) | **逐页面设计** — 10 个页面的三端布局与线框 |
| 6 | [06-roadmap.md](./06-roadmap.md) | **落地计划** — 里程碑、开放问题 |
| 7 | [07-worktree.md](./07-worktree.md) | **Worktree 管理** — 命名创建、管理抽屉、对比 base、合并收尾、并行竞赛 |
| 8 | [08-project.md](./08-project.md) | **项目概念** — 仓库即项目、composer 开干、任务=会话∪孤儿 worktree、待收尾一等 |
| 9 | [09-swarm-in-project.md](./09-swarm-in-project.md) | **蜂群×项目创建动线** — 表单产出上下文不产出结构、开场白注入班子建议与 worktree 约定 |
| 10 | [10-merge-detect-finish.md](./10-merge-detect-finish.md) | **已合入检测与收尾** — 周期 fetch 远端主干、ancestry/cherry 双信号识别 merge/squash、「待收尾」拆成 未合并·待决策 / 已合入·待清理 |
| 11 | [11-git-panel.md](./11-git-panel.md) | **Git 面板重做** — 提交树 / 分支页 / worktree 分叉图 |
| 12 | [12-session-navbar.md](./12-session-navbar.md) | **会话导航栏重做** — 标签条 / 工具条统一为一套线性语言 |
| 13 | [13-mobile-responsive.md](./13-mobile-responsive.md) | **移动端响应式布局重做** — 四档断点与密度令牌、底栏＋会话坞、会话页 chrome 压缩、逐页塌陷规则（**取代 04 §2 的三档方案**） |
| 14 | [14-desktop-workspace.md](./14-desktop-workspace.md) | **桌面工作区优化** — Workspace Shell、Page / Split / Focus、概览优先级、超宽屏与键盘调度 |
| 15 | [15-chat-render/](./15-chat-render/README.md) | **Claude / Codex 对话渲染重做** — 四层架构与数据契约、工具三档密度、LCS 行对齐 diff、适配层收敛 provider 差异、会话状态条与多问题选择框 |
| 16 | [16-tool-run-density/](./16-tool-run-density/index.html) | **连续工具调用的篇幅压缩** — 相邻工具并成「运行组」、跑完即折成一行、失败行永不折叠、同文件连续 Edit 合并成一张 diff；一套 DOM 两端适配（手机 5 条命令 430px → 60px） |
| 17 | [17-browser-chrome/](./17-browser-chrome/index.html) | **镜像两页页头重做** — 一个 omnibox 当主角、主行只留四个可点目标、标签换「数字 + 抽屉」、Roam 专有状态收成可点芯片条；桌面标签条/分区/三档收纳/键盘，手机镜像页共用同一套语法（devbox + 应用启动器 + 按键条）|
| 18 | [18-overview-projects-merge/](./18-overview-projects-merge/index.html) | **概览 × 项目 合并成一个工作台** — 两页画的是同一批项目卡、拉的是同一条 `/projects`；概览独有的只有问候条、「需要你」行动队列、最近活动轨。`#/projects` 成为唯一首页（`#/overview` 重定向），排序加「需要你」档并置默认，项目卡取两版并集；顺带删掉概览那套「每 6s 对 ≤14 个会话各发 3 条请求」的前端轮询 |

| 19 | [19-metadata-durability/](./19-metadata-durability/index.html) | **元数据持久化与重启恢复** — 两篇：[问题](./19-metadata-durability/index.html)（ttmux 层与 Roam 层各自把什么存在哪、为什么一重启就归零：普通会话在盘上不留痕迹、`sessions` 拿 tmux `$N` 当主键被整表清空、发现型项目按「此刻没会话」退场、`$N` 跨重启复用串档；附本机实测的丢失/捞回清单）· [改进方向](./19-metadata-durability/design.html)（目标架构与数据分层设计：台账进 `meta.db`、配置留 JSON、大对象留盘、tmux 只回答「现在谁活着」；表设计与 ER 图、会话软删存历史、项目退场改判「从来没有过会话」、重开与对话回接、分期与 M1 落地记录）|

| 20 | [20-status-bar/](./20-status-bar/index.html) | **底部状态条（VS Code 式 · 注册制）** — 壳最底下一条 24px 常驻细条，**左半 13 格是工作区**（机器/后台/分支+同步/待办/蜂群/主机负载/链路，换页不变）、**右半 12 格是当前上下文**（文件页给行列·缩进·编码·换行·语言，会话页给 Agent·上下文占用·pane·前台命令，镜像页给设备），同时只出现十来格。**条上两类格并存**：**系统格**（宿主五个 provider，随二进制走、占固定槽位、第一帧就有值、卸不掉）与**插件格**（新增 `contributes.statusItems` 贡献点注册，只能落 left-tail/right-head 两段、每插件 2 格封顶、第三方默认关）；两者共用同一套渲染器与阈值判定，条上看不出区别，**设置页按来源分组、标出来自哪个插件**。**主机那六格（CPU·内存·磁盘·温度·GPU·网络）由已有的 `roam.host-monitor` builtin 插件注册**，采集逻辑一行不动、零新接口。贡献点是声明式的（插件给数据不给 DOM，渲染器只有 text/gauge/dot/progress，severity 由宿主按声明阈值判——不然每个插件都会把自己染红）。逐项对照 VS Code 抄什么不抄什么：远程指示器那块实心色只留给「不是本机」的机器格，整条蓝底不抄；「问题」格换成待确认/待收尾/插件发现。平静时整条一种灰，越阈值那格上色并「钉住」不参与折叠；CPU 需连续 60s 越线才算数。窄窗分四档丢、右半整组早于左半消失；手机不常驻，只在 danger 时插一条 28px 告警 |

> 13 与 14 是同一套壳的两端：**断点、密度与全局令牌以 13 为准，`large ≥ 1280` 之内的桌面形态以 14 为准**。

## 实现状态

已落地并可运行（前后端分离）：
- 前端 [`../../../frontend/`](../../../frontend/) — React + Vite + Antd 三端响应式 SPA，含 xterm.js 终端。
- 后端 [`../../../backend/`](../../../backend/README.md) — Go + Gin，按包分层（cmd/server/api/ttmux/pty/stream/auth）。
- 仓库根 `./start.sh --dev` 一键：构建前端 → 编译后端 → 启动（后端从磁盘代理 `frontend/dist`）。

详见 [06-roadmap](./06-roadmap.md)。

## 一句话方案

Web 后端做成 **ttmux CLI 的薄封装**：读 = 调 `ttmux <cmd> --json` 解析，写 = 调对应子命令。
不重写任何编排逻辑，保证 Web 与 CLI 行为永远一致。前端是 **一套响应式 SPA**，
靠单个 `AppShell` 组件按断点切换三端布局，而非做三个独立 App。

## 核心原则

- **薄封装**：后端不重实现编排逻辑，全部转发给 ttmux CLI。
- **一套代码三端适配**：移动优先 + 渐进增强，宽屏把"详情页"从覆盖层升级为并排栏。
- **认证不可妥协**：Web 等于把 shell 执行能力搬上网，强制登录 + 不裸暴露公网。
