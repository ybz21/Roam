// 把相邻的工具调用并成「运行组」（设计 16）。
//
// 为什么必须在**消息列表层**做：Claude 每次工具调用单独成一条助手消息，一串 5 条命令
// 就是 5 条消息。Message.tsx 里的 segments() 只在一条消息内部并段，对这个场景零收益。
// 所以分组发生在 ChatShell 渲染 Msg[] 之前，这里只出数据，不出 JSX（好测）。
//
// 分组规则（见设计 16 §2）：
//   · 只并**相邻**的、**只含工具块**的助手消息；中间夹正文/思考/用户消息即断组
//   · 家族不同不并（终端 / 改文件 / 读查 / 任务面板 / 其它各自成组）
//   · 少于 2 个调用不成组——单独一条命令套个组头是净亏
//   · 决策类（选择框、计划、子代理）永远独立成条，不进组也不断家族之外的组
import type { Block, Msg } from './types'
import { extractCommand, commandFromRaw, editParts, toolStatus } from './tool-render'
import { cachedDiff, parsePatch } from './diff'

export type Family = 'term' | 'edit' | 'read' | 'task' | 'other'

const FAMILY: Record<string, Family> = {
  // 终端
  Bash: 'term', BashOutput: 'term', KillShell: 'term',
  shell: 'term', local_shell: 'term', exec_command: 'term', container_exec: 'term', write_stdin: 'term',
  // 改文件
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', apply_patch: 'edit',
  // 读 / 查
  Read: 'read', read_file: 'read', Grep: 'read', Glob: 'read',
  WebFetch: 'read', WebSearch: 'read', web_search: 'read', view_image: 'read',
  // 任务 / 待办面板
  TodoWrite: 'task', update_plan: 'task',
  TaskCreate: 'task', TaskUpdate: 'task', TaskList: 'task', TaskGet: 'task',
  TaskOutput: 'task', TaskStop: 'task',
}

// 这几样永远单独成条：它们要么在等人做决定（选择框、计划），要么本身就是一大段
// 汇报（子代理）。收进组里等于把最该看见的东西藏起来。
const NO_GROUP = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode', 'Task', 'Agent'])

/** 这个工具属于哪一族；null = 不参与分组 */
export function familyOf(name: string): Family | null {
  const n = String(name || '')
  if (!n || NO_GROUP.has(n)) return null
  return FAMILY[n] || 'other'
}

export type ToolEntry = { use: Block; result?: Block; msgId?: string }

export type Run = {
  /** 组内第一条 tool_use 的 id —— 追加新调用时组身份不变，用户展开态才不会被冲掉 */
  key: string
  family: Family
  entries: ToolEntry[]
  /** 还有调用没拿到结果 */
  live: boolean
  errors: number
  denied: number
}

export type Item =
  | { kind: 'msg'; msg: Msg; index: number }
  | { kind: 'run'; run: Run }

type Cand = { index: number; msg: Msg; family: Family; uses: Block[] }

// 「纯工具消息」：助手发的、只有工具块、家族一致。任何一条不满足就不参与分组。
function candidate(m: Msg, index: number): Cand | null {
  if (m.role !== 'assistant' || !m.blocks.length) return null
  let family: Family | null = null
  const uses: Block[] = []
  for (const b of m.blocks) {
    if (b.kind === 'tool_use') {
      const f = familyOf(String(b.name || ''))
      if (!f || (family && family !== f)) return null
      family = f
      uses.push(b)
    } else if (b.kind !== 'tool_result') {
      return null // 夹着正文或思考 —— 这条不是纯工具消息
    }
  }
  return family && uses.length ? { index, msg: m, family, uses } : null
}

