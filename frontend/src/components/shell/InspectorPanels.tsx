// 右栏：当前任务那个 worktree 的 文件 / Git / Worktree 三个面板（22 设计 §3.4）。
//
// 今天这三样各自往 Inspector 槽位栈里 claim 一份，只有栈顶可见——「文件」亮着露出来的却是 Git。
// 现在 App 只挂**这一个** AdaptivePanel：顶上活动条切面板，下面写着当前是哪个 worktree、哪条分支。
// 三个面板都挂着、只切 display——AdaptivePanel 文件头写过「是藏不是卸载」的账：卸载 Git 会连
// 它子树里的 Worktree 一起没了。槽位机制（inspector.ts / InspectorColumn）一行不改，只是栈里最多一个。
import { Suspense, type ReactNode } from 'react'
import { Spin, Tooltip } from 'antd'
import { useI18n } from '../../i18n'
import { FolderIcon } from '../../icons'
import { BranchIcon } from '../git/parts'
import FileBrowser from '../files/FileBrowser'
import AdaptivePanel from './AdaptivePanel'
import { lazyRetry } from '../lazy-retry'

const GitPanel = lazyRetry(() => import('../git/GitPanel'))
const WorktreePanel = lazyRetry(() => import('../git/WorktreePanel'))

export type InspectorPanelKind = 'files' | 'git' | 'worktree'

const gitIcon = (
  <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" />
    <path d="M6 8.2v7.6" /><path d="M8.2 6h3.3a4 4 0 0 1 4 4v.3" /><path d="M8.2 18h3.3a4 4 0 0 0 4-4v-.3" />
  </svg>
)
const worktreeIcon = (
  <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="4.8" r="2.2" /><circle cx="7" cy="19.2" r="2.2" /><circle cx="17" cy="19.2" r="2.2" />
    <path d="M12 7v2.6" /><path d="M12 9.6a4.4 4.4 0 0 0-5 4.4v3" /><path d="M12 9.6a4.4 4.4 0 0 1 5 4.4v3" />
  </svg>
)

export function InspectorPanels({ open, panel, onPanel, dir, scope, branch, openRequest, openTerm, onClose }: {
  open: boolean
  panel: InspectorPanelKind
  onPanel: (p: InspectorPanelKind) => void
  /** 当前任务的 worktree；散会话给它的工作目录 */
  dir: string
  /** 作用域头：「项目 · 任务名」 */
  scope: string
  branch?: string
  /** 对话里点了 Read/Edit 的路径：在文件面板里打开（nonce 让同一路径点第二次也响） */
  openRequest?: { path: string; line?: number; nonce: number }
  openTerm?: (name: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const acts: { key: InspectorPanelKind; label: string; icon: ReactNode }[] = [
    { key: 'files', label: t('nav.files'), icon: <FolderIcon size={17} /> },
    { key: 'git', label: t('git.title'), icon: gitIcon },
    { key: 'worktree', label: t('worktree.title'), icon: worktreeIcon },
  ]
  const fallback = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><Spin /></div>

  return (
    <AdaptivePanel open={open} layer="session" title={acts.find((a) => a.key === panel)?.label} onClose={onClose}>
      <div className="tt-ins">
        <div className="tt-ins-acts" role="tablist">
          {acts.map((a) => (
            <Tooltip key={a.key} title={a.label} placement="bottom">
              <button type="button" role="tab" aria-selected={panel === a.key} aria-label={a.label}
                className={`tt-ins-act${panel === a.key ? ' on' : ''}`} onClick={() => onPanel(a.key)}>{a.icon}</button>
            </Tooltip>
          ))}
        </div>
        <div className="tt-ins-scope" title={dir}>
          <span className="nm">{scope}</span>
          {branch && <span className="br"><BranchIcon size={12} />{branch}</span>}
        </div>
        {/* 三个面板都挂着，只切 display：树的展开态、Git 的选中都留着 */}
        <div className="tt-ins-body" style={{ display: panel === 'files' ? 'flex' : 'none' }}>
          <FileBrowser dir={dir} accent="var(--accent)" layout="dock" openRequest={openRequest} />
        </div>
        <div className="tt-ins-body" style={{ display: panel === 'git' ? 'flex' : 'none' }}>
          <Suspense fallback={fallback}><GitPanel dir={dir} accent="var(--accent)" openTerm={openTerm} /></Suspense>
        </div>
        <div className="tt-ins-body" style={{ display: panel === 'worktree' ? 'flex' : 'none' }}>
          <Suspense fallback={fallback}><WorktreePanel open onClose={() => onPanel('files')} openTerm={openTerm} initialDir={dir} /></Suspense>
        </div>
      </div>
    </AdaptivePanel>
  )
}
