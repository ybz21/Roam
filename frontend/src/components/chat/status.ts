// 会话状态：后端原样吐出的字段 → 渲染层认得的归一形状。
//
// 这一层是 15 设计 §11 说的「渲染层只判断有没有 quota，不判断是不是 Codex」：
// Claude 没有额度这一项，那个元素就不出现，而不是在组件里写 if (side === 'codex')。
import type { TaskIndex, TaskInfo } from './tasks'
import { taskList } from './tasks'

/** 后端 /transcript 响应里的 status（两端同一个形状，字段各有缺席） */
export type RawStatus = {
  mode?: string
  model?: string
  effort?: string
  used?: number
  window?: number
  quota?: number
  branch?: string
  cwd?: string
}

export type ModeTone = 'accent' | 'ok' | 'warn' | 'neutral'

export type AgentStatus = {
  mode?: { id: string; tone: ModeTone }
  model?: string
  effort?: string
  context?: { used: number; window: number; percent: number }
  quota?: number
  branch?: string
  cwd?: string
  /** 任务进度：来自转录归拢出的任务清单，不是后端给的。list 供展开看逐条进度 */
  tasks?: { done: number; total: number; doing?: string; list: TaskInfo[] }
  /** 失败的工具调用数（前端从消息流数的）；点它跳到最近一次 */
  errors?: number
  /** 会话时长（毫秒）：首条到末条消息的跨度 */
  elapsed?: number
}

// 已知的窗口档位。后端给的窗口万一偏小（settings.json 读不到、或上游又加了新档），
// 用真实用量兜底升档——**「100% 却还在涨」是最没法自圆其说的一种显示**。
const WINDOWS = [200_000, 1_000_000, 2_000_000]

export function fitWindow(used: number, window: number): number {
  if (!window || used <= window) return window
  return WINDOWS.find((w) => w >= used) ?? used
}

// 模式 → 色调。计划＝蓝（只读，安全），自动接受编辑＝绿（顺畅），
// 越权/全权限＝黄（提醒你它现在不问就动手），其余中性。
const MODE_TONE: Record<string, ModeTone> = {
  plan: 'accent',
  acceptEdits: 'ok',
  bypassPermissions: 'warn',
  'danger-full-access': 'warn',
  never: 'warn',
  default: 'neutral',
  'read-only': 'accent',
  'workspace-write': 'ok',
}

/** 模式 id → i18n key；认不出就原样显示 id（新模式先出现在 CLI 里是常态） */
export function modeKey(id: string): string {
  return `chat.mode.${id}`
}

export function toAgentStatus(raw: RawStatus, tasks?: TaskIndex): AgentStatus {
  const out: AgentStatus = {}
  if (raw.mode) out.mode = { id: raw.mode, tone: MODE_TONE[raw.mode] || 'neutral' }
  if (raw.model) out.model = raw.model
  if (raw.effort) out.effort = raw.effort
  if (raw.used && raw.window) {
    const window = fitWindow(raw.used, raw.window)
    out.context = { used: raw.used, window, percent: Math.min(100, (raw.used / window) * 100) }
  }
  if (raw.quota) out.quota = raw.quota
  if (raw.branch) out.branch = raw.branch
  if (raw.cwd) out.cwd = raw.cwd
  const list = tasks ? taskList(tasks) : []
  if (list.length) {
    out.tasks = {
      done: list.filter((x) => x.status === 'completed').length,
      total: list.length,
      doing: list.find((x) => x.status === 'in_progress')?.subject,
      list,
    }
  }
  return out
}

/** 毫秒 → 1h 12m / 12m 30s / 45s。会话时长用，位数少才不抢眼 */
export function fmtElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return sec % 60 ? `${min}m ${sec % 60}s` : `${min}m`
  const hr = Math.floor(min / 60)
  return min % 60 ? `${hr}h ${min % 60}m` : `${hr}h`
}

/** 271809 → 271.8k；给环旁边那行小字用，位数固定才不会一跳一跳 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
