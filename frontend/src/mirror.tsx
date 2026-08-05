// 镜像页（浏览器 / 手机）共用的页头零件。
//
// 这两页在做同一件事——把一块远端屏幕实时画到本地，外加一条工具条——可页头此前是各写各的：
//   · 清晰度：两边各自把四枚 antd Button 手工上色（写死 --accent-solid + 一圈
//     `0 0 0 2px rgba(31,111,235,.35)` 辉光），四枚常驻按钮把工具条右半边占满；
//   · 连接状态：`<Tag color="green|red">`，那是 antd 自己的绿/红，不是 --ok；
//   · 指标：浏览器页有等宽数字槽（数值跳动不回流），手机页没有，同一串数字两页宽窄不一；
//   · 页名：两页都没有——工具页的第一行直接是控件，看不出这是哪一页。
//
// 收成三件：页头壳（页名 + 分隔线 + 控件）/ 清晰度（Segmented，系统控件）/
// 流状态（画出来的状态点 + 等宽数字）。两页只管往壳里塞自己的控件。
import type { ReactNode } from 'react'
import { Popover, Segmented } from 'antd'
import { useI18n } from './i18n'
import { useLayout } from './layout'
import { ChevronDown } from './icons'

/** 清晰度档位：'auto' = 按带宽自适应，数字 = 固定 JPEG 质量。两页同一套档位与文案。 */
export type Quality = number | 'auto'
export const QUALITY_OPTS: { labelKey: string; value: Quality }[] = [
  { labelKey: 'browser.quality.auto', value: 'auto' },
  { labelKey: 'browser.quality.standard', value: 50 },
  { labelKey: 'browser.quality.high', value: 80 },
  { labelKey: 'browser.quality.ultra', value: 92 },
]

export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1 << 20) return (bytesPerSec / (1 << 20)).toFixed(1) + ' MB/s'
  return Math.round(bytesPerSec / 1024) + ' KB/s'
}

/**
 * 页头壳：页名 + 竖分隔线 + 控件，控件之间自动换行。
 * 页名走全站的 .tt-pagename / .tt-pagedivider——手机档那两条 CSS 会把它们收掉
 * （底栏此刻正高亮着当前页，标题是重复的），所以这里不必自己判断断点。
 */
export function MirrorHead({ name, hint, children }: { name: string; hint?: string; children: ReactNode }) {
  return (
    <div className="tt-mirror-head">
      <span className="tt-pagename" title={hint}>{name}</span>
      <span className="tt-pagedivider" aria-hidden="true" />
      {children}
    </div>
  )
}

/**
 * 连接 + 画质：**一个部件，不拆**。
 *
 * 从前这是分开的两件（`StreamStat` 一个、`QualityPicker` 一个），调用方各摆各的——
 * 于是浏览器页上「已连接 · 超清」在第二行右端、「自动 标清 高清 超清」在第四行左端，
 * 中间还隔着地址栏。同一件事（现在多清楚 / 连没连上 / 能不能换）被拆成两处，
 * 「超清」这个词还在屏幕上出现了两次，谁也说不清哪个是状态哪个是开关。
 *
 * 现在合成一个壳：状态段 + 档位段 + 指标段共用一圈描边，中间用细竖线分隔。
 * 手机档收成一枚 chip，点开是同一套档位——**收放的是密度，不是结构**。
 */
export function StreamControl({ connected, label, quality, onQuality, level, latency, bytesPerSec, fps }: {
  connected: boolean
  label: string
  quality: Quality
  onQuality: (v: Quality) => void
  level?: string          // 自适应档下后端选中的档位名，仅 auto 时有值
  latency: number | null
  bytesPerSec: number
  fps: number
}) {
  const { t } = useI18n()
  // 断点只走 useLayout()（设计系统硬规则）。这里换的是**结构**（内联展开 / 收进浮层），
  // 不是纯样式，所以它该进 JS。
  const { phone } = useLayout()

  const seg = (
    <Segmented
      size="small"
      className="tt-stream-seg"
      value={String(quality)}
      onChange={(v) => onQuality(v === 'auto' ? 'auto' : Number(v))}
      options={QUALITY_OPTS.map((o) => ({ label: t(o.labelKey), value: String(o.value) }))}
    />
  )
  const nums = (
    <>
      <span className="num" style={{ width: 52 }}>{latency == null ? '—' : latency + 'ms'}</span>
      <span className="num" style={{ width: 68 }}>{fmtRate(bytesPerSec)}</span>
      <span className="num" style={{ width: 46 }}>{fps + 'fps'}</span>
    </>
  )

  if (!phone) {
    return (
      <span className={`tt-stream${connected ? ' on' : ''}`}>
        <span className="tt-stream-sec is-stat"><i aria-hidden />{label}</span>
        <span className="tt-stream-sec is-seg">{seg}</span>
        <span className="tt-stream-sec is-num">{nums}</span>
      </span>
    )
  }

  // 手机：一枚 chip 显示「连没连上 + 现在是哪一档」，点开才给档位与指标。
  // 档位名优先用后端实际选中的那档（auto 时它才是真话），否则用固定档的名字。
  const fixed = QUALITY_OPTS.find((o) => String(o.value) === String(quality))
  const now = quality === 'auto' ? (level || t('browser.quality.auto')) : t(fixed?.labelKey || 'browser.quality.auto')
  return (
    <Popover trigger="click" placement="bottomRight" arrow={false}
      content={(
        <div className="tt-stream-pop">
          <div className={`tt-stream-popstat${connected ? ' on' : ''}`}><i aria-hidden />{label}{nums}</div>
          {seg}
        </div>
      )}>
      <button type="button" className={`tt-stream is-chip${connected ? ' on' : ''}`}
        aria-label={`${label} · ${now}`}>
        <i aria-hidden />
        <span className="lvl">{now}</span>
        <ChevronDown size={11} />
      </button>
    </Popover>
  )
}
