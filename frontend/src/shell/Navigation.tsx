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
  rail, active, groups, onGo,
  linkStatus, dock, account, accountName, node, onToggleRail,
}: {
  /** 64px 轨态：用户收起 / Focus / 非 large 档 */
  rail: boolean
  active: string
  groups: NavGroup[]
  onGo: (key: string) => void
  linkStatus: ReactNode
  /** 终端开合入口；没有已打开的终端时传 null */
  dock: { count: number; open: boolean; onToggle: () => void; title: string } | null
  account: MenuProps['items']
  accountName: string
  /** 多机（连了 Broker）时给：底座那枚按钮变成机器切换器；单机传 null */
  node: { name: string; mark: ReactNode; dot: string; latency: string } | null
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
        {/* 轨态下标是唯一的品牌元素，得由它报名字；展开时旁边就写着 Roam，再念一遍是重复 */}
        <img src="/logo-mark.svg" width={34} height={34} alt={rail ? 'Roam' : ''} aria-hidden={rail ? undefined : true} />
        {!rail && <strong className="wd">Roam</strong>}
      </div>

      {/* 这里原来还有一枚搜索入口。去掉了：顶栏 Command Center 的搜索横跨整个工作区、
          轨态下也在，侧栏这枚是同一个动作的第二个入口，只是把导航第一屏又占掉一行。 */}

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
          {/* 多机时这枚按钮就是机器切换器——它本来说的就是「你连着的这台机器」，
              多机后终于有了名字。单机时原样保留今天的长相（主机图标 + 「当前设备」）。 */}
          <button type="button" className={`tt-nav-account${node ? ' node' : ''}`}
            title={node ? `${node.name} · ${node.latency}` : accountName}
            aria-label={node ? t('node.aria.switcher', { name: node.name }) : accountName}>
            <span className="av">{node ? node.mark : hostIcon}</span>
            {!rail && (
              <>
                <span className="nm">{node ? node.name : accountName}</span>
                {node && <i className="nd" style={{ background: node.dot }} />}
                <span className="dots">{moreIcon}</span>
              </>
            )}
            {node && rail && <i className="nd rail" style={{ background: node.dot }} />}
          </button>
        </Dropdown>
        <button type="button" className="tt-nav-collapse" onClick={onToggleRail}
          title={rail ? t('common.expand') : t('common.collapse')}>
          <span className="ic">{rail ? chevronRight : chevronLeft}</span>
          {!rail && <span className="nm">{t('common.collapse')}</span>}
        </button>
      </div>
    </div>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>{children}</svg>
const termIcon = svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="14" y1="4" x2="14" y2="20" /></>)
// 主机图标而不是姓名首字母：这里代表的是"你连着的这台机器"，不是一个人。
// 尺寸跟导航项同为 18：整列图标要落在同一条竖线、同一个视觉重量上。
const hostIcon = svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></>)
const chevronLeft = svg(<polyline points="15 6 9 12 15 18" />)
const chevronRight = svg(<polyline points="9 6 15 12 9 18" />)
// 「•••」是三个句点，不是图标：字号下和标点混作一团，也跟不上这一列的线性图标语言
const moreIcon = <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
