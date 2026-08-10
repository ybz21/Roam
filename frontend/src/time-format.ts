// tmux 给的是 Unix 秒：一个转「刚刚 / N 分钟前」，一个转本地绝对时间挂在 title 上。
// 列表里两个都要——相对时间好扫，绝对时间才能对得上日志。


// tmux 给的是 Unix 秒。转成「刚刚 / N 分钟前 …」相对时间，title 里再挂绝对时间。
export function relTime(sec: string | number | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  const n = typeof sec === 'string' ? parseInt(sec, 10) : sec
  if (!n || !Number.isFinite(n)) return '—'
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - n))
  if (diff < 60) return t('time.justNow')
  if (diff < 3600) return t('time.minutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('time.hoursAgo', { count: Math.floor(diff / 3600) })
  return t('time.daysAgo', { count: Math.floor(diff / 86400) })
}

export function absTime(sec: string | number | undefined): string {
  const n = typeof sec === 'string' ? parseInt(sec, 10) : sec
  if (!n || !Number.isFinite(n)) return ''
  return new Date(n * 1000).toLocaleString()
}
