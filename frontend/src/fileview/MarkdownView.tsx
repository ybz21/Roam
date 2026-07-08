// Markdown 渲染：react-markdown（懒加载）+ 本地图片/链接解析。
import { type MouseEvent } from 'react'
import Markdown from '../Markdown'

export function MarkdownView({ content, accent, height, pad, resolveHref, onLinkClick }: {
  content: string
  accent: string
  height: string
  pad?: string
  resolveHref: (href: string, kind: 'link' | 'image') => string
  onLinkClick: (href: string, ev: MouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <div style={{ height, overflow: 'auto', padding: pad }}>
      <Markdown accent={accent} resolveHref={resolveHref} onLinkClick={onLinkClick}>{content}</Markdown>
    </div>
  )
}
