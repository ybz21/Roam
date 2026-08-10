// HTML 展示：不在前端拼 DOM，直接 iframe 后端服务代理(/api/file/serve/<绝对路径> 以
// text/html 直出)，脚本/样式按原样运行；绝对路径进 URL 路径 → 同目录相对引用(css/js/img)
// 能被浏览器解析到同目录资源。key 绑 mtime → 文件被外部(cc/codex)改动时 iframe 自动重载。
import { useCallback, useEffect, useRef } from 'react'
import { useThemeMode } from '../../../theme'

const TRANSPARENT = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)'])
// 标记这份文档的 color-scheme 是我们改的：'derived' 按页面自己的底色定，'canvas' 是页面
// 没底色、连底色一起由我们铺。换主题时据此重来，不会把自己铺的底当成页面自带的。
const MARK = 'ttmuxScheme'

// 画布底色的明暗——只需分两档，用感知亮度近似（0.5 为界）即可。
function isDarkColor(rgb: string) {
  const [r, g, b] = (rgb.match(/[\d.]+/g) || []).map(Number)
  if ([r, g, b].some((v) => !Number.isFinite(v))) return false
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

export function HtmlView({ rawUrl, name, mtime, height }: {
  rawUrl: string
  name: string
  mtime?: number
  height: string
}) {
  const { mode } = useThemeMode()
  const ref = useRef<HTMLIFrameElement>(null)

  // iframe 里是另一份文档：外面的 color-scheme 不跨帧传，给 iframe 元素铺的底也盖不住它的
  // 画布。于是深色页面在黑主题下右边挂一条白滚动条，只给卡片上色、body 不铺底的（设计稿
  // 最典型）更是每道 gutter 都漏白。serve 与前端同源 → 载入后进去按页面自己的底色定
  // color-scheme（滚动条/默认文字色跟着页面走），页面没底色时才铺主题底色、跟应用主题走。
  // 页面自己声明过 color-scheme 的，说明它已经想好了，一概不碰。
  const applyScheme = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument
      const root = doc?.documentElement
      if (!root) return
      const mark = root.dataset[MARK]
      const style = getComputedStyle(root)
      if (!mark && style.colorScheme !== 'normal') return
      const own = mark === 'canvas' ? '' : [style.backgroundColor, doc.body && getComputedStyle(doc.body).backgroundColor]
        .find((c) => c && !TRANSPARENT.has(c)) || ''
      root.style.colorScheme = own ? (isDarkColor(own) ? 'dark' : 'light') : mode
      root.style.background = own ? '' : getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
      root.dataset[MARK] = own ? 'derived' : 'canvas'
    } catch {
      // 同源以外（不该发生）读不到 contentDocument，保持页面原样
    }
  }, [mode])

  useEffect(applyScheme, [applyScheme]) // 已经载入的 iframe 跟着主题切换重来一遍

  return (
    <iframe
      key={mtime}
      ref={ref}
      title={name}
      src={rawUrl}
      onLoad={applyScheme}
      style={{ display: 'block', width: '100%', height, border: 0, background: 'var(--bg-base)' }}
    />
  )
}
