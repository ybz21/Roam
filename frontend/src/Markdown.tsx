// Markdown 渲染链（react-markdown + unified/micromark/hast 生态 + highlight.js）约 80KB gz，
// 首屏（终端/列表）用不到 → 实现放 MarkdownImpl.tsx 整体懒加载，真要渲染对话文本/.md 预览才拉取。
// chunk 到位前先按纯文本展示同样的内容，到位后无缝升级为富文本，不闪加载态。
import { lazy, Suspense } from 'react'
import type { ComponentProps } from 'react'

const Impl = lazy(() => import('./MarkdownImpl'))

export default function Markdown(props: ComponentProps<typeof Impl>) {
  return (
    <Suspense
      fallback={
        <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: props.fill ? '100%' : undefined }}>
          {props.children}
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  )
}
