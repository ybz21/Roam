// 右栏：当前任务那个 worktree 的 文件 / Git / Worktree 三个面板（22 设计 §3.4）。
//
// 今天这三样各自往 Inspector 槽位栈里 claim 一份，只有栈顶可见——「文件」亮着露出来的却是 Git。
// 现在 App 只挂**这一个** AdaptivePanel：顶上活动条切面板，下面写着当前是哪个 worktree、哪条分支。
// 三个面板都挂着、只切 display——AdaptivePanel 文件头写过「是藏不是卸载」的账：卸载 Git 会连
// 它子树里的 Worktree 一起没了。槽位机制（inspector.ts / InspectorColumn）一行不改，只是栈里最多一个。
import { Suspense, type ReactNode } from 'react'
import { Spin, Tooltip } from 'antd'
import { useI18n } from '../../i18n'
import { FolderIcon, GitIcon, WorktreeIcon } from '../../icons'
import FileBrowser from '../files/FileBrowser'
import AdaptivePanel from './AdaptivePanel'
import { lazyRetry } from '../lazy-retry'

const GitPanel = lazyRetry(() => import('../git/GitPanel'))
const WorktreePanel = lazyRetry(() => import('../git/WorktreePanel'))

export type InspectorPanelKind = 'files' | 'git' | 'worktree'

export function InspectorPanels({ open, panel, onPanel, dir, scope, openTerm, onClose, onOpenFile, selectedPath, searchNonce, onOpenLine }: {
  open: boolean
  panel: InspectorPanelKind
  onPanel: (p: InspectorPanelKind) => void
  /** 当前任务的 worktree；散会话给它的工作目录 */
  dir: string
  /** 作用域头：「项目 · 任务名」 */
  scope: string
  openTerm?: (name: string) => void
  onClose: () => void
  /** 单击文件 → 中间开成标签（22 设计 §3.3）；不传就用 FileBrowser 自己的预览 */
  onOpenFile?: (path: string) => void
  /** 中间当前的文件标签：树里高亮它 */
  selectedPath?: string
  /** ⌘⇧F：聚焦文件面板的搜索框；自增触发 */
  searchNonce?: number
  /** 内容搜索点行：开标签并定位 */
  onOpenLine?: (path: string, line?: number) => void
}) {
  const { t } = useI18n()
  const acts: { key: InspectorPanelKind; label: string; icon: ReactNode }[] = [
    { key: 'files', label: t('nav.files'), icon: <FolderIcon size={17} /> },
    { key: 'git', label: t('git.title'), icon: <GitIcon size={17} /> },
    { key: 'worktree', label: t('worktree.title'), icon: <WorktreeIcon size={17} /> },
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
        {/* 只写「项目 · 任务」：分支底部状态条已经有了，这里再来一枚只是把头挤成两行 */}
        <div className="tt-ins-scope" title={dir}><span className="nm">{scope}</span></div>
        {/* 三个面板都挂着，只切 display：树的展开态、Git 的选中都留着 */}
        <div className="tt-ins-body" style={{ display: panel === 'files' ? 'flex' : 'none' }}>
          {/* 一个搜索框：打字按名字过滤，回车在文件内容里搜（22 设计 §3.4 的「名称 / 内容」两段并成了一框） */}
          <FileBrowser dir={dir} accent="var(--accent)" layout="dock" chrome="tree" onOpenFile={onOpenFile} selectedPath={selectedPath || null}
            onOpenLine={onOpenLine} focusSearchNonce={searchNonce} />
        </div>
        <div className="tt-ins-body" style={{ display: panel === 'git' ? 'flex' : 'none' }}>
          <Suspense fallback={fallback}><GitPanel dir={dir} accent="var(--accent)" openTerm={openTerm} /></Suspense>
        </div>
        <div className="tt-ins-body" style={{ display: panel === 'worktree' ? 'flex' : 'none' }}>
          {/* embedded：不自己 claim 槽位（否则压在这块面板上面）、不画自己的标题行 */}
          <Suspense fallback={fallback}><WorktreePanel embedded open onClose={() => onPanel('files')} openTerm={openTerm} initialDir={dir} /></Suspense>
        </div>
      </div>
    </AdaptivePanel>
  )
}
