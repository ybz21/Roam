// 轮询会话转录(JSONL)，按物理行 offset 增量拉取，自动归一为 Msg[]。
// Claude 与 Codex 共用，只是 path 不同(transcript / codex-transcript)。
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Block, Msg } from './types'

export function useTranscript(name: string, file: string | undefined, path: string, interval = 1500) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    let stop = false
    let offset = 0
    let f = file
    setMsgs([]); setErr('')
    const poll = async () => {
      try {
        const q = new URLSearchParams({ offset: String(offset) })
        if (f) q.set('file', f)
        const r = await api('GET', `/sessions/${encodeURIComponent(name)}/${path}?${q.toString()}`)
        const d = r.data
        if (stop) return
        if (d.file) f = d.file
        if (d.messages?.length) { setMsgs((m) => [...m, ...d.messages]); offset = d.nextOffset }
        else if (typeof d.nextOffset === 'number') offset = d.nextOffset
      } catch (e: any) { if (!stop) setErr(e.message) }
    }
    poll()
    const t = setInterval(poll, interval)
    return () => { stop = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  return { msgs, err }
}

// 把 tool_result 按 tool_use_id 挂回对应 tool_use，并从消息流里隐去已收纳的独立结果气泡。
// Claude、Codex 共用（两端后端都已透出 id / toolUseId）。
export function pairToolResults(msgs: Msg[]): { results: Record<string, Block>; view: Msg[] } {
  const results: Record<string, Block> = {}
  for (const m of msgs) for (const b of m.blocks) if (b.kind === 'tool_result' && b.toolUseId) results[b.toolUseId] = b
  const consumed = new Set<string>()
  for (const m of msgs) for (const b of m.blocks) if (b.kind === 'tool_use' && b.id && results[b.id]) consumed.add(b.id)
  const view = msgs.map((m) => {
    if (m.role !== 'tool') return m
    const blocks = m.blocks.filter((b) => !(b.kind === 'tool_result' && b.toolUseId && consumed.has(b.toolUseId)))
    return { ...m, blocks }
  }).filter((m) => m.blocks.length > 0)
  return { results, view }
}

// 「正在生成」判定：最后一轮还没轮到 assistant 收尾(用户刚发 / 工具刚返回 / 正调用工具)。
export function isPending(view: Msg[]): boolean {
  const last = view[view.length - 1]
  if (!last) return false
  if (last.role === 'user' || last.role === 'tool') return true
  if (last.role === 'assistant') return last.blocks[last.blocks.length - 1]?.kind === 'tool_use'
  return false
}
