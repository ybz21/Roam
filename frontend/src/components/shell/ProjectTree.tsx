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
  // 「还有 N 个空闲 worktree」展开了哪些项目的：纯视图态，不记
  const [idleOpen, setIdleOpen] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) => setClosed((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key); else next.add(key)
    writeClosed(next)
    return next
  })
  const toggleIdle = (key: string) => setIdleOpen((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // 每一行都是侧栏那枚 .tt-nav-item：同样的高、图标槽、hover、选中的左线 + 淡蓝底、同一款计数徽标。
  // 区别只有缩进（lvl1 / lvl2）和图标槽里放什么：项目放文件夹，任务放状态点，会话放 agent 标。
  const sessionRow = (task: TaskKey, s: TreeSession, lvl: 1 | 2) => (
    <button key={s.name} type="button"
      className={`tt-nav-item tt-tree-row lvl${lvl}${activeTask === task && activeSession === s.name ? ' on' : ''}`}
      onClick={() => onSession(task, s.name)} title={s.name}
      aria-current={activeTask === task && activeSession === s.name ? 'true' : undefined}>
      <span className="ic">{s.agent ? <AgentLogo kind={s.agent} size={16} /> : <TerminalIcon size={16} />}</span>
      <span className="nm">{s.label}</span>
      {dot(s, false)}
    </button>
  )

  const taskRows = (task: TreeTask) => {
    const on = activeTask === task.key
    const running = task.sessions.some((s) => s.running)
    const waiting = task.sessions.some((s) => s.waiting)
    return (
      <div key={task.key} className="tt-tree-task">
        <button type="button" className={`tt-nav-item tt-tree-row lvl1${on && !task.sessions.some((s) => s.name === activeSession) ? ' on' : ''}`}
          onClick={() => onTask(task.key)} title={task.path}>
          <span className="ic">{dot({ running, waiting, unfinished: task.unfinished }, true)}</span>
          <span className="nm">{task.name}</span>
          {task.unfinished && <span className="bd" title={t('tree.unfinished', { n: task.ahead })}>{t('tree.unfinishedShort', { n: task.ahead })}</span>}
        </button>
        {task.sessions.map((s) => sessionRow(task.key, s, 2))}
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
        // 三档：有会话的任务直接列；会话已关但还有未合并提交的折进「待收尾 N」；
        // 既没会话也没提交的折进「空闲 worktree N」——后两种是 worktree 不是活着的任务，
        // 和正在干的活混排在一起，树就成了 git worktree list
        const live = p.tasks.filter((x) => x.sessions.length > 0)
        const unfinished = p.tasks.filter((x) => x.unfinished)
        const idle = p.tasks.filter((x) => x.idle)
        const showUnfinished = idleOpen.has(p.key + ':fin')
        const showIdle = idleOpen.has(p.key)
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
                {live.map(taskRows)}
                {unfinished.length > 0 && (
                  <button type="button" className={`tt-nav-item tt-tree-row lvl1 more${showUnfinished ? '' : ' closed'}`} onClick={() => toggleIdle(p.key + ':fin')}>
                    <span className="ic chev"><ChevronDown size={13} /></span>
                    <span className="nm">{t('tree.unfinishedN', { n: unfinished.length })}</span>
                  </button>
                )}
                {showUnfinished && unfinished.map(taskRows)}
                {idle.length > 0 && (
                  <button type="button" className={`tt-nav-item tt-tree-row lvl1 more${showIdle ? '' : ' closed'}`} onClick={() => toggleIdle(p.key)}>
                    <span className="ic chev"><ChevronDown size={13} /></span>
                    <span className="nm">{t('tree.idleN', { n: idle.length })}</span>
                  </button>
                )}
                {showIdle && idle.map(taskRows)}
                {!p.tasks.length && <div className="tt-tree-empty">{t('tree.noTasks')}</div>}
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
