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
import { relTime } from '../../time-format'
import { AgentLogo, ChevronDown, MoreIcon, PlusIcon, TerminalIcon } from '../../icons'
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

export function ProjectTree({ tree, activeTask, activeSession, onProject, onTask, onSession, onAddProject, onRename, onRenameTask, onNewTask, onKill, onFinishTask, onNewInTask, onRemoveProject }: {
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
  /** 项目行「…」菜单里的「移除项目」（只动台账，不动目录和会话） */
  onRemoveProject?: (key: string) => void
}) {
  const { t } = useI18n()
  const [closed, setClosed] = useState<Set<string>>(readClosed)
  // 「显示空闲 worktree」：没会话的 worktree 平时不进树（Orca 的 hidden worktrees），从「…」菜单打开才列出来；纯视图态
  const [showIdle, setShowIdle] = useState<Set<string>>(() => new Set())
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
        <span className="ic">{s.agent ? <AgentLogo kind={s.agent} size={15} /> : <TerminalIcon size={15} />}</span>
        <span className="nm">{s.label}</span>
        {dot(s, false)}
        {s.at ? <span className="tm">{relTime(s.at, t)}</span> : null}
      </button>
    </Dropdown>
  )

  // 任务是一张卡（参照 Orca 的侧栏）：名字一行、分支一行（淡、等宽）、「N 个会话」折叠头、会话行带时间；
  // 收起时只剩一枚「✳ +N ›」。lvl 只在散会话那组用（它们没有卡）
  const taskRows = (task: TreeTask, _lvl: 1 | 2 = 1) => {
    const on = activeTask === task.key
    const many = task.sessions.length > 1
    const open = !many || !closed.has(task.key)
    const running = task.sessions.some((s) => s.running)
    const waiting = task.sessions.some((s) => s.waiting)
    const hasActive = task.sessions.some((s) => s.name === activeSession)
    const agents = task.sessions.filter((s) => s.agent)
    return (
      <div key={task.key} className={`tt-tree-task${on ? ' on' : ''}`}>
        <Dropdown trigger={['contextMenu']} menu={taskMenu(task)}>
        <button type="button" className={`tt-nav-item tt-tree-row head${on && !hasActive ? ' on' : ''}`}
          onClick={() => onTask(task.key)} title={task.path}
          onDoubleClick={onRenameTask && !isLooseTask(task.key) ? () => onRenameTask(task.key, task.name) : undefined}>
          <span className="ic">{dot({ running, waiting, unfinished: task.unfinished }, true)}</span>
          <span className="nm">{task.name}</span>
          {task.unfinished && <span className="bd" title={t('tree.unfinished', { n: task.ahead })}>{t('tree.unfinishedShort', { n: task.ahead })}</span>}
        </button>
        </Dropdown>
        {task.branch && (
          <div className="tt-tree-branch" title={task.path}>
            <span className="br">{task.branch}</span>
            {task.merged
              ? <span className="st ok">{t('tree.merged')}</span>
              : task.ahead > 0 && <span className="st">{t('tree.aheadN', { n: task.ahead })}{task.pushed ? ` · ${t('tree.pushed')}` : ''}</span>}
            {!!task.dirty && <span className="st warn">{t('tree.dirtyN', { n: task.dirty })}</span>}
            {!!task.behind && <span className="st">{t('tree.behindN', { n: task.behind })}</span>}
          </div>
        )}
        {many && (
          <button type="button" className={`tt-tree-agents${open ? '' : ' closed'}`} onClick={() => toggle(task.key)}
            aria-expanded={open} aria-label={open ? t('common.collapse') : t('common.expand')}>
            <span className="nm">{t('tree.sessionsN', { n: task.sessions.length })}</span>
            <span className="chev"><ChevronDown size={13} /></span>
          </button>
        )}
        {open
          ? <div className="tt-tree-sessions">{task.sessions.map((s) => sessionRow(task.key, s, 2))}</div>
          : (
            <button type="button" className="tt-tree-more" onClick={() => toggle(task.key)} title={t('common.expand')}>
              {agents[0] ? <AgentLogo kind={agents[0].agent!} size={13} /> : <TerminalIcon size={13} />}
              <span>+{task.sessions.length}</span>
              <span className="chev"><ChevronDown size={12} /></span>
            </button>
          )}
      </div>
    )
  }

  // 空闲 / 待收尾的 worktree：淡一档的卡，没有会话行；右键（或「…」）能派生、收尾
  const idleCard = (task: TreeTask) => (
    <div key={task.key} className="tt-tree-task idle">
      <Dropdown trigger={['contextMenu']} menu={taskMenu(task)}>
      <button type="button" className="tt-nav-item tt-tree-row head" onClick={() => onTask(task.key)} title={task.path}>
        <span className="ic">{dot({ unfinished: task.unfinished }, true)}</span>
        <span className="nm">{task.name}</span>
        <span className="bd">{task.unfinished ? t('tree.unfinishedShort', { n: task.ahead }) : t('tree.idle')}</span>
      </button>
      </Dropdown>
      {task.branch && <div className="tt-tree-branch"><span className="br">{task.branch}</span>{task.merged && <span className="st ok">{t('tree.merged')}</span>}</div>}
    </div>
  )

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
        const idle = p.tasks.filter((x) => x.sessions.length === 0)
        return (
          <div key={p.key} className="tt-tree-proj">
            {/* 项目的身份就是项目卡上那枚按名字取色的首字母圆标（icoOf），不另画图标 */}
            {/* 项目行右端照 Orca：[…] 菜单 · [+] 开任务 · [˅] 折叠，都是看得见的按钮，不靠右键 */}
            <button type="button" className={`tt-nav-item tt-tree-row proj${open ? '' : ' closed'}`} title={p.dir} onClick={() => onProject(p.key)}>
              <span className="ic"><span className="av" style={{ color: icoOf(p.key)[0], background: icoOf(p.key)[1] }}>{p.name.slice(0, 1).toUpperCase()}</span></span>
              <span className="nm">{p.name}</span>
              {p.needs > 0 && <span className="bd">{p.needs}</span>}
              <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: [
                { key: 'home', label: t('tree.menu.projectHome'), onClick: () => onProject(p.key) },
                { key: 'idle', label: showIdle.has(p.key) ? t('tree.menu.hideIdle') : t('tree.menu.showIdle', { n: idle.length }), disabled: !idle.length && !showIdle.has(p.key),
                  onClick: () => setShowIdle((cur) => { const next = new Set(cur); if (next.has(p.key)) next.delete(p.key); else next.add(p.key); return next }) },
                ...(onRemoveProject ? [{ type: 'divider' as const }, { key: 'remove', label: t('project.remove'), danger: true, onClick: () => onRemoveProject(p.key) }] : []),
              ] }}>
                <span className="act" role="button" aria-label={t('common.more')} onClick={(e) => e.stopPropagation()}><MoreIcon size={14} /></span>
              </Dropdown>
              {onNewTask && (
                <span className="act" role="button" aria-label={t('tree.menu.newTask')} title={t('tree.menu.newTask')}
                  onClick={(e) => { e.stopPropagation(); onNewTask(p.dir) }}><PlusIcon size={13} /></span>
              )}
              <span className="chev" role="button" aria-label={open ? t('common.collapse') : t('common.expand')}
                onClick={(e) => { e.stopPropagation(); toggle(p.key) }}><ChevronDown size={14} /></span>
            </button>
            {open && (
              <>
                {live.map((x) => taskRows(x, 1))}
                {showIdle.has(p.key) && idle.map((x) => idleCard(x))}
                {!live.length && !showIdle.has(p.key) && <div className="tt-tree-empty">{t('tree.noTasks')}</div>}
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
