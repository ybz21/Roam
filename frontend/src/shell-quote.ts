// POSIX 单引号安全包裹：prompt、路径要作为 agent CLI 的参数发出去。
// 原来这段在 App.tsx 里有两份（shellQuote 与 shq），实现一模一样。

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