export function groupRuns(msgs: Msg[], results: Record<string, Block>): Item[] {
  const out: Item[] = []
  let buf: Cand[] = []

  const flush = () => {
    if (!buf.length) return
    const entries: ToolEntry[] = []
    for (const c of buf) for (const u of c.uses) {
      entries.push({ use: u, result: u.id ? results[u.id] : undefined, msgId: c.msg.id })
    }
    // 少于 2 个调用不成组：一条命令外面套个组头，净亏一行
    if (entries.length < 2) {
      for (const c of buf) out.push({ kind: 'msg', msg: c.msg, index: c.index })
    } else {
      let live = false, errors = 0, denied = 0
      for (const e of entries) {
        const st = toolStatus(e.result)
        if (st === 'running') live = true
        else if (st === 'error') errors++
        else if (st === 'denied') denied++
      }
      out.push({
        kind: 'run',
        run: { key: entries[0].use.id || `run-${buf[0].index}`, family: buf[0].family, entries, live, errors, denied },
      })
    }
    buf = []
  }

  msgs.forEach((m, i) => {
    const c = candidate(m, i)
    if (!c) { flush(); out.push({ kind: 'msg', msg: m, index: i }); return }
    if (buf.length && buf[0].family !== c.family) flush()
    buf.push(c)
  })
  flush()
  return out
}

// ── 组头摘要 ────────────────────────────────────────────────────────────
// 折叠态那一行要回答的是「这一串干了什么、量有多大、最后一条是什么」。

export type RunSummary = {
  count: number
  /** 终端：输出总行数 */
  lines?: number
  /** 终端/读查：最后一条的命令或路径，收起时显示 */
  last?: string
  /** 改文件：涉及的文件数与增删行 */
  files?: number
  plus?: number
  minus?: number
  /** 任务面板：最近一次的进度 */
  done?: number
  total?: number
}

const s = (v: any) => (v == null ? '' : String(v))

function parse(input?: string): any {
  const raw = s(input)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function runSummary(run: Run): RunSummary {
  const out: RunSummary = { count: run.entries.length }
  if (run.family === 'term') {
    let lines = 0
    for (const e of run.entries) {
      const txt = s(e.result?.text).replace(/\s+$/, '')
      if (txt) lines += txt.split('\n').length
    }
    out.lines = lines
    const last = run.entries[run.entries.length - 1]
    const o = parse(last.use.input)
    out.last = extractCommand(o) || commandFromRaw(s(last.use.input))
    return out
  }
  if (run.family === 'edit') {
    const paths = new Set<string>()
    let plus = 0, minus = 0
    for (const e of run.entries) {
      const name = s(e.use.name)
      const raw = s(e.use.input)
      const o = parse(raw)
      // Codex 的 apply_patch 是补丁原文，没有新旧串——直接数补丁行
      if (name === 'apply_patch') {
        const text = typeof o?.input === 'string' ? o.input : typeof o === 'string' ? o : raw
        for (const f of parsePatch(text)) {
          if (f.path) paths.add(f.path)
          for (const l of f.lines) {
            if (l.startsWith('+')) plus++
            else if (l.startsWith('-')) minus++
          }
        }
        continue
      }
      const p = editParts(name, o)
      if (!p) continue
      if (p.path) paths.add(p.path)
      // MultiEdit：一次调用里多处改动，逐处算
      const pairs = Array.isArray(o?.edits) && o.edits.length
        ? o.edits.map((x: any) => [s(x?.old_string ?? x?.old_str), s(x?.new_string ?? x?.new_str)] as const)
        : [[p.oldText, p.newText] as const]
      for (const [a, b] of pairs) {
        for (const l of cachedDiff(a, b)) {
          if (l.type === 'added') plus++; else minus++
        }
      }
    }
    out.files = paths.size
    out.plus = plus
    out.minus = minus
    if (paths.size === 1) out.last = [...paths][0]
    return out
  }
  if (run.family === 'read') {
    const last = run.entries[run.entries.length - 1]
    const o = parse(last.use.input)
    out.last = s(o?.file_path ?? o?.path ?? o?.notebook_path ?? o?.pattern ?? o?.query ?? o?.url)
    return out
  }
  if (run.family === 'task') {
    // 面板族折叠时给最近一次的进度：待办列表本身每次调用都是全量，只有最后一份有意义
    for (let i = run.entries.length - 1; i >= 0; i--) {
      const o = parse(run.entries[i].use.input)
      const arr = Array.isArray(o?.todos) ? o.todos : Array.isArray(o?.plan) ? o.plan : null
      if (!arr) continue
      out.total = arr.length
      out.done = arr.filter((x: any) => s(x?.status) === 'completed').length
      break
    }
    return out
  }
  const last = run.entries[run.entries.length - 1]
  out.last = s(last.use.name)
  return out
}
