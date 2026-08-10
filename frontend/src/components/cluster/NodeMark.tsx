// 机器徽记：一个汉字或两个字母的方章 + 状态点（设计稿 docs/design/cluster/ui.html §2）。
//
// 机器**不给颜色**——全站的色板已经排到第五支（蜂群紫），再给每台机器发一支，
// 一枚标签上就会同时挂着机器色、状态色、蜂群色，没人分得清哪个说的是哪件事。
// 所以身份看形状（方章里的字），状态看颜色（点）。
import type { ClusterNode } from './node-url'

/** 中文名取首字，拉丁名取两个首字母（gpu-box → GB）。两个汉字在 16px 的格子里会换行。 */
export function markText(name: string): string {
  const s = (name || '?').trim()
  if (/^[一-龥]/.test(s)) return s[0]
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return s.slice(0, 2).toUpperCase()
}

export function NodeMark({ name, size = 'md', current, offline }: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  current?: boolean
  offline?: boolean
}) {
  const txt = markText(name)
  const cls = `tt-nodemark ${size}${current ? ' cur' : ''}${offline ? ' off' : ''}`
  // aria-hidden：方章旁边总有机器名，念两遍是重复；轨态下由按钮的 aria-label 报名字
  return <span className={cls} data-cjk={/[一-龥]/.test(txt) ? '' : undefined} aria-hidden="true">{txt}</span>
}

/** 在线绿 / 高延迟或重连黄 / 离线灰。红只留给「当前这台没了」，由掉线条负责。 */
export function nodeDotColor(n: ClusterNode): string {
  if (!n.online) return 'var(--text-dimmer)'
  return n.latencyMs > 150 ? 'var(--warn)' : 'var(--ok)'
}
