// 底部状态条（设计 docs/design/web/20-status-bar/index.html）。
// 命名跟着邻居 WorkspaceTopbar 走：chat/ 下另有一个 StatusBar，那是**会话**的状态条，
// 这个是整个工作区的。
//
// 条是壳，格是注册进来的：系统格由宿主的 provider 给（进程内 state，固定槽位，
// 第一帧就有值），插件格由 manifest 的 contributes.statusItems 注册（按 refresh 拉，
// 只能落两个尾段）。两类格共用同一套渲染器、阈值判定和折叠规则——条上看不出区别，
// 设置里才分得开。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { CellBody } from './status-renderers'
import {
  estimateWidth, formatValue, pickCells, rawSeverity, trackSustain,
  type Cell, type CellSpec, type CellValue, type StatusAction, type SustainTracker,
} from './status-cells'
import { pluginCells, type PluginRecord } from './status-registry'
import { usePluginValues } from './status-poll'

export type SystemCell = { spec: CellSpec; val: CellValue }

export function WorkspaceStatusBar({ system, onAction }: {
  /** 系统格：由 App 从它已经有的 state 算出来，**不发新请求** */
  system: SystemCell[]
  onAction: (a: StatusAction) => void
}) {
  const { t, locale } = useI18n()
  const [prefs] = usePreferences()
  const [plugins, setPlugins] = useState<PluginRecord[]>([])
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement | null>(null)
  const sustain = useRef(new Map<string, SustainTracker>())

  // 一次性拉插件清单——这是**注册表**，不是读数：不知道注册了什么就没法渲染。
  // 之后不再轮询，装/停用插件后刷新页面生效。
  useEffect(() => {
    let stop = false
    api('GET', '/plugins')
      .then((r) => { if (!stop) setPlugins(Array.isArray(r) ? r : r?.data || []) })
      .catch(() => {})
    return () => { stop = true }
  }, [])

  // 只量容器，不量格子：格宽是估出来的纯函数（status-cells.estimateWidth）。
  // 量格子会在临界宽度上抖成 量→删→变宽→加回来 的无限循环。
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const { specs: plugSpecs, sources } = useMemo(
    () => pluginCells(plugins, locale), [plugins, locale])
  const values = usePluginValues(sources)

  const hidden = useMemo(() => new Set(prefs.statusBar?.hidden || []), [prefs.statusBar?.hidden])
  // 第三方插件的格装上就默认关着：装了插件不等于同意它上你的状态条
  const shown = (s: CellSpec) =>
    !hidden.has(s.id) && !hidden.has(s.provider) &&
    (s.kind === 'system' || s.builtin || (prefs.statusBar?.optIn || []).includes(s.provider))

  const cells: Cell[] = useMemo(() => {
    const now = Date.now()
    const build = (spec: CellSpec, val: CellValue): Cell | null => {
      if (val.missing) return null // 取不到就整格不渲染，不画「—」占位
      const raw = val.severity ?? rawSeverity(val.pct ?? val.value, spec.thresholds)
      const tr = trackSustain(sustain.current.get(spec.id), raw, now, spec.thresholds?.sustainSec)
      sustain.current.set(spec.id, tr)
      const severity = val.stale ? 'ok' : tr.shown
      return { ...spec, val, severity, width: estimateWidth(spec, formatValue(val, spec.unit)) }
    }
    const out: Cell[] = []
    for (const s of system) {
      if (!shown(s.spec)) continue
      const c = build(s.spec, s.val)
      if (c) out.push(c)
    }
    for (const spec of plugSpecs) {
      if (!shown(spec)) continue
      const c = build(spec, values[spec.id] ?? { missing: true })
      if (c) out.push(c)
    }
    return out
  }, [system, plugSpecs, values, hidden, prefs.statusBar?.optIn])

  const visible = useMemo(() => pickCells(cells, width || 1200), [cells, width])

  if (!prefs.statusBar?.enabled) return null

  // 弹簧插在最后一个左半格之后，把右半推到尽头。
  // 没有右半格时不插——否则那根分隔线会孤零零地贴在最右边。
  const hasRight = visible.some((c) => c.align === 'right')
  const lastLeft = hasRight ? visible.map((c) => c.align).lastIndexOf('left') : -1

  return (
    <div ref={ref} className="tt-statusbar" role="status" aria-label={t('status.bar')}>
      {visible.map((c, i) => (
        <Fragment key={c.id}>
          <CellButton cell={c} onAction={onAction} />
          {i === lastLeft && <span className="sp" />}
        </Fragment>
      ))}
    </div>
  )
}

function CellButton({ cell, onAction }: { cell: Cell; onAction: (a: StatusAction) => void }) {
  const { t } = useI18n()
  // detail 排在数字前面：图标格条上只有一个「2」，名字得先说清那是什么的 2
  const name = [cell.label, cell.val.detail, formatValue(cell.val, cell.unit)]
    .filter(Boolean).join(' ')
  const cls = [
    'cell', cell.severity !== 'ok' ? cell.severity : '',
    cell.severity !== 'ok' ? 'pin' : '', cell.val.stale ? 'stale' : '',
    cell.kind === 'plugin' ? 'plug' : '',
  ].filter(Boolean).join(' ')

  // 只能点的才是 button：没有动作的格是读数，做成按钮只会骗一次点击。
  // 图标钮的名字走 aria-label 而不是 Tooltip——粗指针下站点级隐藏了 .ant-tooltip。
  if (!cell.onClick) {
    return <span className={cls} title={name} aria-label={name}>{<CellBody cell={cell} />}</span>
  }
  return (
    <button type="button" className={`${cls} btn`} title={`${name} · ${t('status.open')}`}
      aria-label={name} onClick={() => onAction(cell.onClick!)}>
      <CellBody cell={cell} />
    </button>
  )
}
