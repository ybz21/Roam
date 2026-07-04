// Mermaid 图渲染：把 ```mermaid 代码块渲成 SVG 图。
// mermaid 库很重（~解析器+布局引擎），只在真正遇到 mermaid 块时才动态 import，
// 不进首屏包（Vite 自动拆成独立 chunk）。
import { useEffect, useRef, useState } from 'react'
import { useThemeMode } from './theme'
import { useI18n } from './i18n'

// 全局只 import 一次 mermaid（多个图共用同一份），拿到默认导出的实例。
let mermaidPromise: Promise<any> | null = null
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default)
  return mermaidPromise
}

let seq = 0

// 已渲染 SVG 缓存（键含主题+源码）。作用：Markdown 因实时重载/流式而重渲时，Mermaid 会随之
// 重新挂载、state 归零 → 闪一下「渲染中」。挂载时用初始 state 直接从缓存取图 → 无缝、不闪。
const svgCache = new Map<string, string>()
const cacheKey = (mode: string, code: string) => mode + '\n' + code

export default function Mermaid({ code }: { code: string }) {
  const { mode } = useThemeMode()
  const { t } = useI18n()
  const [svg, setSvg] = useState(() => svgCache.get(cacheKey(mode, code)) || '')
  const [err, setErr] = useState('')
  const idRef = useRef(`mmd-${++seq}`)
  const svgRef = useRef(svg) // 记住上一张成功的图，供出错/流式时保留不闪
  svgRef.current = svg

  useEffect(() => {
    const key = cacheKey(mode, code)
    const cached = svgCache.get(key)
    if (cached) { setSvg(cached); setErr(''); return } // 命中缓存：直接用，不重渲、不闪
    let stop = false
    // 防抖：流式输出/实时重载会让 code 频繁变化，逐次渲染会闪。等 code 稳定 ~300ms 再渲一次。
    // 渲染期间保留旧 SVG（不清空、不切回「加载中」），新图算好后再原子替换 → 不闪。
    const timer = setTimeout(() => {
      loadMermaid().then(async (mermaid) => {
        try {
          // 随黑/白主题切换；securityLevel:strict → 净化用户内容里的脚本/危险属性。
          mermaid.initialize({ startOnLoad: false, theme: mode === 'dark' ? 'dark' : 'default', securityLevel: 'strict' })
          // render 的 id 每次唯一，避免 mermaid 复用同 id 的临时 DOM 出错。
          const { svg } = await mermaid.render(`${idRef.current}-${seq++}`, code)
          if (stop) return
          if (svgCache.size > 100) svgCache.clear() // 简单封顶，避免无限增长
          svgCache.set(key, svg)
          setSvg(svg); setErr('')
        } catch (e: any) {
          // 已有渲染好的图就保留它（流式中途语法暂不完整很常见），只在从没成功过时才显示错误。
          if (!stop && !svgRef.current) setErr(e?.message || String(e))
        }
      })
    }, 300)
    return () => { stop = true; clearTimeout(timer) }
  }, [code, mode])

  // 语法错误/渲染失败 → 回退显示源码，不让整段 Markdown 崩掉。
  if (err) {
    return (
      <div style={{ margin: '8px 0', border: '1px solid #d29922', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '4px 10px', fontSize: 12, color: '#d29922', background: 'var(--bg-container)' }}>{t('mermaid.renderFailed', { message: err })}</div>
        <pre style={{ margin: 0, padding: 12, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 12.5, color: 'var(--text-bright)', background: 'var(--bg-base)' }}>{code}</pre>
      </div>
    )
  }
  if (!svg) return <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>{t('mermaid.loading')}</div>
  return (
    <div
      className="mermaid-rendered"
      style={{ display: 'flex', justifyContent: 'center', margin: '8px 0', overflow: 'auto' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
