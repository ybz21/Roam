// P1「Command Palette」：把原来一个长 tmux 下拉菜单拆成的"快捷面板"这一层——
// Ctrl/Cmd+K 打开，输入过滤，上下键选、Enter 执行，展示每条命令的作用域（分组）和
// 快捷键提示；危险项（目前只有关闭当前窗格）标红，选中后仍走 runTmuxAction 的
// 结构化确认路由，不会绕开上一轮做的目标可视化确认。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Input, Modal, Tag } from 'antd'
import { useI18n } from './i18n'
import { MONO } from './chat/blocks'
import { filterActions, moveHighlight, type PaletteAction } from './command-palette'

export function CommandPalette({ open, actions, onSelect, onClose }: {
  open: boolean
  actions: PaletteAction[]
  onSelect: (key: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => filterActions(actions, query), [actions, query])

  useEffect(() => { if (open) { setQuery(''); setHighlight(0) } }, [open])
  useEffect(() => { setHighlight(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [highlight])

  const choose = (a: PaletteAction) => { onSelect(a.key); onClose() }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => moveHighlight(filtered.length, h, 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => moveHighlight(filtered.length, h, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const a = filtered[highlight]; if (a) choose(a) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} closable={false} width={520} destroyOnHidden
      styles={{ body: { padding: 0 }, content: { padding: 0, overflow: 'hidden' } }}>
      <div onKeyDown={onKeyDown}>
        <Input
          autoFocus size="large" placeholder={t('palette.searchPlaceholder')}
          value={query} onChange={(e) => setQuery(e.target.value)}
          style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}
        />
        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
          {filtered.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-dim)', textAlign: 'center' }}>{t('palette.noResults')}</div>
          )}
          {filtered.map((a, i) => (
            <div key={a.key} data-idx={i} onMouseEnter={() => setHighlight(i)} onClick={() => choose(a)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer',
                background: i === highlight ? 'var(--list-hover)' : undefined,
              }}>
              <span style={{ flex: 1, color: a.danger ? '#f85149' : 'var(--text-bright)' }}>{a.label}</span>
              <Tag style={{ margin: 0 }}>{a.group}</Tag>
              <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-dimmer)', whiteSpace: 'nowrap' }}>{a.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
