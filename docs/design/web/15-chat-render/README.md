# 15 · Claude / Codex 对话渲染重做

> 交互总览（含桌面 / 手机成品图）：[index.html](./index.html)
>
> 状态：**设计已定稿，实现进行中**（分支 `feat/chat-tool-render`）。
> 本稿是技术拆解，讲「怎么切、切成哪些模块、每块的契约是什么」；
> 视觉形态、密度档位、色条规则见上面那份 HTML 稿，本稿不重复。
>
> 架构与 LCS 差异算法参考 **CloudCLI UI**（<https://github.com/siteboon/claudecodeui>，
> 同为 AGPL-3.0）。按其 LICENSE 第 7 条附加条款，署名同时补在 `README.md` 与 `NOTICE`。

---

## 1. 结论先行

对话页现在的问题不是「不好看」，是**没有分层**：一个 400 行的 `ClaudeMessage.tsx` 里同时压着
provider 的工具词汇、入参形状差异、成败判定、折叠策略和 JSX，Codex 侧再复制一份。
后果是三件事同时做不到——加工具要改两处、加 agent 要改两份、任何一段逻辑都没法单测。

这一稿定的是四层，以及**层与层之间的数据契约**：

1. **L0 转录解析（Go，已有）**——只认「文件在哪、JSONL 什么格式」，输出 provider 中立的块流。
2. **L1 拉取与配对（`useTranscript`）**——增量 offset、结果挂回调用。认块流，不认工具。
3. **L2 适配层（新增 `chat/adapters/`）**——**唯一 per-provider 的一层**。工具词汇 → 语义调用，
   入参归一，成败判定，状态解析。全是纯函数。
4. **L3 呈现（`chat/tool-view` + `chat/tool-parts`）**——只认语义，永远不知道 Claude / Codex 存在。

外加两条**旁路**，它们不走转录：

- **交互层**（`prompt.tsx` + `chat/ask.tsx`）——权限确认与多问题选择，数据来自终端实时画面。
- **动作层**（`chat/actions.tsx`）——「打开这个文件」这类对外意图。

判断一段代码放哪层，只问一句：**它需要知道对面是 Claude 还是 Codex 吗？**
需要就只能在 L2，不需要就不许出现在 L2 之上。

---

## 2. 现状审计

### 2.1 两份近乎重复的实现

`chat/ClaudeMessage.tsx`（160 行）与 `chat/CodexMessage.tsx`（89 行）结构几乎一致：
同样的气泡、同样的 `m.blocks.map`、同样的 thinking 折叠，只有强调色和工具分支不同。
同一个「思考」在两页长得不一样，改一处必然漏一处。

### 2.2 Edit 的 diff 是假的

```tsx
// ClaudeMessage.tsx:76
const minus = (o?.old_string || '').split('\n').map((l) => '- ' + l).join('\n')
const plus  = (o?.new_string || '').split('\n').map((l) => '+ ' + l).join('\n')
```

旧文本整块打 `-`、新文本整块打 `+`。改一个字符，半屏红绿。

### 2.3 每个工具一张同样的卡

`ToolUse`（`ClaudeMessage.tsx:107`）不区分工具，一律「描边卡 + 折叠头 + 输出折叠条」。
连续十几次 `Read` 把正文淹掉，而且**成功的噪音和失败的信号同权**——最该被看见的报错不显眼。

### 2.4 Codex 三处解析错误

| 现象 | 根因 |
|---|---|
| `shell` 显示成 `bash,-lc,npm test` | `extractCmd` 拿到 `command: ["bash","-lc","npm test"]` 直接 `String()` |
| `apply_patch` 画出一坨 JSON | `function_call` 的载荷是 `{"input":"*** Begin Patch…"}`，没解包 |
| `update_plan` 掉进兜底 | 注册表里没有这个键 |

### 2.5 MCP 调用永远转圈（新渲染才会暴露）

`backend/api/codex.go` 处理 `mcp_tool_call_end` 时，一条消息里同时塞了 `tool_use` 和
`tool_result`，但**两个都没有 id**；而 `pairToolResults`（`useTranscript.ts:51`）只按 id 配对。
旧渲染里两者各画各的看不出问题，新渲染有「运行中」状态之后，MCP 调用会永远转圈。

### 2.6 Codex 的失败判定基于退出码正则

```go
// backend/api/codex.go:142
var codexExitRe = regexp.MustCompile(`(?i)(?:exit code|exited with code):?\s*(\d+)`)
```

