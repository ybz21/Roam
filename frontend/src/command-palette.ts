// 命令面板的过滤 + 键盘导航逻辑，抽成纯函数（同 terminal-geometry.ts / terminal-resize.ts
// 的做法），不用真的挂载 Modal 就能测。
export interface PaletteAction { key: string; label: string; hint: string; danger?: boolean; group: string }

// 大小写不敏感子串匹配，同时命中命令名和所属分组名（同代码库里 AutoComplete/Select
// 的 filterOption 惯例一致）；空查询返回全部。
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase()
  if (!q) return actions
  return actions.filter((a) => a.label.toLowerCase().includes(q) || a.group.toLowerCase().includes(q))
}

// 上下键移动高亮索引，越界回卷；列表为空返回 -1。
export function moveHighlight(count: number, current: number, delta: number): number {
  if (count <= 0) return -1
  return (current + delta + count) % count
}
