// Command Center：横跨 Canvas 与 Dock 的 40px 顶栏（14 设计 §4.5）。
//
// 只放三样：全局搜索、快捷创建、连接状态。**页面标题和项目路径不进来**——
// 否则 Focus 时会形成"顶栏一层、页面头一层"的无意义两层头部。页面标题留在 Canvas，
// 项目与会话上下文进工作区标签。
//
// 搜索框居中对齐 VS Code 的 Command Center；⌘K / Ctrl+K 打开面板，`/` 也行
// （输入框、终端聚焦时不抢，见 App 里的挂载条件）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'

export type PaletteItem = {
  key: string
  /** 分组标题，同组连续排列 */
  group: string
  title: string
  desc?: string
  icon?: ReactNode
  run: () => void
}

export function WorkspaceTopbar({ items, online, dockCount, dockOpen, onToggleDock, onCreate, modKey }: {
  items: PaletteItem[]
  online: boolean
  dockCount: number
  dockOpen: boolean
  onToggleDock: () => void
  onCreate: () => void
  modKey: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest?.('.xterm'))
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); return }
      // `/` 是无修饰键，正在打字时绝不能抢
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setOpen(true) }
    }
    // 导航轨顶部那枚放大镜（13 §13.2）也开这同一个面板。用事件而不是把 open 提到
    // App：面板的搜索状态只属于顶栏，提上去就得把它整套状态跟着提上去。
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('tt-open-palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('tt-open-palette', onOpen)
    }
  }, [])

  return (
    <>
      <header style={{
        position: 'relative', flex: '0 0 var(--topbar-h)', height: 'var(--topbar-h)',
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-container)',
      }}>
        <button onClick={() => setOpen(true)} title={`${t('workspace.search')} (${modKey}K)`}
          style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            width: 'min(480px, 34%)', height: 28, padding: '0 10px',
            display: 'flex', alignItems: 'center', gap: 8,
            border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text-dimmer)', background: 'var(--bg-base)',
            fontSize: 12, cursor: 'pointer',
          }}>
          <Magnifier />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('workspace.searchPlaceholder')}</span>
          <kbd style={{
            marginLeft: 'auto', padding: '1px 5px', border: '1px solid var(--border)',
            borderRadius: 5, color: 'var(--text-dim)', background: 'var(--bg-container)', fontSize: 10,
          }}>{modKey}K</kbd>
        </button>

        {/* 次级样式，不是实心主按钮：页面自己的 sticky 工具条里几乎总有一枚主按钮
            （＋新项目 / ＋开始），两者上下相邻时同色同权重会打架，而顶栏这枚只是
            "去新建的地方"，层级本来就低一档。 */}
        <button onClick={onCreate} className="tt-top-create" style={{
          marginLeft: 'auto', height: 28, padding: '0 11px', borderRadius: 6,
          border: '1px solid var(--border)', color: 'var(--text-bright)',
          background: 'var(--bg-container)', fontSize: 12, cursor: 'pointer',
        }}>＋ {t('common.create')}</button>

        <span title={online ? t('workspace.online') : t('workspace.offline')} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: 'var(--text-dim)', fontSize: 11, whiteSpace: 'nowrap',
        }}>
          <i style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#3fb950' : 'var(--text-dimmer)' }} />
          {online ? t('workspace.online') : t('workspace.offline')}
        </span>

        {dockCount > 0 && (
          <button onClick={onToggleDock} title={`${t('nav.terminal')} (${modKey}J)`} style={{
            height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 6,
            border: '1px solid var(--border)', borderRadius: 6,
            color: dockOpen ? '#58a6ff' : 'var(--text-dim)', background: 'var(--bg-container)',
            fontSize: 11, cursor: 'pointer',
          }}>
            <TerminalGlyph />{dockCount}
          </button>
        )}
      </header>

      {open && <CommandPalette items={items} onClose={() => setOpen(false)} />}
    </>
  )
}

function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const matched = needle
      ? items.filter((i) => (i.title + ' ' + (i.desc || '') + ' ' + i.group).toLowerCase().includes(needle))
      : items
    return matched.slice(0, 30)
  }, [items, q])

  useEffect(() => { setCursor(0) }, [q])

  const runAt = (idx: number) => {
    const hit = hits[idx]
    if (!hit) return
    onClose()
    hit.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(cursor) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  let lastGroup = ''
  return (
    <>
      <button aria-label={t('common.close')} onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-scrim)' as unknown as number,
        border: 0, padding: 0, background: 'rgba(1,4,9,.55)',
      }} />
      <div role="dialog" aria-modal="true" style={{
        position: 'fixed', left: '50%', top: 96, transform: 'translateX(-50%)',
        zIndex: 'var(--z-sheet)' as unknown as number,
        width: 'min(560px, calc(100vw - 32px))', maxHeight: '62vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        border: '1px solid var(--border)', borderRadius: 14,
        background: 'var(--bg-elevated)', boxShadow: 'var(--elevated-shadow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 52, borderBottom: '1px solid var(--border-subtle)' }}>
          <Magnifier />
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder={t('workspace.searchPlaceholder')}
            style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--text-bright)', fontSize: 14 }}
          />
          <kbd style={{ color: 'var(--text-dimmer)', fontSize: 10 }}>Esc</kbd>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
          {hits.length === 0 && (
            <div style={{ padding: '18px 10px', color: 'var(--text-dim)', fontSize: 13 }}>{t('workspace.noResult')}</div>
          )}
          {hits.map((hit, idx) => {
            const head = hit.group !== lastGroup ? hit.group : null
            lastGroup = hit.group
            return (
              <div key={hit.key}>
                {head && (
                  <div style={{ padding: '10px 8px 4px', color: 'var(--text-dimmer)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em' }}>{head}</div>
                )}
                <button
                  onMouseEnter={() => setCursor(idx)} onClick={() => runAt(idx)}
                  style={{
                    width: '100%', minHeight: 40, padding: '6px 9px',
                    display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                    border: 0, borderRadius: 9, cursor: 'pointer',
                    color: 'var(--text-bright)',
                    background: idx === cursor ? 'rgba(88,166,255,.14)' : 'transparent',
                  }}>
                  {hit.icon && <span style={{ flex: '0 0 18px', display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>{hit.icon}</span>}
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.title}</span>
                    {hit.desc && <span style={{ display: 'block', marginTop: 1, color: 'var(--text-dim)', fontSize: 11 }}>{hit.desc}</span>}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

const Magnifier = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
  </svg>
)
const TerminalGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" />
  </svg>
)
