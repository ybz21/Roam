/**
 * Inspector 抽屉的**两层折叠**（图纸 14-desktop-workspace/panels-desktop.html §二）。
 *
 * 文件抽屉的「文件树 ｜ 预览」和 Git 的「改动列表 ｜ diff」是同一件事：抽屉从屏幕右缘
 * 拉出来，钉住的那层贴着右缘不动，新点开的东西从它**左边长出来**，面板总宽 = 两层相加。
 * 「把固定宽度切两半」是错的——420 的面板切完只剩两百出头，读不了代码；而且一点开文件，
 * 你正看着的那一列自己就变窄、跑位了。
 *
 * 两层各自记宽度、各自能拖：
 *   · 里把手（两层之间）贴着钉住那层 → 拖它改钉住层的宽；
 *   · 外把手（面板左缘，由 InspectorColumn 画） → 长出来那层开着时改它的宽，没开时改钉住层。
 * 每根把手只管紧挨着它的那一层，面板外缘跟着两层之和走。
 *
 * 抽出来是因为原先只有文件抽屉这么干，Git 那份靠容器查询在固定宽里对切：默认 552 宽根本
 * 到不了 720 阈值，diff 只能盖住改动列表；侥幸够宽时又是「列表在左、diff 在右」，跟文件
 * 抽屉正好相反——同一列里两套展开方式。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { usePointerResize } from '../PointerResize'
import { requestInspectorWidth } from './inspector'

export const LAYER_RAIL = 5

/** 一层的尺寸契约：localStorage 键 + 上下限 + 默认宽 */
export type LayerSize = { key: string; min: number; max: number; def: number }

