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
