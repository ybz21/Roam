// 对话页外壳：头部 / 滚动区 / 交互选择框 / 输入发送 / 文件侧栏。
// Claude、Codex 共用，差异只在 title、accent、占位文案与消息渲染(renderMessage)。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Grid, Input, App as AntApp } from 'antd'
import { api, upload, makeClipboardImageFile } from '../api'
import FileBrowser from '../FileBrowser'
import FloatingFileDrawer from '../FloatingFileDrawer'
import { PromptPanel, detectPrompt } from '../prompt'
import { useI18n } from '../i18n'
import { VoiceInput } from './VoiceInput'
import type { Msg } from './types'

export function ChatShell({ name, dir, accent, title, placeholder, onBack, onRefresh, messages, renderMessage, pending, busy, error }: {
  name: string
  dir?: string
  accent: string
  title: ReactNode
  placeholder: string
  onBack: () => void
  onRefresh?: () => void
  messages: Msg[]
  renderMessage: (m: Msg, i: number) => ReactNode
  pending?: ReactNode
  busy?: boolean
  error?: string
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState('')
  const [showFiles, setShowFiles] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [limit, setLimit] = useState(200) // 只渲染最近 N 条，超长转录不卡
  const [dragOver, setDragOver] = useState(false)
  const [dropMode, setDropMode] = useState<'upload' | 'path'>('upload')
  const [uploading, setUploading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const atBottom = useRef(true)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md // 手机窄屏：输入区换成「文本框独占一行 + 按钮行」竖排，避免挤成一坨

  // 把文本追加进输入框末尾（语音识别结果 / 路径插入共用）
  const appendText = (s: string) => setInput((v) => (v ? v.replace(/\s*$/, ' ') : '') + s + ' ')
  // 把路径以 @引用 插进输入框（文件侧栏「@」按钮 / 拖拽共用），与终端 toMention 一致
  const insertPath = (p: string) => appendText('@' + p)

  // 图片上传到 /tmp 并把完整路径插进输入框（等同桌面 Ctrl+V：不污染工作目录，模型按绝对路径读取）
  const uploadImagesToTmp = async (images: File[]) => {
    if (!images.length) return
    const res = await upload('/tmp', images)
    setInput((v) => (v ? v.replace(/\s*$/, ' ') : '') + res.saved.join(' ') + ' ')
    message.success(t('chat.uploadedFiles', { count: images.length, dir: '/tmp' }))
  }

  // 普通文件上传到会话工作目录并插入文件名，方便直接让模型处理
  const uploadFilesToCwd = async (files: File[]) => {
    if (!files.length) return
    const cwd = await api('GET', `/sessions/${encodeURIComponent(name)}/cwd`)
    const dir = cwd?.data?.dir
    if (!dir) { message.error(t('chat.cwdMissing')); return }
    const res = await upload(dir, files)
    const names = res.saved.map((p) => p.split('/').pop() || p)
    setInput((v) => (v ? v.replace(/\s*$/, ' ') : '') + names.join(' ') + ' ')
    message.success(t('chat.uploadedFiles', { count: names.length, dir }))
  }

  // 拖拽/📎 选择：图片走 /tmp+绝对路径（同 Ctrl+V），其余文件走工作目录+文件名。
  // 注意入参可能是 <input> 的 FileList——调用方须在本函数返回前(await 前)就取好，
  // 因为重置 input.value 会清空该 FileList（手机端上传图片报 NO_FILE 的根因）。
  const doUpload = async (files: FileList | File[]) => {
    const all = Array.from(files)
    if (!all.length || uploading) return
    setUploading(true)
    try {
      await uploadImagesToTmp(all.filter((f) => f.type.startsWith('image/')))
      await uploadFilesToCwd(all.filter((f) => !f.type.startsWith('image/')))
    } catch (e: any) { message.error(t('chat.uploadFailed', { message: e.message })) }
    finally { setUploading(false) }
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.items) return
    // 一次粘贴只取一张图：同一张截图常以多种 MIME 重复出现，全收会插入两次 @路径
    const imageFiles: File[] = []
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i]
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) { imageFiles.push(makeClipboardImageFile(f, item.type, imageFiles.length)); break }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      if (uploading) return
      setUploading(true)
      try { await uploadImagesToTmp(imageFiles) }
      catch (err: any) { message.error(t('chat.uploadFailed', { message: err.message })) }
      finally { setUploading(false) }
    }
  }

  const hidden = Math.max(0, messages.length - limit)
  const visible = hidden > 0 ? messages.slice(-limit) : messages

  // 贴底时自动跟随新消息；用户上滚后不打扰
  useEffect(() => {
    if (atBottom.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [messages, pending])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setShowJump(!atBottom.current)
  }

  const jump = () => {
    atBottom.current = true; setShowJump(false)
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true); setSendErr('')
    try { await api('POST', '/tasks/_/send', { sess: name, msg: text }); setInput(''); atBottom.current = true }
    catch (e: any) { setSendErr(e.message) }
    finally { setSending(false) }
  }

  // 中断生成：向会话注入 Escape（Claude / Codex 都按 Esc 打断当前回合）
  const stop = () => { api('POST', `/sessions/${encodeURIComponent(name)}/keys`, { keys: ['Escape'] }).catch(() => {}) }

  const errMsg = sendErr || error

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-term)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}
        onDragEnter={(e) => { e.preventDefault() }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation() // 对话区自己接住,别冒泡到 FileWorkspace 分栏层(否则会显示「分栏」提示并抢走 drop)
          const isPath = Array.from(e.dataTransfer.types || []).includes('application/x-ttmux-path')
          e.dataTransfer.dropEffect = 'copy'
          setDropMode(isPath ? 'path' : 'upload')
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setDragOver(false) // 阻断冒泡:否则分栏层还会再把文件当「开文件」打开一次
          const p = e.dataTransfer.getData('application/x-ttmux-path') || e.dataTransfer.getData('text/plain')
          if (p && !e.dataTransfer.files?.length) { insertPath(p); return } // 从文件侧栏拖来的：插入 @路径
          if (e.dataTransfer?.files?.length) doUpload(e.dataTransfer.files) // 从系统拖来的：上传
        }}>
        {dragOver && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', border: `2px dashed ${accent}`, borderRadius: 12, color: accent, fontSize: 15, fontWeight: 600 }}>
            {dropMode === 'path' ? t('chat.dropInsertPath') : t('chat.dropUpload')}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {title}
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{name}</span>
          <span style={{ flex: 1 }} />
          {onRefresh && <Button size="small" title={t('chat.refreshTranscript')} onClick={() => { atBottom.current = true; onRefresh() }}>{t('common.refresh')}</Button>}
          <Button size="small" type={showFiles ? 'primary' : 'default'} style={showFiles ? { background: accent, borderColor: accent } : {}} onClick={() => setShowFiles((s) => !s)}>📁 {t('chat.files')}</Button>
          <Button size="small" onClick={onBack}>{t('chat.backToTerminal')}</Button>
        </div>
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <div ref={boxRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', padding: '8px 12px' }}>
            {messages.length === 0 && !pending && <div style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: 30 }}>{t('chat.loadingTranscript')}</div>}
            {hidden > 0 && (
              <div style={{ textAlign: 'center', margin: '2px 0 8px' }}>
                <a onClick={() => setLimit((l) => l + 200)} style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('chat.loadEarlier', { count: hidden })}</a>
              </div>
            )}
            {visible.map(renderMessage)}
            {pending}
            {busy && <LiveTail name={name} />}
          </div>
          {showJump && (
            <button onClick={jump} title={t('chat.jumpToBottom')}
              style={{ position: 'absolute', right: 14, bottom: 12, width: 34, height: 34, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-container)', color: accent, fontSize: 16, cursor: 'pointer', boxShadow: 'var(--card-hover-shadow)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ↓
            </button>
          )}
        </div>
        {/* 交互式选择框（权限确认/选项菜单）：检测到才显示，可点选 */}
        <PromptPanel name={name} accent={accent} />
        {errMsg && <div style={{ color: '#f85149', fontSize: 12, padding: '2px 12px' }}>{errMsg}</div>}
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, padding: 10, borderTop: '1px solid var(--border)', alignItems: isMobile ? 'stretch' : 'flex-end' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) doUpload(fs) }} />
          {isMobile ? (
            // 手机端：文本框独占一行，操作钮（📎 / 语音 / 停止 / 发送）另起一行，语音钮内联进按钮行避免悬浮遮挡。
            <>
              <Input.TextArea
                value={input} onChange={(e) => setInput(e.target.value)}
                autoSize={{ minRows: 1, maxRows: 6 }} placeholder={placeholder}
                onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
                onPaste={onPaste}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button shape="circle" title={t('chat.uploadToCwd')} loading={uploading} onClick={() => fileRef.current?.click()}>📎</Button>
                <VoiceInput inline accent={accent} onResult={appendText} />
                <span style={{ flex: 1 }} />
                {busy && <Button danger title={t('chat.stopTitle')} onClick={stop}>{t('chat.stop')}</Button>}
                <Button type="primary" loading={sending} onClick={send} style={{ background: accent, borderColor: accent }}>{t('common.send')}</Button>
              </div>
            </>
          ) : (
            <>
              <Button title={t('chat.uploadToCwd')} loading={uploading} onClick={() => fileRef.current?.click()}>📎</Button>
              <Input.TextArea
                value={input} onChange={(e) => setInput(e.target.value)}
                autoSize={{ minRows: 1, maxRows: 5 }} placeholder={placeholder}
                onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
                onPaste={onPaste}
              />
              {busy && <Button danger title={t('chat.stopTitle')} onClick={stop}>{t('chat.stop')}</Button>}
              <Button type="primary" loading={sending} onClick={send} style={{ background: accent, borderColor: accent }}>{t('common.send')}</Button>
            </>
          )}
        </div>
        {/* 桌面端右下角悬浮语音按钮（长按说话，识别回填输入框）；手机端已内联到按钮行。 */}
        {!isMobile && <VoiceInput accent={accent} onResult={appendText} />}
      </div>
      <FloatingFileDrawer open={showFiles}>
        <FileBrowser dir={dir} accent={accent} onClose={() => setShowFiles(false)} onInsertPath={insertPath} />
      </FloatingFileDrawer>
    </div>
  )
}