Codex 协议里没有 `is_error`，只能从输出里抠退出码。于是 `git diff --exit-code`、
`grep` 没匹配这类**正常的非零退出**会被判成错误。

### 2.7 两处后端写死中文，进了 API 响应

`backend/api/claude.go:319` 的 `"（思考内容已加密，无法展示）"` 与 `:251` 的 `"[图片]"`，
违反 [i18n 规范](../../../development/i18n.md)「会被前端直接展示的后端 API 消息」条款。

---

## 3. 分层与依赖方向

```text
┌─ L0  backend/api/{claude,codex}.go ────────────────────────────┐
│     认文件格式与位置；增量按物理行 offset                        │
│     产出 cBlock 流（Anthropic 块形状，provider 中立）            │
└───────────────────────────┬────────────────────────────────────┘
                            ↓ HTTP
┌─ L1  chat/useTranscript.ts ────────────────────────────────────┐
│     轮询、增量合并、文件切换重置、结果配对（id + 相邻兜底）        │
│     产出 Msg[] + Record<toolUseId, Block>                       │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌─ L2  chat/adapters/{claude,codex}.ts ──────────  ★ 唯一 per-provider
│     toolCall(block)            → ToolCall                       │
│     outcome(call, result)      → ToolOutcome                    │
│     cleanUserText(text)        → UserText                       │
│     status(raw)                → AgentStatus                    │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌─ L3  chat/tool-view.tsx · chat/Message.tsx ────────────────────┐
│     语义 → 三档密度；正文/工具分段                                │
│     └─ chat/tool-parts.tsx  纯显示件，连「工具」都不认识           │
└────────────────────────────────────────────────────────────────┘

旁路（不走转录，来自终端实时画面 capture）
┌─ prompt.tsx · chat/ask.tsx ────────────────────────────────────┐
│     权限确认 / 多问题选择：结构从转录取，焦点从画面取              │
│     动作 → POST /sessions/:name/keys 注入按键                    │
└────────────────────────────────────────────────────────────────┘
```

**依赖只许向下。** `tool-parts.tsx` 不 import `adapters/`；`adapters/` 不 import 任何 `.tsx`。
这条规则用 ESLint 的 `no-restricted-imports` 钉死，不靠自觉。

---

## 4. 数据契约

契约是这次重做的核心产物。四个类型定义在 `chat/contract.ts`，L2 生产、L3 消费。

### 4.1 ToolCall — 语义调用

```ts
export type ToolKind =
  | 'shell' | 'read' | 'edit' | 'patch' | 'search' | 'plan'
  | 'agent' | 'ask' | 'fetch' | 'mcp' | 'image' | 'stdin' | 'unknown'

export type ToolCall = { id?: string; name: string } & (
  | { kind: 'shell';   command: string; description?: string; cwd?: string }
  | { kind: 'read';    path: string; line?: number }
  | { kind: 'edit';    path: string; before: string; after: string; mode: 'edit' | 'create' }
  | { kind: 'patch';   files: PatchFile[] }
  | { kind: 'search';  query: string; scope?: string }
  | { kind: 'plan';    items: TodoItem[]; note?: string }
  | { kind: 'agent';   title: string; role?: string; prompt: string }
  | { kind: 'ask';     questions: Question[] }
  | { kind: 'fetch';   target: string }
  | { kind: 'mcp';     server: string; tool: string; args: string }
  | { kind: 'image';   path: string }
  | { kind: 'stdin';   text: string }
  | { kind: 'unknown'; args: string }
)
```

- `kind` 是**闭集**，决定渲染档位。加工具改这里，**加 agent 不改这里**。
- `name` 保留 provider 原名，只用于显示（`Read` / `read_file` 各显其名）。
- `unknown` 是兜底，`toolCall()` 永不返回 null——未知工具也要能画。

### 4.2 ToolOutcome — 归一结果

```ts
export type ToolOutcome = {
  status: 'running' | 'ok' | 'error' | 'denied' | 'waiting'
  text: string
  files?: string[]      // Grep/Glob 抽出的命中列表
  exitCode?: number     // Codex 有，Claude 没有
}
```

五个状态各自的判据：

| 状态 | 判据 | 呈现 |
|---|---|---|
| `running` | 没有配对结果，且不在待确认中 | 转圈 |
| `waiting` | 没有配对结果，且交互层报「有待确认」 | 黄色「待确认」 |
| `ok` | 有结果且非错 | 无徽标 |
| `denied` | 结果报错且文本命中 `DENIED` 正则 | 黄色「已拒绝」 |
| `error` | 其余报错 | 红条 |

