// 会话状态：后端原样吐出的字段 → 渲染层认得的归一形状。
//
// 这一层是 15 设计 §11 说的「渲染层只判断有没有 quota，不判断是不是 Codex」：
// Claude 没有额度这一项，那个元素就不出现，而不是在组件里写 if (side === 'codex')。
import type { TaskIndex } from './tasks'
import { taskList } from './tasks'

/** 后端 /transcript 响应里的 status（两端同一个形状，字段各有缺席） */
export type RawStatus = {
  mode?: string
  model?: string
  effort?: string
  used?: number
  window?: number
  quota?: number
}

export type ModeTone = 'accent' | 'ok' | 'warn' | 'neutral'

export type AgentStatus = {
  mode?: { id: string; tone: ModeTone }
  model?: string
  effort?: string
  context?: { used: number; window: number; percent: number }
  quota?: number
  /** 任务进度：来自转录归拢出的任务清单，不是后端给的 */
  tasks?: { done: number; total: number; doing?: string }
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
    out.context = { used: raw.used, window: raw.window, percent: Math.min(100, (raw.used / raw.window) * 100) }
  }
  if (raw.quota) out.quota = raw.quota
  const list = tasks ? taskList(tasks) : []
  if (list.length) {
    out.tasks = {
      done: list.filter((x) => x.status === 'completed').length,
      total: list.length,
      doing: list.find((x) => x.status === 'in_progress')?.subject,
    }
  }
  return out
}

/** 271809 → 271.8k；给环旁边那行小字用，位数固定才不会一跳一跳 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
