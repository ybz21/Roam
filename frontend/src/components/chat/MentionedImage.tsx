// 消息正文里被 @ 引用的图片，渲染成一张能点开看的缩略图卡片。
//
// 从前它只是一行 `@/tmp/Screenshot-….jpg`：粘完图发出去，自己回头翻这段对话，
// 得先把那串路径读懂、再想办法把文件找出来，才知道当时给 agent 看的是什么。
// 路径本身仍然要留给 agent（它就是靠 @ 认文件的），但**给人看的那一面**应该是图。
import { useState } from 'react'
import { Image } from 'antd'
import { nodeApi } from '../cluster/node-url'
import { useI18n } from '../../i18n'
import { ImageIcon } from '../../icons'

// 缩略图边长。coarse 指针下 44px 是可点的下限，这里给到 56 —— 卡片整体更高，
// 手指落在哪儿都点得中。
const THUMB = 56

export function MentionedImage({ path, onAccent }: {
  path: string
  /** 在实心强调色气泡里（用户消息）：卡片要用半透明白，默认那套边框在蓝底上看不见 */
  onAccent?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [dim, setDim] = useState('')
  const [broken, setBroken] = useState(false)
  const raw = nodeApi(`/file/raw?path=${encodeURIComponent(path)}`)
  const name = path.split('/').filter(Boolean).pop() || path

  // 缓存命中时 onLoad 会在 React 把它绑上去之前就烧掉，尺寸于是永远不出现。
  // ref 回调里补读一次 complete：翻回一段旧对话时走的正是这条路。
  const measure = (el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth) setDim(`${el.naturalWidth}×${el.naturalHeight}`)
  }

  // 取不到图就退回原样的路径文字：对话是历史记录，文件早被删掉是常态，
  // 那时候一张碎图标比一行路径更没用 —— 至少路径还告诉你它当时在哪。
  if (broken) {
    return <code style={{ fontSize: 'var(--fs-meta)', opacity: .85, wordBreak: 'break-all' }}>@{path}</code>
  }

  // 手机上气泡窄，尾部省略会把扩展名一起吃掉，而「.jpg 还是 .pdf」正是一眼要看的东西。
  // 从中间断，两头都留住。
  const shown = name.length > 34 ? `${name.slice(0, 20)}…${name.slice(-11)}` : name

  const border = onAccent ? '1px solid rgba(255,255,255,.28)' : '1px solid var(--border)'
  const dimText = onAccent ? 'rgba(255,255,255,.75)' : 'var(--text-dim)'

  return (
    <>
      {/* antd 的 preview 挂在一张隐藏图上，由卡片受控打开：
          这样整张卡片都是热区，而不是只有那块缩略图能点。 */}
      <Image
        src={raw}
        style={{ display: 'none' }}
        preview={{ visible: open, src: raw, onVisibleChange: (v) => setOpen(v) }}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${t('chat.viewImage')} ${name}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)',
          maxWidth: '100%', padding: 'var(--sp-1)', textAlign: 'left',
          border, borderRadius: 'var(--r-card)',
          background: onAccent ? 'rgba(255,255,255,.12)' : 'var(--bg-container)',
          color: 'inherit', cursor: 'pointer', font: 'inherit',
        }}
        className="tt-atimg"
      >
        <img
          src={raw}
          alt={name}
          width={THUMB}
          height={THUMB}
          loading="lazy"
          ref={measure}
          onLoad={(e) => measure(e.currentTarget)}
          onError={() => setBroken(true)}
          style={{ width: THUMB, height: THUMB, objectFit: 'cover', borderRadius: 'var(--r-sm)', flex: '0 0 auto', background: 'var(--bg-base)' }}
        />
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span title={name} style={{ fontSize: 'var(--fs-meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}</span>
          <span style={{ fontSize: 'var(--fs-micro)', color: dimText, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ImageIcon size={11} />
            {dim ? `${dim} · ` : ''}{t('chat.viewImage')}
          </span>
        </span>
      </button>
    </>
  )
}
