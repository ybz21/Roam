# Web UI 验收清单（Chrome CLI / 手机 ADB）

前端改动**不能只靠肉眼和 typecheck 收工**——Roam 的坑大多在真实浏览器里才现形：层叠上下文、
触摸事件命中、软键盘、tmux attach 尺寸。本清单给出一套可复现的跑法：桌面走 `chrome` CLI 或
CDP，手机走 adb + 手机 Chrome 的 DevTools（同一套 CDP 脚本两端复用）。

> 已经踩过的真事：xterm 的透明画布层（`.xterm-link-layer`）带正 z-index，会「逃」出 `position:
> relative` 的终端容器，压在 Claude/Codex 对话面板之上——**看得见、点不着**，表现为「聊天区滑
> 不动、发送/停止按不动」。这类问题只有做**命中测试**（`document.elementFromPoint`）或真手势才
> 能发现，截图和 typecheck 一律看不出来。

## 0. 接上被测端

### 手机（推荐，触摸相关的问题只在这儿现形）

```bash
adb devices -l                                   # 认到设备
adb shell svc power stayon true                  # 别让屏灭：Chrome 进后台会被冻，CDP 直接失联
adb shell am start -a android.intent.action.VIEW -d "https://<LAN_IP>:13579/" com.android.chrome
adb forward tcp:9555 localabstract:chrome_devtools_remote
curl -s http://127.0.0.1:9555/json/list          # 看到目标页 = 通了
```

- 自签证书拦截页：CDP 里点 `#details-button` → `#proceed-link`。
- 登录页只有口令框，**两步验证码框是提交口令后才出现的**，脚本要分两步填。
- **改完前端一定要硬刷**：`Page.navigate` 到 `#/xxx` 是同文档导航，不重新加载文档，页面会一直跑
  老包（页面上那条「🔄 有新版本 / 刷新」横幅就是提示）。脚本里跟一句
  `Page.reload({ ignoreCache: true })`，否则你验的是上一版代码——这一条踩过两次。
- 真手势用 `Input.synthesizeScrollGesture`（走合成器，等价手指滑动）；点按用
  `Input.dispatchMouseEvent`。**不要**用 `el.click()` 做「点得到吗」的验收——它绕过命中测试，
  被透明层盖住也照样触发。

### 桌面

```bash
chrome goto https://127.0.0.1:13579/ && chrome eval "document.title"
```

`chrome` CLI 接的是 9222 上那台全局 Chrome（与 Web 镜像同一台）。若 `navigate` 超时且日志有
`Failed global descriptor lookup`，说明这台机器的 Chrome 网络进程起不来（代理/沙箱环境问题），
先修环境或直接改用手机端跑。

## 1. 通用断言姿势

| 要验的东西 | 怎么验（别只看截图） |
|---|---|
| 元素是否**真的可点** | `document.elementFromPoint(x, y)` 命中的是不是它自己 |
| 区域是否**真的可滚** | 记 `scrollTop` → `Input.synthesizeScrollGesture` → 再读 `scrollTop` |
| 覆盖层是否吃事件 | `getComputedStyle(el).pointerEvents`；window 上挂 capture 监听看 `e.target` |
| 弹层是否被误关 | 触发后等 1.5s 再查节点是否还在 |
| 布局是否溢出 | `document.documentElement.scrollWidth <= innerWidth` |

## 1.5 「花屏」先分类，再动手

终端花屏有两类，长得一样但修法相反。**别靠截图猜**，用 `__roamTermDiag(true)` 把 xterm 的可视区
缓冲 dump 出来，跟 `tmux capture-pane -p -t <会话>` 一比：

| 缓冲 vs tmux | 说明 | 修法 |
|---|---|---|
| **一致**，但屏幕看着不对 | 本地画错了：WebGL 纹理图集/画布坏了（切后台被回收 GPU、dpr 变化） | 重建渲染器（`rebuildRenderer`）；实在不行整机重建（工具条「重连」） |
| **不一致** | 内容本身就是坏的：socket 半死、tmux 没重画、TUI 重排留垃圾 | 整链路重同步：关 socket 重连（新 tmux 客户端＝整屏重画）+ 抖尺寸双 SIGWINCH（工具条「重绘」） |

对应的自愈已内置在 `Terminal.tsx`：回前台离开 >1.5s 重建渲染器，>10s 再叠一层关 socket 重连 +
强制抖动。验证方法：记下 `pgrep -f 'tmux attach -t <会话>'` 的 PID，切后台 30s 再回来，PID 变了
就说明重新 attach 过。

