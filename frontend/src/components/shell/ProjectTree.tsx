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
import { Dropdown, Tooltip } from 'antd'
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

export function ProjectTree({ tree, activeTask, activeSession, onProject, onTask, onSession, onAddProject, onRename, onRenameTask, onNewTask, onKill, onFinishTask, onNewInTask }: {
  tree: TaskTree
  activeTask: TaskKey | null
  /** 当前标签是哪个会话：它所在的会话行再铺一层底 */
  activeSession: string | null
  onProject: (key: string) => void
  onTask: (key: TaskKey) => void
  onSession: (key: TaskKey, name: string) => void
  onAddProject?: () => void
  /** 双击 / 右键会话行：改会话展示名 */
  onRename?: (session: string) => void
  /** 双击 / 右键任务行：给任务起名（偏好 taskNames），不动会话和分支 */
  onRenameTask?: (key: TaskKey, name: string) => void
  /** 项目行右键「开新任务」：弹 composer，目录预设成这个项目、默认新建 worktree */
  onNewTask?: (dir: string) => void
  /** 右键会话行「关闭会话」：真的结束它（标签条的 × 只是收起标签） */
  onKill?: (session: string) => void
  /** 右键任务行「收尾」：关掉它的会话并处理 worktree */
  onFinishTask?: (task: TreeTask) => void
  /** 右键任务行：在它的 worktree 里派生一个终端 / Claude / Codex */
  onNewInTask?: (key: TaskKey, kind: 'shell' | 'claude' | 'codex') => void
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
  // 右键菜单：会话行 = 打开 / 重命名 / 关闭会话；任务行 = 起名 / 派生三样 / 收尾。
  // 标签条的 × 只是收起标签，会话还活着、树上还在——真要关，在这里
  const sessionMenu = (task: TaskKey, s: TreeSession) => ({ items: [
    { key: 'open', label: t('tree.menu.open'), onClick: () => onSession(task, s.name) },
    ...(onRename ? [{ key: 'rename', label: t('session.rename'), onClick: () => onRename(s.name) }] : []),
    ...(onKill ? [{ type: 'divider' as const }, { key: 'kill', label: t('tree.menu.close'), danger: true, onClick: () => onKill(s.name) }] : []),
  ] })
  const taskMenu = (task: TreeTask) => ({ items: [
    ...(onRenameTask && !isLooseTask(task.key) ? [{ key: 'name', label: t('tree.renameTask'), onClick: () => onRenameTask(task.key, task.name) }] : []),
    ...(onNewInTask ? [{ type: 'group' as const, label: t('tree.menu.deriveHere'), children: [
      { key: 'sh', icon: <TerminalIcon size={14} />, label: t('tabs.newTerminal'), onClick: () => onNewInTask(task.key, 'shell') },
      { key: 'cc', icon: <AgentLogo kind="claude" size={14} />, label: t('tabs.newClaude'), onClick: () => onNewInTask(task.key, 'claude') },
      { key: 'cx', icon: <AgentLogo kind="codex" size={14} />, label: t('tabs.newCodex'), onClick: () => onNewInTask(task.key, 'codex') },
    ] }] : []),
    ...(onFinishTask ? [{ type: 'divider' as const }, { key: 'finish', label: t('tree.menu.finish'), danger: true, onClick: () => onFinishTask(task) }] : []),
  ] })
  const sessionRow = (task: TaskKey, s: TreeSession, lvl: 1 | 2 | 3) => (
    <Dropdown key={s.name} trigger={['contextMenu']} menu={sessionMenu(task, s)}>
      <button type="button"
        className={`tt-nav-item tt-tree-row lvl${lvl}${activeTask === task && activeSession === s.name ? ' on' : ''}`}
        onClick={() => onSession(task, s.name)} title={s.name} onDoubleClick={onRename ? () => onRename(s.name) : undefined}
        aria-current={activeTask === task && activeSession === s.name ? 'true' : undefined}>
        <span className="ic">{s.agent ? <AgentLogo kind={s.agent} size={16} /> : <TerminalIcon size={16} />}</span>
        <span className="nm">{s.label}</span>
        {dot(s, false)}
      </button>
    </Dropdown>
  )

  // lvl：直接列出的任务是 1，从「待收尾 / 空闲」折叠行里展开的是 2，它们的会话再深一级
  const taskRows = (task: TreeTask, lvl: 1 | 2 = 1) => {
    const on = activeTask === task.key
    const open = task.sessions.length <= 1 || !closed.has(task.key)
    const running = task.sessions.some((s) => s.running)
    const waiting = task.sessions.some((s) => s.waiting)
    return (
      <div key={task.key} className="tt-tree-task">
        <Dropdown trigger={['contextMenu']} menu={taskMenu(task)}>
        <button type="button" className={`tt-nav-item tt-tree-row lvl${lvl}${on && !task.sessions.some((s) => s.name === activeSession) ? ' on' : ''}${open ? '' : ' closed'}`}
          onClick={() => onTask(task.key)} title={task.path}
          onDoubleClick={onRenameTask && !isLooseTask(task.key) ? () => onRenameTask(task.key, task.name) : undefined}>
          <span className="ic">{dot({ running, waiting, unfinished: task.unfinished }, true)}</span>
          <span className="nm">{task.name}</span>
          {task.unfinished && <span className="bd" title={t('tree.unfinished', { n: task.ahead })}>{t('tree.unfinishedShort', { n: task.ahead })}</span>}
          {/* 一个任务下开了一排 Claude 窗口时能收起来；收起时徽标写着里面有几个 */}
          {task.sessions.length > 1 && (
            <>
              {!open && <span className="bd">{task.sessions.length}</span>}
              <span className="chev" role="button" aria-label={open ? t('common.collapse') : t('common.expand')}
                onClick={(e) => { e.stopPropagation(); toggle(task.key) }}><ChevronDown size={14} /></span>
            </>
          )}
        </button>
        </Dropdown>
        {/* 会话缩进一级、左边一根从任务状态点垂下来的引线 + 每行一个小肘：谁派生自谁一眼看出来 */}
        {open && <div className="tt-tree-sessions">{task.sessions.map((s) => sessionRow(task.key, s, (lvl + 1) as 2 | 3))}</div>}
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
            {/* 项目行右键：开新任务（⌘N 同款）/ 项目主页——行里不放「+」，一排图标里多一枚没人认得 */}
            <Dropdown trigger={['contextMenu']} menu={{ items: [
              ...(onNewTask ? [{ key: 'new', icon: <PlusIcon size={13} />, label: t('tree.menu.newTask'), onClick: () => onNewTask(p.dir) }] : []),
              { key: 'home', label: t('tree.menu.projectHome'), onClick: () => onProject(p.key) },
            ] }}>
            <button type="button" className={`tt-nav-item tt-tree-row${open ? '' : ' closed'}`} title={p.dir} onClick={() => onProject(p.key)}>
              <span className="ic"><span className="av" style={{ color: icoOf(p.key)[0], background: icoOf(p.key)[1] }}>{p.name.slice(0, 1).toUpperCase()}</span></span>
              <span className="nm">{p.name}</span>
              {p.needs > 0 && <span className="bd">{p.needs}</span>}
              {/* 折叠箭头是行内第二个可点目标：点它只折不跳，点别处进项目主页 */}
              <span className="chev" role="button" aria-label={open ? t('common.collapse') : t('common.expand')}
                onClick={(e) => { e.stopPropagation(); toggle(p.key) }}><ChevronDown size={14} /></span>
            </button>
            </Dropdown>
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
