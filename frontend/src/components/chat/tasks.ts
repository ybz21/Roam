// 任务面板的数据：把整段转录里的 TaskCreate / TaskUpdate 归拢成「当前任务清单」。
//
// 为什么要单独一层：`TaskUpdate` 的入参只有 `{taskId:"4", status:"completed"}` ——
// 光看这一次调用，谁也不知道 #4 是哪件事。标题在更早的那次 `TaskCreate` 里，
// 而 id 只出现在它的**结果文本**（`Task #4 created successfully: 标题`）中。
// 所以必须跨消息扫一遍才能把 id ↔ 标题接上，这不是单个工具块能自己解决的事。
import type { Block, Msg } from './types'

export type TaskInfo = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  description?: string
}

export type TaskIndex = Record<string, TaskInfo>

// `Task #12 created successfully: 标题` / `Created task #12: 标题`
const CREATED = /task\s*#(\d+)[^:：]*[:：]\s*(.*)$/i
// 结果里没带 id 时的兜底：`Updated task #3 status`
const TOUCHED = /task\s*#(\d+)/i

function parseInput(input?: string): any {
  if (!input) return null
  try { return JSON.parse(input) } catch { return null }
}

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted'])
const normStatus = (v: any): TaskInfo['status'] =>
  (STATUSES.has(String(v)) ? String(v) : 'pending') as TaskInfo['status']

/**
 * 扫一遍消息流，建出 id → 任务 的索引。
 * 按时间顺序覆盖：同一个 id 后面的 TaskUpdate 覆盖前面的，所以结果是「最新状态」。
 */
export function buildTaskIndex(msgs: Msg[], results: Record<string, Block>): TaskIndex {
  const idx: TaskIndex = {}
  for (const m of msgs) {
    for (const b of m.blocks) {
      if (b.kind !== 'tool_use' || !b.name?.startsWith('Task')) continue
      const o = parseInput(b.input)
      if (!o) continue
      const out = b.id ? results[b.id]?.text || '' : ''

      if (b.name === 'TaskCreate') {
        // id 只在结果文本里；结果还没回来（正在跑）就先记不到索引，等下一轮轮询补上
        const m2 = CREATED.exec(out)
        if (!m2) continue
        const id = m2[1]
        idx[id] = {
          id,
          subject: String(o.subject || m2[2] || '').trim(),
          activeForm: o.activeForm ? String(o.activeForm) : undefined,
          description: o.description ? String(o.description) : undefined,
          status: 'pending',
        }
        continue
      }

      if (b.name === 'TaskUpdate') {
        const id = String(o.taskId ?? TOUCHED.exec(out)?.[1] ?? '')
        if (!id) continue
        const prev = idx[id]
        idx[id] = {
          id,
          subject: String(o.subject || prev?.subject || '').trim(),
          activeForm: o.activeForm ? String(o.activeForm) : prev?.activeForm,
          description: o.description ? String(o.description) : prev?.description,
          status: o.status ? normStatus(o.status) : (prev?.status || 'pending'),
        }
      }
    }
  }
  return idx
}

/** 面板顺序按 id 数值升序——那正是创建顺序，跟人心里的编号一致 */
export function taskList(idx: TaskIndex): TaskInfo[] {
  return Object.values(idx)
    .filter((t) => t.status !== 'deleted')
    .sort((a, b) => Number(a.id) - Number(b.id))
}
