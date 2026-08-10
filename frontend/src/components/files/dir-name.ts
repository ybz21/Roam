// 目录 → 默认项目名：取路径最后一段。
//
// 单独成文件是为了能测边界：结尾斜杠、连续斜杠、Windows 反斜杠、根目录、`~`。
// 「以最后的为名字」这条规则本身很简单，错也只会错在这些边界上。
export function dirTailName(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || ''
}
