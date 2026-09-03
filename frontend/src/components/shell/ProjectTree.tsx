// 左栏项目树：项目 → 任务（worktree）→ 会话（22 设计 §3.2）。
//
// 塞在导航组下面原来空着的那段，侧栏别的一切照旧；树只借侧栏的语言（圆角、hover 底、
// 3px 左线 + 淡蓝底的选中态）。它同时是导航和任务列表：点任务进任务视图，点会话进任务视图并
// 打开那个会话，点项目名回项目主页。
//
// 两条让它不吵的规矩：
//   · 任务行与它下面的会话行是**一整块**，选中盖整组，不是两个错开的圆角块；
//   · 没会话也没未合并提交的 worktree 折进「还有 N 个空闲 worktree」一行——真实项目里这种
//     一抓一把，全铺出来就是一列灰点加一列被截断的分支名。
import { useState, type ReactNode } from 'react'
import { Tooltip } from 'antd'
import { useI18n } from '../../i18n'
import { AgentLogo, ChevronDown, PlusIcon, TerminalIcon } from '../../icons'
import { icoOf } from '../projects/project-list/project-model'
import { isLooseTask, taskKeyOf, type TaskKey } from '../sessions/task-key'
import type { TaskTree, TreeSession, TreeTask } from './task-tree'

const CLOSED_KEY = 'roam.tree.closed'

/** 折叠态记本机：默认全展开，只记「收起了哪些项目」，新项目一出现就是展开的 */
function readClosed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch { return new Set() }
}
function writeClosed(s: Set<string>) {
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...s])) } catch { /* 记不住而已 */ }
}

/** 状态点：运行 / 等你 / 待收尾 才画；空闲只在任务行画一枚很淡的占位点，会话行不画 */
function dot(o: { running?: boolean; waiting?: boolean; unfinished?: boolean }, idlePlaceholder: boolean): ReactNode {
  const tone = o.waiting ? 'wait' : o.running ? 'run' : o.unfinished ? 'fin' : ''
  if (tone) return <i className={`dot ${tone}`} />
  return idlePlaceholder ? <i className="dot idle" /> : null
}

export function ProjectTree({ tree, activeTask, activeSession, onProject, onTask, onSession, onAddProject, onRename }: {
  tree: TaskTree
  activeTask: TaskKey | null
  /** 当前标签是哪个会话：它所在的会话行再铺一层底 */
  activeSession: string | null
  onProject: (key: string) => void
  onTask: (key: TaskKey) => void
  onSession: (key: TaskKey, name: string) => void
  onAddProject?: () => void
  /** 双击 / 右键任务行或会话行：改展示名。任务名就是第一个会话的展示名，所以改的都是会话 */
  onRename?: (session: string) => void
}) {
  const { t } = useI18n()
  const [closed, setClosed] = useState<Set<string>>(readClosed)
  const toggle = (key: string) => setClosed((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key); else next.add(key)
    writeClosed(next)
    return next
  })

  // 每一行都是侧栏那枚 .tt-nav-item：同样的高、图标槽、hover、选中的左线 + 淡蓝底、同一款计数徽标。
  // 区别只有缩进（lvl1 / lvl2）和图标槽里放什么：项目放文件夹，任务放状态点，会话放 agent 标。
  const rename = (session?: string) => onRename && session
    ? { onDoubleClick: () => onRename(session), onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onRename(session) } }
    : {}
  const sessionRow = (task: TaskKey, s: TreeSession, lvl: 1 | 2 | 3) => (
    <button key={s.name} type="button"
      className={`tt-nav-item tt-tree-row lvl${lvl}${activeTask === task && activeSession === s.name ? ' on' : ''}`}
      onClick={() => onSession(task, s.name)} title={s.name} {...rename(s.name)}
      aria-current={activeTask === task && activeSession === s.name ? 'true' : undefined}>
      <span className="ic">{s.agent ? <AgentLogo kind={s.agent} size={16} /> : <TerminalIcon size={16} />}</span>
      <span className="nm">{s.label}</span>
      {dot(s, false)}
    </button>
  )

  // lvl：直接列出的任务是 1，从「待收尾 / 空闲」折叠行里展开的是 2，它们的会话再深一级
  const taskRows = (task: TreeTask, lvl: 1 | 2 = 1) => {
    const on = activeTask === task.key
    const running = task.sessions.some((s) => s.running)
    const waiting = task.sessions.some((s) => s.waiting)
    return (
      <div key={task.key} className="tt-tree-task">
        <button type="button" className={`tt-nav-item tt-tree-row lvl${lvl}${on && !task.sessions.some((s) => s.name === activeSession) ? ' on' : ''}`}
          onClick={() => onTask(task.key)} title={task.path} {...rename(task.sessions[0]?.name)}>
          <span className="ic">{dot({ running, waiting, unfinished: task.unfinished }, true)}</span>
          <span className="nm">{task.name}</span>
          {task.unfinished && <span className="bd" title={t('tree.unfinished', { n: task.ahead })}>{t('tree.unfinishedShort', { n: task.ahead })}</span>}
        </button>
        {task.sessions.map((s) => sessionRow(task.key, s, lvl))}
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
        // 项目下只列**有会话的任务**。没会话的 worktree（待收尾 / 空闲）不进树：它们是 worktree
        // 不是活着的任务，用户记不住也不该在这里管——待收尾的数量在项目行徽标上，处理去右栏
        // Worktree 面板或项目主页
        const live = p.tasks.filter((x) => x.sessions.length > 0)
        return (
          <div key={p.key} className="tt-tree-proj">
            {/* 项目的身份就是项目卡上那枚按名字取色的首字母圆标（icoOf），不另画图标 */}
            <button type="button" className={`tt-nav-item tt-tree-row${open ? '' : ' closed'}`} title={p.dir} onClick={() => onProject(p.key)}>
              <span className="ic"><span className="av" style={{ color: icoOf(p.key)[0], background: icoOf(p.key)[1] }}>{p.name.slice(0, 1).toUpperCase()}</span></span>
              <span className="nm">{p.name}</span>
              {p.needs > 0 && <span className="bd">{p.needs}</span>}
              {/* 折叠箭头是行内第二个可点目标：点它只折不跳，点别处进项目主页 */}
              <span className="chev" role="button" aria-label={open ? t('common.collapse') : t('common.expand')}
                onClick={(e) => { e.stopPropagation(); toggle(p.key) }}><ChevronDown size={14} /></span>
            </button>
            {open && (
              <>
                {live.map((x) => taskRows(x, 1))}
                {!live.length && <div className="tt-tree-empty">{t('tree.noTasks')}</div>}
              </>
            )}
          </div>
        )
      })}

      {tree.loose.length > 0 && (
        <div className="tt-tree-proj loose">
          <div className="gl">{t('tree.loose')}</div>
          {tree.loose.map((s) => sessionRow(taskKeyOf(s.name), s, 1))}
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
