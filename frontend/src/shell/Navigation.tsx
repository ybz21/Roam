// 侧边导航 / Activity Bar（14 设计 §4.4）。
//
// 从 App.tsx 里搬出来并重做。旧版是一个平铺的 antd inline Menu：七个页面一视同仁，
// 「设置」和「概览」并排，选中项整块蓝底把注意力从内容上夺走，底部塞着五个同权重的
// 文字按钮（关于/收起/全屏/退出）——退出登录和收起侧栏长得一模一样。
//
// 新结构分三段：**工作区**（干活的地方）／**工具**（看别的东西的地方）／**账户**
// （改设置和退出的地方）。前两段是导航，第三段是操作，混在一起是旧版最大的问题。
//
// 不再用 antd Menu：3px 左强调线、分组标题、badge、轨态 Tooltip 这几样都要覆盖
// Menu 的默认结构，覆盖到最后剩下的只有它的键盘导航——不如自己写清楚。
import { Dropdown, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n'

export type NavEntry = {
  key: string
  label: string
  icon: ReactNode
  /** 只显示「需要行动」的数量，不显示普通总数（14 §4.4） */
  badge?: number
  badgeTitle?: string
}

export type NavGroup = { label: string; items: NavEntry[] }

export function Navigation({
  rail, active, groups, onGo, onSearch, searchHint,
  linkStatus, dock, account, accountName, onToggleRail,
}: {
  /** 64px 轨态：用户收起 / Focus / 非 large 档 */
  rail: boolean
  active: string
  groups: NavGroup[]
  onGo: (key: string) => void
  onSearch: () => void
  /** ⌘K / Ctrl+K */
  searchHint: string
  linkStatus: ReactNode
  /** 终端开合入口；没有已打开的终端时传 null */
  dock: { count: number; open: boolean; onToggle: () => void; title: string } | null
  account: MenuProps['items']
  accountName: string
  onToggleRail: () => void
}) {
  const { t } = useI18n()

  const item = (n: NavEntry) => {
    const btn = (
      <button key={n.key} type="button" className={`tt-nav-item${active === n.key ? ' on' : ''}`}
        onClick={() => onGo(n.key)} aria-current={active === n.key ? 'page' : undefined}>
        <span className="ic">{n.icon}</span>
        {!rail && <span className="nm">{n.label}</span>}
        {!!n.badge && <span className="bd" title={n.badgeTitle}>{n.badge > 99 ? '99+' : n.badge}</span>}
      </button>
    )
    // 轨态下文字没了，Tooltip 是唯一的名字来源（14 §4.4「所有图标有 Tooltip」）
    return rail ? <Tooltip key={n.key} title={n.label} placement="right">{btn}</Tooltip> : btn
  }

  return (
    <div className={`tt-nav${rail ? ' rail' : ''}`}>
      <div className="tt-nav-brand">
        <img src="/logo-mark.svg" width={34} height={34} alt="Roam" />
        {!rail && (
          <div className="wd">
            <strong>Roam</strong>
            <span>{t('app.tagline')}</span>
          </div>
        )}
      </div>

      {/* 搜索入口在轨态是唯一露出的那枚放大镜（13 §13.2） */}
      {rail ? (
        <Tooltip title={t('workspace.searchPlaceholder')} placement="right">
          <button type="button" className="tt-nav-search" onClick={onSearch} aria-label={t('workspace.search')}>
            <span className="ic">{searchIcon}</span>
          </button>
        </Tooltip>
      ) : (
        <button type="button" className="tt-nav-search" onClick={onSearch}>
          <span className="ic">{searchIcon}</span>
          <span className="nm">{t('nav.searchOrJump')}</span>
          <kbd>{searchHint}</kbd>
        </button>
      )}

      <div className="tt-nav-list">
        {groups.map((g) => (
          <div key={g.label} className="tt-nav-group">
            {!rail && <div className="gl">{g.label}</div>}
            {g.items.map(item)}
          </div>
        ))}
      </div>

      <div className="tt-nav-foot">
        {linkStatus}
        {/* 终端是开关不是页面，所以只给底色不给 3px 强调线——那条线是"当前在哪一页"的语言 */}
        {dock && (
          <button type="button" className={`tt-nav-item toggle${dock.open ? ' on' : ''}`} onClick={dock.onToggle} title={dock.title}>
            <span className="ic">{termIcon}</span>
            {!rail && <span className="nm">{t('nav.terminal')}</span>}
            <span className="bd blue">{dock.count}</span>
          </button>
        )}
        {/* 设置 / 关于 / 主题 / 全屏 / 退出 收进账户菜单：它们是操作不是导航，
            和「概览/项目」并排时，退出登录和切主题的误触代价差了几个数量级 */}
        <Dropdown menu={{ items: account }} trigger={['click']} placement={rail ? 'topLeft' : 'top'}>
          <button type="button" className="tt-nav-account" title={accountName}>
            <span className="av">{hostIcon}</span>
            {!rail && (
              <>
                <span className="nm">{accountName}</span>
                <span className="dots">•••</span>
              </>
            )}
          </button>
        </Dropdown>
        <button type="button" className="tt-nav-collapse" onClick={onToggleRail}
          title={rail ? t('common.expand') : t('common.collapse')}>
          {rail ? chevronRight : chevronLeft}
          {!rail && <span className="nm">{t('common.collapse')}</span>}
        </button>
      </div>
    </div>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>{children}</svg>
const searchIcon = svg(<><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></>)
const termIcon = svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="14" y1="4" x2="14" y2="20" /></>)
// 主机图标而不是姓名首字母：这里代表的是"你连着的这台机器"，不是一个人
const hostIcon = <svg viewBox="0 0 24 24" width={15} height={15} {...stroke}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></svg>
const chevronLeft = svg(<polyline points="15 6 9 12 15 18" />)
const chevronRight = svg(<polyline points="9 6 15 12 9 18" />)
