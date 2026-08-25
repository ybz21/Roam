// Command Center：横跨 Canvas 与 Dock 的 40px 顶栏（14 设计 §4.5）。
//
// 只放两样：全局搜索、快捷创建。连接状态归底部状态条（20 设计）。**页面标题和项目路径不进来**——
// 否则 Focus 时会形成"顶栏一层、页面头一层"的无意义两层头部。页面标题留在 Canvas，
// 项目与会话上下文进工作区标签。
//
// 搜索框居中对齐 VS Code 的 Command Center。**面板与快捷键不在这里**：它们在
// shell/palette/GlobalSearch，因为手机和单终端页都没有顶栏，搜索却要处处能唤起。
// 这枚框只负责「看得见的入口」——点一下发事件。
import { useI18n } from '../../i18n'
import { PlusIcon, SearchIcon, TerminalIcon } from '../../icons'
import { openPalette } from './palette'

export type { PaletteItem, PaletteActions } from './palette'

export function WorkspaceTopbar({ dockCount, dockOpen, onToggleDock, onCreate, modKey }: {
  dockCount: number
  dockOpen: boolean
  onToggleDock: () => void
  onCreate: () => void
  modKey: string
}) {
  const { t } = useI18n()

  return (
    <>
      <header style={{
        position: 'relative', flex: '0 0 var(--topbar-h)', height: 'var(--topbar-h)',
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        // 与侧栏、页面同底（--bg-base）：顶栏用 --bg-container 会比左右两侧都浅一档，
        // 整条横在最上面像贴上去的第二层壳
        borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-base)',
      }}>
        {/* 搜索是这条顶栏上唯一一件「常用且找不到替代入口」的事，所以给它一块实底
            （--bg-elevated，比顶栏亮一档）而不是描边框：原来那枚和底同色、只有一圈
            1px 边，扫一眼过去根本注意不到自己能搜。样式在 index.css .tt-topsearch。 */}
        <button className="tt-topsearch" onClick={openPalette} title={`${t('workspace.search')} (${modKey}K)`}>
          <SearchIcon size={14} />
          <span className="ph">{t('workspace.searchPlaceholder')}</span>
          <kbd>{modKey}K</kbd>
        </button>

        {/* 全站唯一的新建入口（14 §4.5）。页面工具条里不再重复放一枚——两枚同色同权重
            的「＋ 新建 / ＋ 新项目」上下相邻，第一眼分不清该点哪个。 */}
        <button onClick={onCreate} className="tt-top-create" style={{
          marginLeft: 'auto', height: 28, padding: '0 11px', border: 0, borderRadius: 6,
          color: '#fff', background: 'var(--accent-solid)', fontSize: 12, cursor: 'pointer',
        }}><PlusIcon size={12} />{t('common.create')}</button>

        {/* 「在线/离线」那颗点搬去了底部状态条的机器格：那儿位置更稳、每一页都在，
            而且手机也有（顶栏手机上根本不存在）。见 shell/status-system.ts。 */}

        {dockCount > 0 && (
          <button onClick={onToggleDock} title={`${t('nav.terminal')} (${modKey}J)`} style={{
            height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 6,
            border: '1px solid var(--border)', borderRadius: 6,
            color: dockOpen ? 'var(--accent)' : 'var(--text-dim)', background: 'var(--bg-container)',
            fontSize: 11, cursor: 'pointer',
          }}>
            <TerminalIcon size={14} />{dockCount}
          </button>
        )}
      </header>
    </>
  )
}
