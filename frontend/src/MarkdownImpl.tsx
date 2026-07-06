// 对话文本的 Markdown 渲染实现（Claude / Codex 共用）。深色主题、紧凑边距以贴合气泡。
// 工具输出/命令仍按原样 <pre> 显示，不走这里。入口在 Markdown.tsx（懒加载壳），业务代码勿直接引本文件。
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { CSSProperties, MouseEvent } from 'react'
import { lazy, Suspense } from 'react'
import { CodeBox } from './chat/blocks'
import { useI18n } from './i18n'

// Mermaid 组件连同其重依赖(mermaid/d3/cytoscape…)整体懒加载，只有真渲染 ```mermaid 才拉取，不进首屏。
const Mermaid = lazy(() => import('./Mermaid'))

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'

// 从 hast 节点递归取纯文本（供复制按钮用原始代码而非高亮后的 DOM）
function nodeText(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return node.value || ''
  return Array.isArray(node.children) ? node.children.map(nodeText).join('') : ''
}

const inlineCode: CSSProperties = {
  fontFamily: mono, fontSize: '0.88em', background: 'var(--border-subtle)',
  padding: '1px 5px', borderRadius: 4,
}

export default function Markdown({
  children,
  accent = '#58a6ff',
  resolveHref,
  onLinkClick,
  fill,
}: {
  children: string
  accent?: string
  resolveHref?: (href: string, kind: 'link' | 'image') => string
  onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void
  fill?: boolean // 整块代码/JSON 预览：让唯一的代码块撑满父容器高度
}) {
  const { t } = useI18n()
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55, wordBreak: 'break-word', height: fill ? '100%' : undefined }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // 段落/列表/标题 收紧默认大边距
          p: ({ children }) => <p style={{ margin: '4px 0' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
          h1: ({ children }) => <h1 style={{ fontSize: 18, margin: '8px 0 4px', fontWeight: 700 }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 16, margin: '8px 0 4px', fontWeight: 700 }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 14.5, margin: '6px 0 4px', fontWeight: 600 }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: 13.5, margin: '6px 0 4px', fontWeight: 600 }}>{children}</h4>,
          a: ({ children, href }) => {
            const resolved = href ? (resolveHref?.(href, 'link') || href) : undefined
            return <a href={resolved} target="_blank" rel="noreferrer" onClick={(e) => { if (href) onLinkClick?.(href, e) }} style={{ color: accent, textDecoration: 'underline' }}>{children}</a>
          },
          blockquote: ({ children }) => <blockquote style={{ margin: '6px 0', padding: '2px 10px', borderLeft: '3px solid var(--border)', color: 'var(--text-dim)' }}>{children}</blockquote>,
          hr: () => <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '8px 0' }} />,
          // pre 透传，由 code 统一加样式（块级 vs 行内）
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node }: any) => {
            const cls = className || ''
            const block = /hljs|language-/.test(cls) || nodeText(node).includes('\n')
            // 块级代码复用对话里的 CodeBox（hover 复制 + 主题色 + 语法高亮）
            if (block) {
              const raw = (node ? nodeText(node) : String(children)).replace(/\n$/, '')
              // ```mermaid → 渲染成可视化图（懒加载 mermaid），渲染失败回退源码
              if (/language-mermaid/.test(cls)) return <Suspense fallback={<div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>{t('mermaid.loading')}</div>}><Mermaid code={raw} /></Suspense>
              return <CodeBox text={raw} max={420} fill={fill} className={`hljs ${cls}`}>{children}</CodeBox>
            }
            return <code style={inlineCode}>{children}</code>
          },
          table: ({ children }) => <table style={{ borderCollapse: 'collapse', margin: '6px 0', fontSize: 12.5 }}>{children}</table>,
          th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '3px 8px', textAlign: 'left', background: 'var(--bg-container)' }}>{children}</th>,
          td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '3px 8px' }}>{children}</td>,
          img: ({ src, alt }) => <img src={src ? (resolveHref?.(src, 'image') || src) : src} alt={alt} style={{ maxWidth: '100%', borderRadius: 6 }} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