export function InspectorLayers({ pinned, grown, pinnedSize, grownSize, handle }: {
  /** 钉在右缘的那层：文件树 / 改动列表 */
  pinned: ReactNode
  /** 从左边长出来的那层：预览 / diff。不传 = 只有一层。
   *  twoPane=false 表示面板窄到放不下两栏，这层是盖上去的——调用方据此给「返回」而不是「关闭」 */
  grown?: ((twoPane: boolean) => ReactNode) | null
  pinnedSize: LayerSize
  grownSize: LayerSize
  /** 分界条的 data-resize-handle 值：调试和测试靠它认这根把手是谁的 */
  handle: string
}) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const [dockW, setDockW] = useState(0)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setDockW(el.getBoundingClientRect().width))
    ro.observe(el)
    setDockW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const clampPinned = useCallback(
    (v: number) => Math.min(pinnedSize.max, Math.max(pinnedSize.min, Math.round(v))),
    [pinnedSize.max, pinnedSize.min],
  )
  const clampGrown = useCallback(
    (v: number) => Math.min(grownSize.max, Math.max(grownSize.min, Math.round(v))),
    [grownSize.max, grownSize.min],
  )
  const stored = (s: LayerSize, clamp: (v: number) => number) => {
    const v = Number(localStorage.getItem(s.key))
    return Number.isFinite(v) && v > 0 ? clamp(v) : s.def
  }

  const [pinnedW, setPinnedW] = useState(() => stored(pinnedSize, clampPinned))
  const [grownW, setGrownW] = useState(() => stored(grownSize, clampGrown))
  const pinnedWRef = useRef(pinnedW)
  pinnedWRef.current = pinnedW

  const open = !!grown
  const splitMin = pinnedSize.min + grownSize.min + LAYER_RAIL
  const twoPane = open && dockW >= splitMin
  /**
   * 抽屉外缘的上界由 Shell 按终端让出的余量给，未必给得到「两层之和」（1600 屏上要 1045、
   * 只给到 552）。差额必须从**钉住那层**里扣：它是你已经看过的列表，挤窄了还能认；
   * 硬按记住的宽度钉着不动，差额就全落在刚长出来的那层上——实测预览只剩 187，
   * 比它自己的下限还窄一大截，等于「开出来一栏读不了的东西」。
   * twoPane 已保证 dockW ≥ 两层下限之和，所以扣完不会低于钉住层的下限。
   */
  const pinnedRender = twoPane
    ? Math.max(pinnedSize.min, Math.min(pinnedW, dockW - LAYER_RAIL - grownSize.min))
    : pinnedW

  /**
   * 面板宽 = 两层之和，由这里说了算（不是「面板多宽就切多宽」）。
   *
   * askedRef/matchedRef 把「我们请求的宽度」和「用户拖外把手拖出来的宽度」分开：
   * 请求发出后先等它落地（matched），之后再量到的差值才算用户拖的，收进最左那一层。
   * 不分开的话，首帧量到的旧面板宽会被当成用户意图，把钉住层的宽度冲掉。
   */
  const askedRef = useRef(0)
  const matchedRef = useRef(false)
  useEffect(() => {
    const want = open ? grownW + LAYER_RAIL + pinnedW : pinnedW
    if (askedRef.current === want) return
    askedRef.current = want
    matchedRef.current = false
    requestInspectorWidth(want)
  }, [open, pinnedW, grownW])
  // 卸载时撤回请求，**并且把 askedRef 一起清零**：不清的话下一次挂载时 want 与 askedRef
  // 相等，那条 effect 直接 return，这一列就再也收不到这个面板的宽度了。
  // StrictMode 下每次挂载都要走一遍「setup → cleanup → setup」，正好踩中：开发模式里
  // 抽屉永远请求不到宽度（实测卡在上一次存的 552），跟生产行为对不上——我就是在这上面
  // 花了半小时量出一堆假数据。
  useEffect(() => () => { askedRef.current = 0; requestInspectorWidth(0) }, [])

  /**
   * 外把手拖的是最左那一层：长出来的那层开着改它的宽，没开改钉住层。
   *
   * **等它不动了再收**：面板宽度是带过渡的，松手后那几帧量到的是中间态。当场就收的话，
   * 收到的瞬时值会被当成用户的意图再报回去——实测松手明明到了 985，0.4 秒后自己缩回 872。
   */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dockW || !askedRef.current) return
    if (Math.abs(dockW - askedRef.current) <= 1) { matchedRef.current = true; return }
    if (!matchedRef.current) return
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      if (open) {
        const next = clampGrown(dockW - pinnedW - LAYER_RAIL)
        if (next !== grownW) { setGrownW(next); localStorage.setItem(grownSize.key, String(next)) }
      } else {
        const next = clampPinned(dockW)
        if (next !== pinnedW) { setPinnedW(next); localStorage.setItem(pinnedSize.key, String(next)) }
      }
    }, 400)
    return () => { if (settle.current) clearTimeout(settle.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockW])

  // 里把手贴着钉住那层：往右拖把它推窄，面板外缘跟着让出来
  const resize = usePointerResize()
  const startPinnedResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX
    const startW = pinnedW
    resize.start(e, {
      onMove: (ev) => {
        const w = clampPinned(startW - (ev.clientX - startX))
        pinnedWRef.current = w // ref 不等下一次渲染：最后一次 move 与 up 落在同一帧时，onEnd 否则存的是上一个宽度
        setPinnedW(w)
      },
      onEnd: () => localStorage.setItem(pinnedSize.key, String(pinnedWRef.current)),
    })
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      {grown && (
        <div style={twoPane
          ? { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
          : { position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
          {grown(twoPane)}
        </div>
      )}
      {twoPane && (
        <div data-resize-handle={handle} onPointerDown={startPinnedResize}
          title={t('file.dragResize')} className="tt-split-rail"
          style={{ flex: `0 0 ${LAYER_RAIL}px`, cursor: 'col-resize', background: 'var(--border)', touchAction: 'none' }} />
      )}
      <div style={{
        flex: twoPane ? `0 0 ${pinnedRender}px` : '1 1 auto',
        minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
      }}>
        {pinned}
      </div>
    </div>
  )
}