// 把终端实况(capture)清洗成「干净的实时回复」：去掉方框线、底部输入框/提示、spinner 行，
// 只留正在生成的正文尾部。启发式、随 TUI 版本可能要微调，但作为实时预览足够。
const LEAD_BOX = /^[\s│┃|╎┆┊╭╰├╞┝─━═>❯]+/u
const TAIL_BOX = /[\s│┃|╎┆┊╮╯┤╡┥─━═]+$/u
const BOX_ONLY = /^[\s─━═│┃╭╮╰╯├┤┬┴┼╞╡╪.·]*$/u
const NOISE = /(esc to interrupt|esc to cancel|enter to select|tab\/arrow|to navigate|\? for shortcuts|ctrl\+|shift\+tab|bypass permissions|↑↓|tokens?\b|⧉|auto-?accept|for newline)/i
const SPINNER = /^[\s]*[●○◯⏺✶✳✻∗*•·✢✦✧✺✷+✽][\s]*$/u

function cleanTail(raw: string): string {
  const out: string[] = []
  for (let l of String(raw).replace(/\r/g, '').split('\n')) {
    l = l.replace(LEAD_BOX, '').replace(TAIL_BOX, '').replace(/^[●○◯⏺✶✳✻∗•·]\s?/u, '')
    if (!l.trim() || BOX_ONLY.test(l) || SPINNER.test(l) || NOISE.test(l)) continue
    out.push(l)
  }
  return out.slice(-10).join('\n')
}

function LiveTail({ name }: { name: string }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await api('GET', `/sessions/${encodeURIComponent(name)}/capture?lines=40`)
        const raw = r.data || ''
        // 交互式选择框交给 PromptPanel 专门渲染，这里不再重复显示（避免被截断/错乱）
        if (!stop) setText(detectPrompt(raw) ? '' : cleanTail(raw))
      } catch {}
    }
    poll()
    const t = setInterval(poll, 800)
    return () => { stop = true; clearInterval(t) }
  }, [name])
  if (!text) return null
  return (
    <div style={{ margin: '4px 0', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-base)', overflow: 'hidden' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="cc-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', display: 'inline-block' }} />
        {t('chat.liveTerminalOutput')}
      </div>
      <pre style={{ margin: 0, padding: '0 8px 8px', maxHeight: 160, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
    </div>
  )
}