## 2. 清单

### A. 终端页（手机 + 桌面）

- [ ] 会话列表点进去能开终端，`.xterm` 出现且 `已连接`。
- [ ] 终端能上下滑看历史（`Input.synthesizeScrollGesture` 后画面变化）。
- [ ] 底部输入条打字 + 「Enter」能送进 PTY；快捷键丝带横向可滑。
- [ ] 工具条各钮命中测试通过（尤其被浮层覆盖的右侧分组）。
- [ ] 单击终端移光标只发 ←→（备用屏），不误发 ↑↓。

### B. Claude / Codex 专业渲染模式（重灾区）

- [ ] 切进对话页：`textarea[placeholder]` 存在，历史消息渲染出来。
- [ ] **聊天区能滑动看历史**：`scrollTop` 真的变小（不是只有滚动条能拖）。
- [ ] **命中测试**：聊天区中心、发送钮中心、停止钮中心 `elementFromPoint` 都不能是
      `CANVAS.xterm-*`——命中终端画布就是层叠上下文又漏了。
- [ ] 「发送」能把消息送进会话；生成中「停止」能打断。
- [ ] 悬浮麦克风不压住发送/停止/选择框（量 rect 交集）。
- [ ] 工具条「语音输入」开关能同时管住终端页与对话页的麦克风。
- [ ] 「回到底部 ↓」在上滚后出现、点了回底。
- [ ] 「切回终端」回到终端且连接不断。

### C. 提问弹框（PromptDialog）

- [ ] 会话里出现 TUI 选择框时弹框自动弹出。**手机上尤其要验**：手机 attach 后窗格只剩 40 多列，
      选项被折成五六行，`detectPrompt` 的分组一旦按行距卡死就一条都认不出来（见
      `src/prompt.test.ts` 的窄屏用例）。
- [ ] 测这一条前先确认偏好里「弹框提醒」是开的（`promptPopupOff=false`），否则弹框本来就不该出现；
      脚本里临时改完记得还原。
- [ ] **点终端空白处：弹框不消失**，且这一下点击落到终端（命中测试）。
- [ ] 点选项能把按键注入会话；点右上角 × 只关这一条。
- [ ] `.ant-modal-wrap` 的 `pointer-events` 必须是 `none`（否则整页点击被吃）。

### D. 手机专属

- [ ] 底部导航栏不挡住会话覆盖层（覆盖层 z-index 高于 nav）。
- [ ] 软键盘弹起后输入框与发送钮仍可达（`interactive-widget=overlays-content`，键盘只盖不顶）。
- [ ] 页面不出现横向滚动（`scrollWidth <= innerWidth`）。
- [ ] 竖屏/横屏切换后终端重新 fit，不留花屏。

## 3. 脚本骨架

`scripts/` 下没有常驻脚本（测试环境一次性），临时脚本写法见下——两端只差 CDP 端口与目标页选择：

```js
// connect(port, targetId) → { eval, clickAt, shot, send }
const cdp = await connect(9555, targetId)               // 手机；桌面用 9222
const box = () => cdp.eval(`(() => { const d = [...document.querySelectorAll('div')]
  .filter((x) => /auto|scroll/.test(getComputedStyle(x).overflowY) && x.scrollHeight > x.clientHeight + 40)
  .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  const r = d.getBoundingClientRect()
  return JSON.stringify({ top: d.scrollTop, x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)

const b0 = JSON.parse(await box())
await cdp.send('Input.synthesizeScrollGesture', { x: b0.x, y: b0.y, yDistance: 300, gestureSourceType: 'touch', speed: 800 })
const b1 = JSON.parse(await box())
console.assert(b1.top < b0.top, '聊天区滑不动')
```

## 4. 造测试数据（别拿用户的会话做实验）

```bash
# 独立会话 + 真实转录：起一个 claude（不发消息=不花钱），再把一份历史 jsonl 拷进它的 project 目录
tmux new-session -d -s roam-uitest -x 200 -y 45 -c /tmp/uitest 'claude'
cp <某个较小的>.jsonl ~/.claude/projects/-tmp-uitest/aaaa1111-....jsonl
```

- 转录别拿几十 MB 的大文件，前端一次性拉全量会把手机拖死（那是测试数据问题，不是 bug）。
- 要真选择框：在测试会话里发 `/model`，那就是一个标准的 Claude Code 选择框。
- 收尾：`tmux kill-session -t roam-uitest`，删掉拷进去的 jsonl。