`denied` 与 `error` 必须分开：人按了拒绝是一次选择，不该染成故障红。

### 4.3 AgentStatus — 会话状态

```ts
export type AgentStatus = {
  mode?:    { id: string; label: string; tone: Tone }
  model?:   string
  effort?:  string
  context?: { used: number; window: number }
  quota?:   { percent: number; resetsAt?: number }
}
```

渲染层只判断「有没有 `quota`」，**不判断「是不是 Codex」**。

### 4.4 Adapter — provider 契约

```ts
export interface Adapter {
  id: string
  accent: string
  thinkingLabel(): string
  transcriptPath: string
  placeholder(): string

  toolCall(block: Block): ToolCall
  outcome(call: ToolCall, result?: Block, waiting?: boolean): ToolOutcome
  cleanUserText(text: string): UserText
  status(raw: RawStatus): AgentStatus
}
```

前四项是配置，后四项是**纯函数**——这是能单测的前提。

---

## 5. 模块清单

| 模块 | 层 | 职责 | 状态 |
|---|---|---|---|
| `backend/api/{claude,codex}.go` | L0 | 块流 + 新增 status 透出 | 改 |
| `chat/useTranscript.ts` | L1 | 轮询、配对、status sticky 合并 | 改 |
| `chat/contract.ts` | — | 四个契约类型 | 新 |
| `chat/adapters/claude.ts` | L2 | Claude 词汇与判定 | 新 |
| `chat/adapters/codex.ts` | L2 | Codex 词汇与判定 | 新 |
| `chat/diff.ts` | L3 工具 | LCS 行对齐 + 补丁切分 | **已写** |
| `chat/tool-parts.tsx` | L3 | 显示件，不认识工具 | **已写** |
| `chat/tool-view.tsx` | L3 | 语义 → 档位路由 | 由已写的 `tool-render.tsx` 拆出 |
| `chat/Message.tsx` | L3 | 共用气泡，正文/工具分段 | **已写** |
| `chat/tasks.ts` | L1 | 任务面板索引：跨消息把 `#id` 接回标题 | **已写** |
| `chat/StatusBar.tsx` | L3 | 会话状态条 | 新 |
| `chat/ask.tsx` | 旁路 | 多问题选择，tab + 焦点定位 | 新 |
| `prompt.tsx` | 旁路 | 权限确认行动条改版 | 改 |
| `chat/actions.tsx` | 旁路 | 打开文件的 context | **已写** |
| `chat/ChatShell.tsx` | 壳 | 输入、上传、滚动、行动条槽位 | 改 |
| `AgentChat.tsx` | 壳 | 吃 Adapter 的通用容器 | 新 |
| ~~`chat/ClaudeMessage.tsx`~~ ~~`chat/CodexMessage.tsx`~~ | — | 删除 | 删 |

---

## 6. 逐模块设计

### 6.1 `chat/diff.ts` — 行对齐

LCS 动态规划，`lcs[i][j]` = `old[i..]` 与 `new[j..]` 的最长公共子序列长度，回溯时
「哪边的剩余 LCS 更长就保留哪边」。输出只含变动行，带原始行号。

两处本仓库增补：

- **超大文本降级**：`oldLines.length * newLines.length > 1_000_000` 时不跑 DP，
  退化成整块替换。100 万格已是几十毫秒级，再大会卡住主线程。
- **LRU 缓存**：轮询会反复用同一对新旧文本重算，缓存上限 100 组。

`parsePatch()` 另按 `*** Update|Add|Delete File:` 把 Codex 的补丁文本切成每文件一段。

### 6.2 `chat/adapters/*.ts` — 唯一 per-provider 的一层

**工具词汇映射**（节选，完整表见 HTML 稿 §6）：

| 语义 | Claude | Codex |
|---|---|---|
| `shell` | `Bash` | `shell` `exec_command` `local_shell` |
| `read` | `Read` | `read_file` |
| `edit` | `Edit` `Write` `MultiEdit` `NotebookEdit` | — |
| `patch` | — | `apply_patch` |
| `plan` | `TodoWrite` `ExitPlanMode` | `update_plan` |
| `search` | `Grep` `Glob` | —（走 `shell` 里的 `rg`） |
| `agent` | `Task` | — |
| `ask` | `AskUserQuestion` | — |
| `mcp` | `mcp__server__tool` | `mcp:server.tool` |

**入参归一的三处硬骨头**：

