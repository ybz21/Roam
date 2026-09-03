// 左栏项目树的读模型：项目 → 任务（worktree）→ 会话（22 设计 §3.2）。
//
// 三条现成接口合成，没有新接口：
//   /projects            项目、每项目「需要你」的会话（needs）与最近会话（top）
//   /git/worktrees?dir=  每个 git 项目的 worktree 与挂在上面的会话
//   /sessions            全部会话（散会话从这里来：不在任何 worktree 上的）
// 纯函数：App 把三份数据拿到手后 useMemo 一次，数据没变就不重算。
import { taskKeyOf, type TaskKey } from '../sessions/task-key'

export type TreeSession = {
  name: string
  label: string
  agent?: 'claude' | 'codex'
  running?: boolean
  waiting?: boolean
}

export type TreeTask = {
  key: TaskKey
  /** 任务名：第一个会话的展示名，没有会话就用分支名 */
  name: string
  branch: string
  path: string
  /** 领先 base 的提交数；会话都关了还有未合并提交 = 待收尾 */
  ahead: number
  unfinished: boolean
  /** 没会话也没未合并提交：树里折进「还有 N 个空闲 worktree」，别一排灰点占满 */
  idle: boolean
  sessions: TreeSession[]
}

export type TreeProject = { key: string; name: string; dir: string; needs: number; tasks: TreeTask[] }

export type TaskTree = { projects: TreeProject[]; loose: TreeSession[] }

type ProjIn = {
  key: string; name: string; dir: string; git: boolean
  waiting?: number; unfinished?: number
  top?: { name: string; label?: string; running?: boolean; waiting?: boolean; agent?: 'claude' | 'codex' }[] | null
  needs?: { name: string; label?: string; running?: boolean; waiting?: boolean; agent?: 'claude' | 'codex' }[] | null
}
type WtIn = { path: string; branch: string; isMain: boolean; committedAhead?: number; sessions?: { session: string }[] | null }
type SessIn = { name: string; label?: string }

export function buildTaskTree(o: {
  projects: ProjIn[]
  /** 项目 key → 该项目的 worktree 列表 */
  worktrees: Record<string, WtIn[]>
  sessions: SessIn[]
  /** 已打开会话里探测到的 agent（比 /projects 的 top 名单准、也更新） */
  agentOf?: (name: string) => 'claude' | 'codex' | undefined
  /** 会话归属表（/sessions/annotations，15s 一轮）：会话 → 项目 key + worktree 路径 */
  placement?: Record<string, { key: string; worktree?: string; branch?: string }>
}): TaskTree {
  // 会话的展示信息：先从 /projects 的 top / needs 里捞（带 agent / running / waiting），再补 /sessions 的 label
  const info = new Map<string, TreeSession>()
  const put = (s: { name: string; label?: string; running?: boolean; waiting?: boolean; agent?: 'claude' | 'codex' }) => {
    const cur = info.get(s.name) || { name: s.name, label: s.label || s.name }
    info.set(s.name, {
      ...cur,
      label: s.label || cur.label,
      agent: s.agent || cur.agent,
      running: s.running ?? cur.running,
      waiting: s.waiting ?? cur.waiting,
    })
  }
  for (const p of o.projects) {
    for (const s of p.top || []) put(s)
    for (const s of p.needs || []) put(s)
  }
  for (const s of o.sessions) put(s)
  const sess = (name: string): TreeSession => {
    const s = info.get(name) || { name, label: name }
    const agent = o.agentOf?.(name) || s.agent
    return agent ? { ...s, agent } : s
  }

  const placed = new Set<string>()
  const projects: TreeProject[] = o.projects.map((p) => {
    const tasks: TreeTask[] = []
    for (const wt of o.worktrees[p.key] || []) {
      if (wt.isMain) continue // 主仓库不是任务位：里面的会话归散会话（D4）
      const names = (wt.sessions || []).map((s) => s.session).filter(Boolean)
      names.forEach((n) => placed.add(n))
      const sessions = names.map(sess)
      const ahead = wt.committedAhead || 0
      tasks.push({
        key: taskKeyOf('', wt.path),
        name: sessions[0]?.label || wt.branch || wt.path.split('/').pop() || wt.path,
        branch: wt.branch || '',
        path: wt.path,
        ahead,
        unfinished: sessions.length === 0 && ahead > 0,
        idle: sessions.length === 0 && ahead === 0,
        sessions,
      })
    }
    // 刚建的会话：worktree 轮询 60s 一轮还没追上，但 annotation 已经知道它在哪个 worktree——
    // 先按 annotation 立一个任务位，别让它在「散会话」里闪一下、一分钟后再跳到项目下
    const root = p.dir.replace(/\/+$/, '')
    for (const s of o.sessions) {
      if (placed.has(s.name)) continue
      const pl = o.placement?.[s.name]
      const wt = pl?.worktree?.replace(/\/+$/, '')
      if (!pl || pl.key !== p.key || !wt || wt === root) continue // 主仓库不是任务位
      placed.add(s.name)
      const hit = tasks.find((x) => x.path.replace(/\/+$/, '') === wt)
      if (hit) {
        hit.sessions.push(sess(s.name))
        hit.name = hit.sessions[0].label
        hit.unfinished = false; hit.idle = false
        continue
      }
      const ss = [sess(s.name)]
      tasks.push({ key: taskKeyOf('', wt), name: ss[0].label, branch: pl.branch || '', path: wt, ahead: 0, unfinished: false, idle: false, sessions: ss })
    }
    return { key: p.key, name: p.name, dir: p.dir, needs: (p.waiting || 0) + (p.unfinished || 0), tasks }
  })

  const loose = o.sessions.filter((s) => !placed.has(s.name)).map((s) => sess(s.name))
  return { projects, loose }
}
