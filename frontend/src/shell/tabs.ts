// 终端标签的拖拽排序（14 设计 §7.1）。
//
// 单独一个纯函数是因为那个 ±1 很容易写错：`to` 是「插到第几个位置」（拖到某个标签
// 的右半边给的是 i+1），而把源标签先摘出来会让它**后面**的插入位整体左移一格。
// 少这一下，往右拖永远差一位，且只在往右拖时错——最难在界面上看出来的那种。
export function reorderTabs(list: string[], name: string, to: number): string[] {
  const from = list.indexOf(name)
  if (from < 0) return list
  const rest = list.filter((n) => n !== name)
  const at = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to))
  rest.splice(at, 0, name)
  return rest
}