```ts
// ① Codex 的 shell 是数组，且套着 bash -lc 外壳
function extractCommand(o: any): string {
  const v = o?.command ?? o?.cmd ?? o?.argv
  if (!Array.isArray(v)) return String(v ?? '')
  const last = v[v.length - 1]
  if (v.length >= 3 && /^(ba|z|d|k)?sh$/.test(v[0]) && /^-[lic]+$/.test(v[1])) return last
  return v.map(String).join(' ')
}

// ② apply_patch 两种载荷
const patchText = typeof o?.input === 'string' ? o.input
                : typeof o === 'string'        ? o
                : raw

// ③ Claude 的路径键名有四种
const path = o?.file_path ?? o?.path ?? o?.notebook_path ?? ''
```

这三段现在散在渲染代码里，收进 adapter 之后渲染层只见 `call.command` / `call.files` / `call.path`。

**成败判定**（这是分层最直接的收益）：

```ts
// adapters/claude.ts
outcome(call, result, waiting) {
  if (!result) return { status: waiting ? 'waiting' : 'running', text: '' }
  if (!result.isError) return { status: 'ok', text: result.text ?? '' }
  return { status: DENIED.test(result.text ?? '') ? 'denied' : 'error', text: result.text ?? '' }
}

// adapters/codex.ts —— 退出码不等于失败
outcome(call, result, waiting) {
  if (!result) return { status: waiting ? 'waiting' : 'running', text: '' }
  const code = exitCodeOf(result.text)
  if (code != null && code !== 0) {
    // 非零退出多数时候是正常的（git diff --exit-code、grep 没命中）
    // 不染红，只把退出码带出去，渲染层在行尾标灰字 exit N
    return { status: 'ok', text: result.text ?? '', exitCode: code }
  }
  return { status: result.isError ? 'error' : 'ok', text: result.text ?? '' }
}
```

### 6.3 `chat/tool-parts.tsx` — 纯显示件

十个组件，**没有一个认识「工具」这个概念**：

```
ToolRow      一行式：色条 + 名 + 等宽值 + 状态 + 复制
CommandRow   命令行：$ + 命令 + 行数 + 内联输出下拉
ToolCard     卡片：色条 + 折叠头 + 内容体 + 原始参数
DiffPane     行号槽 + ± 统计 + 文件头 + 角标
PatchPane    按文件切段的补丁着色
TodoPane     待办 / 计划步骤（状态点是画的，不是字符）
FileListPane 命中文件列表
ErrorRow     红条 + 一行预览
OutputPane   通用输出折叠
StatusChip   running / error / denied（ok 不发徽标）
PathLink     可点路径，接不住时退化成文字
```

它们只吃基本类型（string / 数组 / 回调），所以第二批重构时**一行都不用改**。

### 6.4 `chat/Message.tsx` — 正文与工具分段

```ts
function segments(blocks: Block[]): { tool: boolean; blocks: Block[] }[]
```

把连续同类块并成段：正文段进气泡，工具段平铺全宽。理由是工具不是「说的话」，
塞进气泡等于给每次 `Read` 再描一道框。

用户消息另走 `cleanUserText()` 拆四种标记块：

| 标记 | 处置 |
|---|---|
| `<command-name>` `<command-args>` | 气泡内的斜杠命令小标 |
| `<command-message>` | 丢弃（与 command-name 重复） |
| `<local-command-stdout>` | 气泡外折叠 |
| `<system-reminder>` | 气泡外折叠，更暗 |

Codex 侧 `cleanUserText` 另认 `<environment_context>` / `<user_instructions>`
（后端 `isCodexContextWrapper` 已经在丢，这里是双保险）。

### 6.5 交互层：权限确认与多问题

这是全页唯一「活的」东西，性质与其余部分相反：

| | 消息流 | 交互层 |
|---|---|---|
| 来源 | 转录 JSONL | 终端实时画面 `capture` |
| 时效 | 历史，永远留着 | 现在，答完就消失 |
| 可点 | 否 | 是（注入按键） |
| 位置 | 随流滚动 | 固定在输入框上方 |

**双层呈现**：卡在哪一步标在消息流里（那条工具行转 `waiting`，黄色），
按哪个键放在底部行动条。因为回答「要不要执行」的前提是看得见那条命令——
所以是**面板不是模态**，模态正好会挡住它。

