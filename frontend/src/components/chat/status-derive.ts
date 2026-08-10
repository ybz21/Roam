// 从消息流里派生出来的状态项：失败数、会话时长。
//
// 这两项后端给不了——失败要数遍所有 tool_result，时长要看首末时间戳，
// 而后端是**增量扫描**（只看 offset 之后的新行），拿不到全局。前端手里是完整的
// Msg[]，数一遍就有；顺带把最近一次失败的消息 id 带出来，供状态条点了跳过去。
import type { Msg } from './types'

export type Derived = { errors: number; lastErrorId?: string; elapsed?: number }

export function deriveFromMessages(msgs: Msg[]): Derived {
  let errors = 0
  let lastErrorId: string | undefined
  for (const m of msgs) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_result' && b.isError) {
        errors++
        if (m.id) lastErrorId = m.id
      }
    }
  }

  let elapsed: number | undefined
  const first = msgs.find((m) => m.ts)?.ts
  // 从后往前找末条：最后几条可能没有时间戳
  let last: string | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].ts) { last = msgs[i].ts; break }
  }
  if (first && last) {
    const d = new Date(last).getTime() - new Date(first).getTime()
    if (d > 0) elapsed = d
  }
  return { errors, lastErrorId, elapsed }
}
