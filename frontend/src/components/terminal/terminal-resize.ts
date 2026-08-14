export interface TerminalDimensions { cols: number; rows: number }

// 首次 attach 已通过 WebSocket query 携带真实尺寸，不需要再故意 cols-1 → cols 抖两次。
// 只有同一前端实例发生了真实尺寸变化，或久置恢复明确要求强制重同步时，才需要 jiggle。
export function shouldJiggleAfterAttach(
  previous: TerminalDimensions | null,
  current: TerminalDimensions,
  forced: boolean,
): boolean {
  if (forced) return true
  return !!previous && (previous.cols !== current.cols || previous.rows !== current.rows)
}

/** 久置回前台要修到哪一层，见 resumeHealFor。 */
export type ResumeHeal = 'none' | 'renderer' | 'renderer+content'

/** 超过这么久没回来，就当作内容也已经坏了。 */
export const RESUME_RESYNC_MS = 10000

// 「花屏」分两层，修法相反，所以离开时长决定修到哪一层：
//   渲染器层——画布/纹理图集坏了，缓冲里的内容其实是对的，重建渲染器就好；
//   内容层——TUI 自己把版排坏了（久置期间别的客户端把 tmux 窗口改过尺寸，回来这一屏就是
//            重排残留）。这一层重建渲染器完全没用，等于把错的东西再画一遍，只有让应用
//            整屏重排（抖尺寸 → 双 SIGWINCH）才救得回来。
// 短暂切走（<1.5s）画面还好好的，什么都不做；1.5–10s 按渲染器层处理；再久两层一起修。
export function resumeHealFor(awayMs: number): ResumeHeal {
  if (awayMs <= 1500) return 'none'
  return awayMs > RESUME_RESYNC_MS ? 'renderer+content' : 'renderer'
}