**人不在这一页时**靠第三处：手机会话顶栏那颗**灵动岛**（`.tt-sesshead .pill`）。
它平时显示「状态点 + 会话名 + 会话数」，有 Agent 在跑时状态点带一圈呼吸
（静态点分不出「在干活」和「卡住了」）；一旦有待确认，**整颗岛变黄并浮出「待确认」**——
50px 顶栏里只把 8px 的点变黄根本注意不到。桌面对应的是标签页上的「待确认」角标
（`advancePromptSignal`，连续两次采样才切换，防 TUI 重绘残帧闪动）。

#### 多问题（横向 tab）的关键设计

`AskUserQuestion` 一次最多问 4 个问题，TUI 排成横向 tab。**结构不用从画面猜**——
`tool_use` 的 `input.questions` 带着全部信息：

```jsonc
// 本仓库真实转录样本（toolu_01MMJtLNcVChiGnsm7HiQfo1）
{"questions": [
  {"header": "消息布局", "question": "…", "multiSelect": false,
   "options": [{"label": "…", "description": "…", "preview": "…"}]},
  {"header": "点开文件", …},
  {"header": "图标清理", …}
]}
```

于是分工是：**结构从转录来（准确完整），焦点从画面来（只需知道游标在哪）**。

**焦点定位用内容指纹，不认 TUI 高亮**——`capture` 是纯文本，高亮信息本来就没了：

```
capture 解析出当前屏上的选项文字
  → 跟转录里 N 个问题的 options 做匹配 → 命中哪个，当前 tab 就是它
  → ❯ 在第几条 → 当前选项就是第几条
```

**点击换算成按键序列**：

```
目标 (tab 2→3, 选项 1→2)  ⇒  ['Right', 'Down', 'Enter']
```

**多选题不幂等**：单选是「移过去 + Enter」可安全重发；多选是「移过去 + 空格切换」，
重发一次就把刚勾的取消了。必须先读当前勾选状态，只对状态不一致的项发空格。

**答案不在 `tool_use` 里**，实测 `input` 只有 `questions` 一个键。答案在 `tool_result` 文本：

```
Your questions have been answered: "问题"="选中的label" selected preview: … , "问题2"="…"
```

用 `/"([^"]*)"="([^"]*)"/g` 抠出问答对，再拿问题文本回去匹配 `questions`。
匹配不上就退化成「已回答」但不高亮具体项——**不猜**。

### 6.6 `chat/StatusBar.tsx` — 会话状态条

要显示的四样东西**全都已在转录里**，一个字节不用从终端抓：

| 字段 | Claude | Codex |
|---|---|---|
| 权限模式 | `type:"permission-mode"` 行的 `permissionMode` | `turn_context.collaboration_mode.mode` + `approval_policy` + `sandbox_policy.type` |
| 模型 | `message.model` | `turn_context.model` |
| 推理档 | 顶层 `effort` | `collaboration_mode.settings.reasoning_effort` |
| 上下文 | `message.usage` 的 `input + cache_read + cache_creation` | `token_count.info.total_token_usage.total_tokens` |
| 窗口 | **猜**：model id 带 `[1m]` → 1e6，否则 2e5 | `token_count.info.model_context_window`（直接给） |
| 额度 | 无 | `token_count.rate_limits.primary.used_percent` |

模式 pill 在 Claude 侧**可点轮换**（注入 `Shift+Tab`），乐观更新 + 下一条 `permission-mode`
行对账；实测那些行是**改模式当场落盘**的，所以纠偏延迟只有一个轮询周期。
Codex 侧走 `/approvals` 多步菜单，v1 只读。

### 6.7 `chat/actions.tsx` — 打开文件

用 context 而不是一路 prop 钻：路径出现在 `ToolRow` / `DiffPane` / `FileListPane` 三层，
钻到最里面要穿过语义路由，路由就得为此改签名。

```ts
export type ChatActions = { openFile?: (path: string, line?: number) => void }
```

`App.tsx` 提供实现，复用已有的意图机制（`intents.ts`）：

- 会话页 `fileDock === 'left'` 时 `FileWorkspace` 已挂载（`App.tsx:1821`），
  直接 `requestIntent(OPEN_FILE_INTENT, { path, line })`，文件开成对话旁边的标签页；
- 否则先 `location.hash = '#/files'` 再发意图，跟 ⌘K 搜索结果同一条路（`App.tsx:671`）。

**手机不给假链接**：文件面板是全屏二级页，从对话里跳过去会丢上下文，
所以 `openFile` 为空时 `PathLink` 退化成普通文字。

行号跳转另需 `FileWorkspace → FileView → CodeEditor` 透传，Monaco 挂载后
`revealLineInCenter` + `setPosition` 一次；同一文件已开着时靠自增 nonce 触发重定位。

