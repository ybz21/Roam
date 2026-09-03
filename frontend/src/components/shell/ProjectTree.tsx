// 左栏项目树：项目 → 任务（worktree）→ 会话（22 设计 §3.2）。
//
// 它同时是导航和任务列表：点任务进任务视图，点会话进任务视图并打开那个会话，点项目名回项目主页。
// 任务行与它下面的会话行是**一整块**（.tt-tree-grp）：选中时淡蓝底和左侧竖条盖整组，
// 不是两个错开的圆角块（原型评审时被指出「不连贯」的那一版就是分开画的）。
// 任务行只有任务名和徽标，**分支不进列表**——每个任务一条 feat/… 堆成一列只会乱，分支在状态条。
import { useState, type ReactNode } from 'react'
import { Tooltip } from 'antd'
import { useI18n } from '../../i18n'
import { AgentLogo, ChevronDown, PlusIcon, TerminalIcon } from '../../icons'
import { isLooseTask, taskKeyOf, type TaskKey } from '../sessions/task-key'
import type { TaskTree, TreeSession, TreeTask } from './task-tree'

const OPEN_KEY = 'roam.tree.closed'

/** 折叠态记本机：默认全展开，只记「收起了哪些项目」，新项目一出现就是展开的 */
function readClosed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch { return new Set() }
}
function writeClosed(s: Set<string>) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...s])) } catch { /* 记不住而已 */ }
}

function dotTone(t: { running?: boolean; waiting?: boolean; unfinished?: boolean }): string {
  if (t.waiting) return 'wait'
  if (t.running) return 'run'
  if (t.unfinished) return 'fin'
  return 'idle'
}

export function ProjectTree({ tree, activeTask, activeSession, onProject, onTask, onSession, onAddProject }: {
  tree: TaskTree
  activeTask: TaskKey | null
  /** 当前标签是哪个会话：它所在的会话行再铺一层底 */
  activeSession: string | null
  onProject: (key: string) => void
  onTask: (key: TaskKey) => void
  onSession: (key: TaskKey, name: string) => void
  onAddProject?: () => void
}) {
  const { t } = useI18n()
  const [closed, setClosed] = useState<Set<string>>(readClosed)
  const toggle = (key: string) => setClosed((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key); else next.add(key)
    writeClosed(next)
    return next
  })

  const sessionRow = (task: TaskKey, s: TreeSession, extra?: ReactNode) => (
    <button key={s.name} type="button"
      className={`tt-tree-sess${activeTask === task && activeSession === s.name ? ' on' : ''}`}
      onClick={() => onSession(task, s.name)} title={s.name}>
      <span className="ic">{s.agent ? <AgentLogo kind={s.agent} size={14} /> : <TerminalIcon size={14} />}</span>
      <span className="nm">{s.label}</span>
      <i className={`dot ${dotTone(s)}`} />
      {extra}
    </button>
  )

  const taskGroup = (task: TreeTask) => {
    const on = activeTask === task.key
    const running = task.sessions.some((s) => s.running)
    const waiting = task.sessions.some((s) => s.waiting)
    return (
      <div key={task.key} className={`tt-tree-grp${on ? ' on' : ''}`}>
        <button type="button" className="tt-tree-task" onClick={() => onTask(task.key)} title={task.path}>
          <i className={`dot ${dotTone({ running, waiting, unfinished: task.unfinished })}`} />
          <span className="nm">{task.name}</span>
          {task.unfinished && <span className="bd warn">{t('tree.unfinished', { n: task.ahead })}</span>}
        </button>
        {task.sessions.map((s) => sessionRow(task.key, s))}
      </div>
    )
  }

  return (
    <div className="tt-tree">
      <div className="tt-tree-head">
        <span className="gl">{t('nav.projects')}</span>
        {onAddProject && (
          <Tooltip title={t('tree.addProject')} placement="right">
            <button type="button" className="tt-act ico" onClick={onAddProject} aria-label={t('tree.addProject')}><PlusIcon size={13} /></button>
          </Tooltip>
        )}
      </div>

      {tree.projects.map((p) => {
        const open = !closed.has(p.key)
        return (
          <div key={p.key} className="tt-tree-proj">
            <div className="tt-tree-projrow">
              <button type="button" className={`chev${open ? '' : ' closed'}`} onClick={() => toggle(p.key)}
                aria-label={open ? t('common.collapse') : t('common.expand')} aria-expanded={open}>
                <ChevronDown size={13} />
              </button>
              <button type="button" className="nm" onClick={() => onProject(p.key)} title={p.dir}>
                <span className="av">{p.name.slice(0, 2).toUpperCase()}</span>
                <span className="tx">{p.name}</span>
                {p.needs > 0 && <span className="bd">{p.needs}</span>}
              </button>
            </div>
            {open && (p.tasks.length
              ? p.tasks.map(taskGroup)
              : <div className="tt-tree-empty">{t('tree.noTasks')}</div>)}
          </div>
        )
      })}

      {tree.loose.length > 0 && (
        <div className="tt-tree-proj loose">
          <div className="tt-tree-head"><span className="gl">{t('tree.loose')}</span></div>
          {tree.loose.map((s) => {
            const key = taskKeyOf(s.name)
            return (
              <div key={s.name} className={`tt-tree-grp${activeTask === key ? ' on' : ''}`}>
                {sessionRow(key, s)}
              </div>
            )
          })}
        </div>
      )}

      {!tree.projects.length && !tree.loose.length && (
        <div className="tt-tree-empty">{t('tree.empty')}</div>
      )}
    </div>
  )
}

/** 树里当前任务的第一个会话名（切任务时没有已开标签就打开它） */
export function firstSessionOf(tree: TaskTree, key: TaskKey): string | null {
  if (isLooseTask(key)) return key.slice('loose:'.length)
  for (const p of tree.projects) for (const task of p.tasks) if (task.key === key) return task.sessions[0]?.name || null
  return null
}

/** 任务的 worktree 路径（散会话没有） */
export function taskPathOf(tree: TaskTree, key: TaskKey): string | null {
  if (isLooseTask(key)) return null
  for (const p of tree.projects) for (const task of p.tasks) if (task.key === key) return task.path
  return null
}
