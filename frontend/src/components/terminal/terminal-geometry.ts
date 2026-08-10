// tmux pane 几何用的是终端 cell 坐标（#{pane_left}/#{pane_top}/#{pane_width}/#{pane_height}），
// 危险操作目标高亮需要的是视口像素矩形。换算逻辑单独抽出来（同 terminal-resize.ts /
// terminal-lifecycle.ts 的做法），不用真的挂载 xterm 就能测。
export interface CellMetrics { left: number; top: number; cellWidth: number; cellHeight: number }
export interface PaneCells { left: number; top: number; width: number; height: number }
export interface PixelRect { x: number; y: number; width: number; height: number }

export function paneCellsToPixelRect(metrics: CellMetrics, pane: PaneCells): PixelRect {
  return {
    x: metrics.left + pane.left * metrics.cellWidth,
    y: metrics.top + pane.top * metrics.cellHeight,
    width: pane.width * metrics.cellWidth,
    height: pane.height * metrics.cellHeight,
  }
}