### 6.8 任务面板：`#4` 是哪件事

`TaskCreate` / `TaskUpdate` 是 Claude Code 的任务列表工具。它有一个别的工具都没有的麻烦：

```jsonc
// 这一次调用的全部信息就这么多
{"taskId": "4", "status": "completed"}
```

**光看这次调用，谁也不知道 #4 是哪件事。** 标题在更早的那次 `TaskCreate` 里，
而 `#4` 这个 id 只出现在它的**结果文本**中：

```
Task #4 created successfully: 补单测并跑全套校验
```

所以必须**跨消息扫一遍**才能把 id ↔ 标题接上——这不是单个工具块能自己解决的事，
它是转录级的派生数据。`chat/tasks.ts` 做这件事，产出 `TaskIndex`：

```ts
export type TaskInfo = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
}
```

按时间顺序覆盖，所以拿到的是**最新状态**。索引经 `ChatActions` context 下发到工具渲染层
（同「打开这个文件」那条路，避免为它改注册表签名）。

渲染分工：

| 工具 | 呈现 |
|---|---|
| `TaskCreate` | 一行式：`新建任务 <标题>`，右侧标 `#N` |
| `TaskUpdate` | 一行式：`#N <查出来的标题>` + 状态（待办 / 进行中 / 已完成），色条跟状态走 |
| `TaskList` / `TaskGet` | **任务面板**：整段转录归拢出的清单，带 `#id`、状态点与 `n/m 完成` |

面板画的是**索引**，不是这一次调用的入参——`TaskList` 的入参本来就是空的，
有价值的是「现在一共几件事、做到哪了」。

两条边界：

- **结果还没回来时不进索引**。`TaskCreate` 正在跑就还没有 id，等下一轮轮询补上；
  宁可少一条，不要画一条没有编号的孤儿。
- **没见过的 id 也认**。转录被截断（只加载最近 200 条）时会遇到只有 `TaskUpdate`
  没有 `TaskCreate` 的情况，此时标题为空但状态照记，面板上显示成 `任务 #9`。

---

## 7. 后端改动

改动刻意压到最小，三处：

### 7.1 透出 status

```go
type cStatus struct {
    Mode, Model, Effort string
    Used, Window        int
    QuotaPercent        float64
}
// 响应：{ messages, nextOffset, status }
```

那些 `permission-mode` / `token_count` / `turn_context` 行**现在正被 `parseLine` 返回 nil 丢掉**，
但已经在扫描范围内。顺手捡出来即可，增量成本约等于零。

**不开独立端点**：状态与消息同源、同频、同一份 offset，开第二个端点等于把增量与去重逻辑
再实现一遍，还多一倍请求。将来要在会话 tab 上显示占用率（对话页未打开时），再抽不迟。

### 7.2 给 cBlock 补 meta

```go
Meta map[string]string `json:"meta,omitempty"`
```

让适配层拿到被压扁的原始信息（如 Codex 的退出码）。比重做 IR 划算得多。

### 7.3 两处写死中文改 sentinel

`claude.go:319` 的 `"（思考内容已加密，无法展示）"` → `"[redacted_thinking]"`；
`:251` 的 `"[图片]"` → `"[image]"`。前端出译文。

---

## 8. 状态与时序

### 8.1 三条独立的轮询流

| 流 | 周期 | 端点 | 用途 |
|---|---|---|---|
| 转录 | 1.5s | `/transcript`（增量 offset） | 消息、状态 |
| 画面 | 1.2s | `/capture?lines=50` | 选择框检测 |
| 实况 | 0.8s | `/capture?lines=40` | 生成中的尾部预览 |

三条不同步是**常态**，不是 bug。所有跨流的状态都要定义清楚谁说了算。

### 8.2 待确认状态机

```
tool_use 落盘，无结果
      │
      ├─ 交互层无信号 ────────────────→ running（转圈）
      │
      └─ 交互层报「有待确认」且该工具确实无结果 ──→ waiting（黄）
                    │
                    ├─ 选择框消失 ──→ 乐观清 waiting，回 running，等转录对账
                    └─ 结果落盘  ──→ ok / denied / error
```

两条约束：

1. **选择框一消失就乐观清掉 waiting**，不等转录——否则黄条会多挂一秒多。
2. **黄色额外要求「该工具确实没有结果」**。`detectPrompt` 有把 Agent 输出的编号列表
   误判成选择框的历史；新渲染让误判代价变大（以前只是底部多块面板，现在还会染黄一条正常的工具行）。

