// 视频/音频展示：浏览器原生播放器直接放后端 raw。
// 后端 /file/raw 走 http.ServeFile，本来就带 Accept-Ranges 与按扩展名判定的 Content-Type，
// 所以拖进度条是真正的分段请求，不会为了跳一下把整个文件先拉完。
import { useEffect, useRef } from 'react'
import { PreviewShell } from './PreviewShell'
import { useI18n } from '../../../i18n'

export function MediaView({ path, rawUrl, name, audio, inline }: {
  path: string
  rawUrl: string
  name: string
  audio?: boolean
  inline?: boolean
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLMediaElement>(null)
  // 关掉这一页就把流掐掉。只把元素从 DOM 摘掉不够：那条 range 请求还挂在那儿继续灌，
  // 手机走 Wi-Fi 时它会把后面所有接口都堵在后面，表现为「切到别的页还卡着」。
  useEffect(() => () => {
    const el = ref.current
    if (!el) return
    try { el.pause(); el.removeAttribute('src'); el.load() } catch { /* 已经拆了 */ }
  }, [])
  const fallback = (
    <>
      {t('file.mediaUnsupported')}
      <a href={rawUrl} download={name} style={{ color: 'var(--accent)' }}>{t('file.download')}</a>
    </>
  )
  // preload="none"：点开文件 ≠ 想看。metadata 一档在这儿等于整段下载——很多 mp4 的 moov 在
  // 文件末尾（ffmpeg 不加 +faststart 就是这样），浏览器为了读到时长会一路拉到底：实测
  // 25MB 的片子一挂上就是一条 24.8MB 的请求。改成按下播放键才开始取。
  const common = { ref: ref as never, src: rawUrl, controls: true, preload: 'none' as const }
  return (
    <PreviewShell path={path} title={audio ? t('file.audioPreview') : t('file.videoPreview')} inline={inline}>
      <div style={{ height: '100%', minHeight: audio ? undefined : 220, display: 'grid', placeItems: 'center', padding: audio ? 'var(--sp-3)' : 0, background: audio ? undefined : '#000' }}>
        {audio ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio {...common} style={{ width: '100%' }}>{fallback}</audio>
        ) : (
          // playsInline 是手机上的关键：不写的话 iOS Safari 一律抢成全屏播放，
          // 从文件面板点开一段视频会把整个工作区顶掉。
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video {...common} playsInline style={{ maxWidth: '100%', maxHeight: '100%' }}>{fallback}</video>
        )}
      </div>
    </PreviewShell>
  )
}
