// 插件格的取值：按声明的 refresh 调 `POST /plugins/<id>/run`，从返回的 JSON 里取值。
// 设计见 docs/design/web/20-status-bar/index.html §05「拉与推」/ §12。
//
// 三条不能省的规矩：
//   ① 同插件同命令的多个格**合并成一次调用**——主机六格共用一次 stats，不是六次。
//   ② `document.hidden` 时全停——否则后台标签页每 3 秒起一堆子进程。
//   ③ 一个 provider 崩了只熄它那几格：一帧的超时预算、连续失败 3 次熄灯并退避到 60s。
//      宿主**永远不 await 插件来渲染第一帧**，条先画出来，格子有值了再填。

import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { groupRefreshMs, groupSources, readPath, type PluginSource } from './status-registry'
import { formatRatio, type CellValue } from './status-cells'

const FAIL_BLACKOUT = 3
const BLACKOUT_MS = 60_000
/** 超过 STALE_FACTOR × refresh 没拿到新值就判过期：变暗置 `--`，不留最后一帧 */
const STALE_FACTOR = 3
/** 定时器比约定时刻晚这么多，就认定刚才主线程被占着，这一轮不算插件的账 */
const JANK_MS = 250
/** 顺延次数上限：真挂住的插件不能靠页面一直卡着无限续命 */
const MAX_EXTEND = 3

type GroupState = { fails: number; blackUntil: number; lastOk: number; busy: boolean }

/**
 * 到点掐掉这次调用，但**主线程被占住的那段不算数**。
 *
 * 超时是墙上时间量的，请求的收尾却要排在主线程上：上面的编辑器/终端一次重渲染
 * 占住主线程一秒多，服务端 100ms 就答完的调用照样判超时。真机 Chrome 里量过——
 * 发出请求后阻塞主线程 2s，连发三次全是 `AbortError`，而三次就够熄灯一分钟。
 * 这也是「监控总在上面刚渲染完的时候没了」那种感觉的来处。
 *
 * 判据就是定时器自己：它比约定的时刻晚到多久，就是刚才主线程卡了多久。晚得离谱
 * 就重新计时，把一整段「线程真的能干活」的时间还给这次调用。
 */
export function budgetedAbort(budgetMs: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController()
  let due = Date.now() + budgetMs
  let extended = 0
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    timer = setTimeout(() => {
      if (Date.now() - due > JANK_MS && extended++ < MAX_EXTEND) {
        due = Date.now() + budgetMs
        arm()
        return
      }
      ctrl.abort()
    }, Math.max(0, due - Date.now()))
  }
  arm()
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

/**
 * 一次调用的预算就是**这一帧**（该组的 refresh，≥2s）：到点还没回来，这个数字下一轮
 * 就会被新的取代，留着等没有意义。
 *
 * 原来钉死 1s，而这条路上 `plugin run` 每次起一个子进程——机器忙起来（编译、几个 agent
 * 会话、swap 在换页）1s 根本不够 fork+exec 加采样。而且慢一次不是慢一次：三次超时就熄灯
 * 60s，退避结束后再探一次照样慢、照样熄，于是**监控格一整场都不出现**。量过：把后端那次
 * 调用钉在 1.2s，条上右半六格全没，只剩「当前设备」和版本号——正是用户截图里的样子。
 */
async function runCommand(pluginId: string, command: string, budgetMs: number): Promise<any> {
  const { signal, clear } = budgetedAbort(budgetMs)
  try {
    const r = await api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`,
      { command, args: {} }, { signal })
    return r?.data ?? r
  } finally {
    clear()
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
      const st = state.get(key) ?? { fails: 0, blackUntil: 0, lastOk: 0, busy: false }
      state.set(key, st)
      // 上一轮还没回来就别再发：主线程一卡，堆起来的只是同一个插件的一串子进程
      if (st.busy || Date.now() < st.blackUntil) return
      st.busy = true
      try {
        const snap = await runCommand(group[0].pluginId, group[0].command, groupRefreshMs(group))
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
      } finally {
        st.busy = false
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