### 8.3 结果配对

```
① 按 toolUseId 配对（主路径）
② 同一条消息内，tool_use 紧邻其后的 tool_result 位置配对（兜底）
   ↑ Codex 的 mcp_tool_call_end 两个块都没有 id，只能靠这条
③ 都配不上 → 结果单独画成 LooseResult
```

### 8.4 转录文件切换

`useTranscript` 已处理两种情况：后端返回的 `file` 变了（会话换了 rollout）、
`nextOffset` 回退（文件被截断/重写）。两种都是清空重来。新增 `status` 也要跟着重置。

---

## 9. 降级与容错

设计原则：**认不出来就退化，绝不猜**。

| 场景 | 降级 |
|---|---|
| 工具名不认识 | `kind: 'unknown'`，画兜底卡片 + JSON 参数 |
| 入参不是 JSON | 原文进 `unknown.args`，照样能看 |
| diff 文本过大 | 跳过 LCS，整块替换 |
| 补丁切不出文件 | 整段按 +/- 着色 |
| 结果不像文件列表 | 走通用 `OutputPane` |
| 选择框指纹匹配不上 | 面板**只显示不可点**，提示去终端操作 |
| 答案正则抠不出 | 标「已回答」但不高亮具体项 |
| Claude 窗口大小认不出 | 按 200k 保守算（宁可显示偏高） |
| `openFile` 未提供 | `PathLink` 退化成普通文字 |

最后一类尤其重要：**按错一个方向键，选中的就是另一个答案**。交互层宁可不可点。

---

## 10. 性能

| 点 | 措施 |
|---|---|
| LCS 是 O(n·m) | 100 万格上限 + LRU 缓存 100 组 |
| 长转录 | `ChatShell` 只渲染最近 200 条，「加载更早」每次 +200 |
| 重复渲染 | `ChatMessage` 用 `memo`，key 取转录行 uuid（保住折叠态） |
| 折叠态丢失 | key 必须稳定——用 `m.id`（后端已透出行 uuid），不用数组下标 |
| 输出体积 | `CommandRow` 输出 `max-height: 320px` 内部滚动，不撑长文档 |
| 首屏 | Markdown 链路（约 80KB gz）已整体懒加载，本稿不引入新的重依赖 |

---

## 11. 测试

`chat/` 目录现在**一个测试都没有**，正是因为逻辑全缠在 JSX 里。分层之后：

```
chat/diff.test.ts
  · LCS 只吐变动行，不整块替换
  · 超大文本降级
  · parsePatch 切多文件补丁
  · 缓存命中不改变结果

chat/adapters/claude.test.ts        ← 纯函数，喂真实转录片段
  · Read/Edit/Bash/TodoWrite/AskUserQuestion 各映射到正确 kind
  · 四种路径键名都归到 call.path
  · denied 与 error 分得开
  · cleanUserText 拆四种标记块

chat/adapters/codex.test.ts
  · ["bash","-lc","x"] → "x"；["ls","-la"] → "ls -la"
  · apply_patch 两种载荷都认
  · git diff --exit-code 的 exit 1 判成 ok 且带 exitCode
  · update_plan → kind 'plan'

chat/tasks.test.ts
  · TaskCreate 标题 + 结果文本里的 #id 接得上
  · TaskUpdate 只给 {taskId,status} 也能查到标题
  · 后面的更新覆盖前面的（最新状态）
  · 结果没回来时不进索引；没见过的 id 也认
  · 非法状态回落 pending

chat/useTranscript.test.ts
  · id 配对；相邻位置兜底（MCP 场景）
  · 文件切换清空；offset 回退清空
  · status sticky 合并

chat/ask.test.ts
  · 内容指纹定位当前 tab / 当前选项
  · 点击换算按键序列（跨 tab、跨选项）
  · 多选只对状态不一致的项发空格
  · tool_result 文本抠答案
```

**验收命令**（提交前必过）：

```bash
cd frontend && npm run typecheck && npm run i18n:check && npx vitest run && npm run build
```

真机验收跑法见 [web-ui-checklist](../../../development/web-ui-checklist.md)：
build 后拷进后端 `-web` 指向的 `frontend/dist`，手机 adb forward + CDP 走一遍
Claude 与 Codex 两个会话，深浅两套主题各一遍。重点看四样：连续 Read 的密度、
Edit 的 diff、一条报错是否第一眼就看见、多问题选择框的 tab 能不能点对。

---

## 12. 分批实施

