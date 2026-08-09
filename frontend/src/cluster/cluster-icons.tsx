// 多机设置页用到的三枚图标。放这儿而不是 icons.tsx：它们只服务这一页，
// 而 icons.tsx 是全站共用集合，别往里塞一次性的东西。
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const wrap = (c: React.ReactNode, size = 16) => <svg viewBox="0 0 24 24" width={size} height={size} {...s} aria-hidden>{c}</svg>

export const HostIcon = ({ size }: { size?: number }) =>
  wrap(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>, size)
export const CloudIcon = ({ size }: { size?: number }) =>
  wrap(<path d="M7 18h10a4 4 0 0 0 .3-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z" />, size)
export const LanIcon = ({ size }: { size?: number }) =>
  wrap(<><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M12 14V8M7 8h10" /></>, size)
