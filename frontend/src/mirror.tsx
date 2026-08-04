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
import { Segmented } from 'antd'
import { useI18n } from './i18n'

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

/** 清晰度选择：antd Segmented，选中态由主题给（照抄十六进制必然比 antd 自己画的差一档）。 */
export function QualityPicker({ value, onChange }: { value: Quality; onChange: (v: Quality) => void }) {
  const { t } = useI18n()
  return (
    <Segmented
      size="small"
      className="tt-mirror-quality"
      value={String(value)}
      onChange={(v) => onChange(v === 'auto' ? 'auto' : Number(v))}
      options={QUALITY_OPTS.map((o) => ({ label: t(o.labelKey), value: String(o.value) }))}
    />
  )
}

/**
 * 流状态：状态点 + 连接文案 + 延迟/带宽/帧率。
 * 数字槽定宽 + tabular-nums：这三个值每秒都在跳，不定宽的话整条工具条跟着抖。
 * 状态点是画出来的圆（border-radius:50%），不是 ● 字符。
 */
export function StreamStat({ connected, label, level, latency, bytesPerSec, fps }: {
  connected: boolean
  label: string
  level?: string          // 自适应档下后端选中的档位名，仅 auto 时有值
  latency: number | null
  bytesPerSec: number
  fps: number
}) {
  return (
    <span className={`tt-mirror-stat${connected ? ' on' : ''}`}>
      <i aria-hidden />
      <span className="lbl">{label}</span>
      {level ? <span className="lvl">{level}</span> : null}
      <span className="num" style={{ width: 52 }}>{latency == null ? '—' : latency + 'ms'}</span>
      <span className="num" style={{ width: 68 }}>{fmtRate(bytesPerSec)}</span>
      <span className="num" style={{ width: 46 }}>{fps + 'fps'}</span>
    </span>
  )
}
