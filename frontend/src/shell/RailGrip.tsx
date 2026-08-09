// 分栏把手上的那簇小按钮：**拖之外的第二条路**。
//
// 把手原本只认拖：8px 宽、按住横移。方向键和双击复位其实早就有，但没有任何东西说出来，
// 等于没有；手指档更是几乎拖不中。所以把「改宽」这件事摆成看得见的三枚按钮：
//
//   ‹   往这边挪一档（48px）
//   ⌄   收起 / 展开旁边那一栏（收起后把手留在原地，它就是回程）
//   ›   往那边挪一档
//
// 中间那枚**不吞 pointerdown**：它压在把手正中，而正中恰恰是想拖的人最先按下去的地方，
// 吞掉就成了「按住中间怎么拖都不动」。按下照旧交给把手起手拖，松手时把手自己判——
// 一路没挪过（<4px）就当点击去开合（见各把手的 onEnd）。拖拽起手会 preventDefault，
// 浏览器不再补发 click，所以这里的 onClick 只剩键盘那一路，两条路不打架。
//
// 两枚步进按钮相反：它们必须走原生 click，所以把手那边见到 `data-rail-step` 就不起手拖。
import type { ReactNode } from 'react'

export function RailControls({ collapsed, side, label, onToggle, onStep, stepLabels }: {
  collapsed: boolean
  /** 被收起的那一栏在把手的哪一侧——箭头要指向它展开的方向 */
  side: 'left' | 'right'
  label: string
  onToggle: () => void
  /** 一档一档地挪分隔线；不给就只有开合（比如没有可拖区间的把手） */
  onStep?: (dir: -1 | 1) => void
  stepLabels?: { minus: string; plus: string }
}) {
  // 展开态箭头指向「它会缩到哪边去」（左边那栏往左收），收起态指向「它会从哪边出来」
  const pointsLeft = collapsed ? side === 'right' : side === 'left'
  const step = !collapsed && onStep && stepLabels
  return (
    <div className="tt-rail-ctl">
      {step && (
        <button type="button" data-rail-step className="tt-rail-btn" aria-label={stepLabels.minus}
          title={stepLabels.minus} onClick={(e) => { e.stopPropagation(); onStep(-1) }}>
          {chevron(true)}
        </button>
      )}
      <button
        type="button"
        data-rail-grip
        className="tt-rail-btn main"
        aria-label={label}
        title={label}
        aria-expanded={!collapsed}
        // 方向键不拦：焦点在这上面时 ←/→ 照旧冒泡给把手调宽，Enter/Space 走这枚 onClick
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 中间这枚是「整栏收/放」，不是「挪一档」：双箭头，跟上下两枚单箭头一眼分得开 */}
        {doubleChevron(pointsLeft)}
      </button>
      {step && (
        <button type="button" data-rail-step className="tt-rail-btn" aria-label={stepLabels.plus}
          title={stepLabels.plus} onClick={(e) => { e.stopPropagation(); onStep(1) }}>
          {chevron(false)}
        </button>
      )}
    </div>
  )
}

/** 把手一档挪多少（与键盘 Shift+方向键同步长，肉眼能看出一步的距离） */
export const RAIL_STEP = 48

const doubleChevron = (left: boolean): ReactNode => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {left
      ? <><polyline points="17 6 11 12 17 18" /><polyline points="11 6 5 12 11 18" /></>
      : <><polyline points="7 6 13 12 7 18" /><polyline points="13 6 19 12 13 18" /></>}
  </svg>
)

const chevron = (left: boolean): ReactNode => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points={left ? '15 6 9 12 15 18' : '9 6 15 12 9 18'} />
  </svg>
)

/** 把手自己的 pointerdown 兜底：落在中间那枚上的按下，松手没挪就是一次开合 */
export function isGripEvent(e: { target: EventTarget | null }): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('[data-rail-grip]')
}

/** 步进按钮要走原生 click，不能被拖拽起手的 preventDefault 吃掉 */
export function isStepEvent(e: { target: EventTarget | null }): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('[data-rail-step]')
}
