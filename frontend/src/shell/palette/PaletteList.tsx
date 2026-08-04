// 结果列表：分组标题 + 行 + 「结果太多」的提示。键盘选中项由外面给，这里只负责
// 把它滚回可见区——否则光标"走"到列表外面，屏幕上什么也没变。
import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import type { HitKind } from '../../search'
import { PaletteRowView } from './PaletteRow'
import type { PaletteRow as Row } from './types'

export function PaletteList({ rows, cursor, busy, truncated, indexing, onHover, onRun }: {
  rows: Row[]
  cursor: number
  busy: boolean
  truncated: boolean
  indexing: boolean
  onHover: (idx: number) => void
  onRun: (idx: number) => void
}) {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // 分组名。后端新加的数据源如果这里还没登记，就退回用 kind 原文当组名——
  // 少一行译文总比整组结果不显示强。
  const GROUP_KEY: Record<string, string> = {
    project: 'workspace.groupProjects',
    session: 'workspace.groupAllSessions',
    plugin: 'workspace.groupPlugins',
    swarm: 'workspace.groupSwarms',
    file: 'workspace.groupFiles',
    content: 'workspace.groupContent',
  }
  const groupLabel = (kind: HitKind, badge?: string): string => {
    if (kind === 'page' || kind === 'command') return badge || t('workspace.groupPages')
    const key = GROUP_KEY[kind]
    return key ? t(key) : String(kind)
  }

  let lastGroup = ''
  return (
    <div className="tt-palette-list" ref={listRef}>
      {rows.length === 0 && (
        <div className="tt-palette-empty">{busy ? t('workspace.searching') : t('workspace.noResult')}</div>
      )}
      {rows.map((row, idx) => {
        const label = groupLabel(row.kind, row.badge)
        const head = label !== lastGroup ? label : null
        lastGroup = label
        return (
          <div key={row.key}>
            {head && <div className="tt-palette-group">{head}</div>}
            <PaletteRowView row={row} idx={idx} active={idx === cursor}
              onHover={() => onHover(idx)} onRun={() => onRun(idx)} />
          </div>
        )
      })}
      {indexing && <div className="tt-palette-note">{t('workspace.indexing')}</div>}
      {truncated && <div className="tt-palette-note">{t('workspace.tooManyResults')}</div>}
    </div>
  )
}