三批，每批自成一个可合并的 PR。

### 第一批 · 渲染（不动后端，风险最低）

HTML 稿 §1–§9。已写掉大半（`diff.ts` / `tool-parts.tsx` / `tool-render.tsx` /
`Message.tsx` / `actions.tsx`），剩下接线、补 16 个 i18n key、清掉文案里焊死的
emoji 与字符图标（`📄 📎 ⤒ ⚠`）、删两份旧渲染。

验收：一屏连续 Read 的高度较改前减少 ≥40%；错误在一屏里唯一显红。

### 第二批 · 分层（本稿的主体）

把 `tool-render.tsx` 拆成 `adapters/` + `tool-view.tsx`，补 `contract.ts`，
落掉 Codex 退出码误判与 MCP 转圈两个坑，补齐上面那批测试。
`tool-parts.tsx` 一行不改——这是分层是否成立的检验。

验收：`adapters/` 下无 `.tsx` import；`tool-view.tsx` 内 grep 不到 `claude` / `codex`
字样；测试覆盖上表所有条目。

### 第三批 · 状态条与交互层

唯一需要动 Go 的一批，建在第二批的 `Adapter` 接口上：后端透 status，
`StatusBar.tsx`，`prompt.tsx` 改版，`chat/ask.tsx` 多问题 tab。

验收：Claude 侧点模式 pill 能轮换且一个轮询周期内对账；三问题选择框在手机上能答完三个。

---

## 13. 风险与取舍

**多一层的成本是真的。** 约 200 行、一个新目录、一次重构。支撑它的不是「将来可能加第三个 agent」，
而是三条现在就成立的理由：① 入参形状差异已经长出缝合代码；② 成败判定必须 per-provider，
缠在 JSX 里没法测；③ 纯函数才能喂真实转录做快照测试。

**语义放前端、不推到 Go** 是个明确取舍。Go 要重新 build + 重装才生效，前端 build 完拷进
dist 刷新就见效；而工具渲染是纯呈现关切，Web 是唯一消费者。**块流解析必须在 Go**
（文件定位、增量 offset），**工具语义必须在前端**（跟档位、图标、折叠策略强耦合）。

**交互层是最脆的一环。** 它依赖终端 TUI 的文本布局，Claude / Codex 任一方改版都可能让
指纹匹配失效。所以降级路径必须是「只显示不可点」而不是「尽力猜」，
并且这条降级要有测试覆盖——它是唯一一处出错会导致**用户答错题**的地方。

**不做的事**：不引入 Tailwind / shadcn 依赖（与本仓库「只用令牌、全站蓝绿各一支」硬规则冲突）；
不动转录拉取的增量协议；不重复造权限交互面板（复用 `prompt.tsx`）。

---

## 附录 A · 真实数据样本

以下均取自本机真实转录，用于写测试夹具。

**Claude — `message.usage`**

```json
{"input_tokens":2,"cache_creation_input_tokens":2634,"cache_read_input_tokens":269173,
 "output_tokens":723}
```
上下文占用 = `2 + 2634 + 269173` = 271,809。

**Claude — 顶层元信息（assistant 行）**

```
cwd · effort · entrypoint · gitBranch · message · requestId · sessionId · timestamp
· type · uuid · version
message: content · diagnostics · id · model · role · stop_reason · usage
```

**Claude — `permissionMode` 出现位置**

```
type:"permission-mode"  ×16      ← 改模式当场落盘
type:"user"             ×7
```

**Codex — `token_count` 事件**

```json
{"info":{"total_token_usage":{"total_tokens":16543},"model_context_window":258400},
 "rate_limits":{"primary":{"used_percent":44.0,"window_minutes":10080}}}
```

**Codex — `turn_context`**

```json
{"approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},
 "model":"gpt-5.6-sol",
 "collaboration_mode":{"mode":"default","settings":{"reasoning_effort":"high"}}}
```

**Claude — `AskUserQuestion` 三问题**

```
header='消息布局' multi=False opts=['工具平铺出气泡（推荐）','保持嵌套在气泡里']
header='点开文件' multi=False opts=['先不做','做，点击在文件面板打开']
header='图标清理' multi=False opts=['顺手清掉（推荐）','这次不动']
input keys: ['questions']          ← 注意：没有 answers
```

对应的 `tool_result`：

```
Your questions have been answered: "助手消息里的工具调用怎么摆？"="工具平铺出气泡（推荐）"
selected preview: … , "文件名要不要点得开？…"="做，点击在文件面板打开" …
```
