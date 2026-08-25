// 插件格的取值：按声明的 refresh 调 `POST /plugins/<id>/run`，从返回的 JSON 里取值。
// 设计见 docs/design/web/20-status-bar/index.html §05「拉与推」/ §12。
//
// 三条不能省的规矩：
//   ① 同插件同命令的多个格**合并成一次调用**——主机六格共用一次 stats，不是六次。
//   ② `document.hidden` 时全停——否则后台标签页每 3 秒起一堆子进程。
//   ③ 一个 provider 崩了只熄它那几格：超时 1s、连续失败 3 次熄灯并退避到 60s。
//      宿主**永远不 await 插件来渲染第一帧**，条先画出来，格子有值了再填。

import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { groupRefreshMs, groupSources, readPath, type PluginSource } from './status-registry'
import { formatRatio, type CellValue } from './status-cells'

const CALL_TIMEOUT_MS = 1000
const FAIL_BLACKOUT = 3
const BLACKOUT_MS = 60_000
/** 超过 STALE_FACTOR × refresh 没拿到新值就判过期：变暗置 `--`，不留最后一帧 */
const STALE_FACTOR = 3

type GroupState = { fails: number; blackUntil: number; lastOk: number }

async function runCommand(pluginId: string, command: string): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    const r = await api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`,
      { command, args: {} }, { signal: ctrl.signal })
    return r?.data ?? r
  } finally {
    clearTimeout(timer)
  }
}

/** 把一次快照按各格声明的 path 摊成值。取不到 → missing，整格不渲染 */
export function extract(group: PluginSource[], snapshot: any): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  for (const s of group) {
    const raw = s.path ? readPath(snapshot, s.path) : undefined
    const text = s.textPath ? readPath(snapshot, s.textPath) : undefined
    const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    if (num == null && typeof text !== 'string') { out[s.cellId] = { missing: true }; continue }
    // 「已用/总量」：一个百分比说不出还剩多少，而那才是你要的数
    if (s.unit === 'bytesRatio' && s.totalPath && num != null) {
      const total = readPath(snapshot, s.totalPath)
      if (typeof total === 'number' && total > 0) {
        out[s.cellId] = { value: num, pct: (num / total) * 100, text: formatRatio(num, total) }
        continue
      }
    }
    out[s.cellId] = { value: num, text: typeof text === 'string' ? text : undefined }
  }
  return out
}

/**
 * 订阅所有插件格的值。返回 `cellId → CellValue`。
 *
 * `sources` 每次渲染都是新数组，所以内部按内容签名判是否真的变了——
 * 否则每帧重建定时器，插件会被以渲染频率调用。
 */
export function usePluginValues(sources: PluginSource[]): Record<string, CellValue> {
  const [values, setValues] = useState<Record<string, CellValue>>({})
  const sig = sources.map((s) => `${s.pluginId}|${s.command}|${s.refreshMs}|${s.path}|${s.textPath}`).sort().join('\n')
  const latest = useRef(sources)
  latest.current = sources

  useEffect(() => {
    if (!latest.current.length) { setValues({}); return }
    const groups = groupSources(latest.current)
    const state = new Map<string, GroupState>()
    const timers: ReturnType<typeof setInterval>[] = []
    let stopped = false

    const tick = async (key: string, group: PluginSource[]) => {
      if (stopped || document.hidden) return
      const st = state.get(key) ?? { fails: 0, blackUntil: 0, lastOk: 0 }
      state.set(key, st)
      if (Date.now() < st.blackUntil) return
      try {
        const snap = await runCommand(group[0].pluginId, group[0].command)
        if (stopped) return
        st.fails = 0
        st.lastOk = Date.now()
        setValues((prev) => ({ ...prev, ...extract(group, snap) }))
      } catch {
        if (stopped) return
        st.fails += 1
        if (st.fails >= FAIL_BLACKOUT) {
          // 熄灯：这几格从条上消失，其余的格照常。插件死了条不动
          st.blackUntil = Date.now() + BLACKOUT_MS
          st.fails = 0
          setValues((prev) => {
            const next = { ...prev }
            for (const s of group) next[s.cellId] = { missing: true }
            return next
          })
        }
      }
    }

    // 过期检查独立于拉取：命令一直超时的时候 tick 不会回来改值，
    // 但条上那个数字必须自己变暗，不能停在最后一帧假装一切正常。
    const staleTimer = setInterval(() => {
      if (stopped) return
      setValues((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [key, group] of groups) {
          const st = state.get(key)
          if (!st?.lastOk) continue
          if (Date.now() - st.lastOk <= groupRefreshMs(group) * STALE_FACTOR) continue
          for (const s of group) {
            if (next[s.cellId] && !next[s.cellId].stale) {
              next[s.cellId] = { ...next[s.cellId], stale: true }
              changed = true
            }
          }
        }
        return changed ? next : prev
      })
    }, 2000)

    const start = () => {
      for (const [key, group] of groups) {
        void tick(key, group)
        timers.push(setInterval(() => void tick(key, group), groupRefreshMs(group)))
      }
    }
    const stopTimers = () => { timers.splice(0).forEach(clearInterval) }
    const onVisibility = () => {
      if (document.hidden) stopTimers()
      else if (!timers.length) start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearInterval(staleTimer)
      stopTimers()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sig])

  return values
}
