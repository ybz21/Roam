// 对话页外壳：滚动区 / 交互选择框 / 输入发送。
// 会话名、切回终端、文件面板都在上方的会话工具条里，这里不再重复一行头部。
// Claude、Codex 共用，差异只在 accent、占位文案与消息渲染(renderMessage)。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input, App as AntApp } from 'antd'
import { api, upload, makeClipboardImageFile } from '../api'
import { PromptPanel } from '../prompt'
import { usePreferences } from '../preferences'
import { useI18n } from '../i18n'
import { VoiceInput } from './VoiceInput'
import type { Block, Msg } from './types'
import { groupRuns } from './runs'
import { ToolRun } from './ToolRun'
import { LiveTail } from './LiveTail'
import { useLayout } from '../layout'
import { ArrowToBottom, ArrowUp, FileTextIcon, PaperclipIcon, StopIcon } from '../icons'
import { ChatActionsProvider } from './actions'
import type { TaskIndex } from './tasks'
import { StatusBar, type StatusActions } from './StatusBar'
import type { AgentStatus } from './status'

export function ChatShell({ name, accent, placeholder, messages, results, renderMessage, pending, busy, error, onOpenFile, tasks, status, onOpenGit, lastErrorId }: {
  name: string
  accent: string
  placeholder: string
  messages: Msg[]
  /** tool_use id → tool_result。给了就把相邻的同族工具并成运行组（设计 16） */
  results?: Record<string, Block>
  renderMessage: (m: Msg, i: number) => ReactNode
  pending?: ReactNode
  busy?: boolean
  error?: string
  onOpenFile?: (path: string, line?: number) => void
  tasks?: TaskIndex
  status?: AgentStatus
  onOpenGit?: () => void
  lastErrorId?: string
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState('')
  const [showJump, setShowJump] = useState(false)
  // 未读：上滚离底之后新来了几条。贴底时恒为 0（看得见就不叫未读）。
  const [unread, setUnread] = useState(0)
  const seenCount = useRef(0)
  const [limit, setLimit] = useState(200) // 只渲染最近 N 条，超长转录不卡
  const [dragOver, setDragOver] = useState(false)
  const [dropMode, setDropMode] = useState<'upload' | 'path'>('upload')
  const [uploading, setUploading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const atBottom = useRef(true)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  // 手机窄屏：输入区换成「文本框独占一行 + 按钮行」竖排，避免挤成一坨
  const { phone: isMobile } = useLayout()
  // 语音按钮的显隐跟终端工具条那颗「语音输入」开关是同一个偏好：关了就整个页面都不出现麦克风。
  const [prefs] = usePreferences()
  const showVoice = prefs.showVoiceButton !== false
  // 触屏上点按钮不夺走文本框焦点 → 软键盘不收起 → 布局不回弹，click 不会落空（同 App 的 noBlur）。
  const noBlur = (e: React.MouseEvent) => { if (isMobile) e.preventDefault() }

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

  // TUI 会把用户刚发的那句回显在框里，实时回显要按它去重
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].blocks.map((b) => b.text || '').join('\n').trim()
    }
    return ''
  }, [messages])

  const hidden = Math.max(0, messages.length - limit)
  const visible = hidden > 0 ? messages.slice(-limit) : messages
  // 连着的同族工具调用并成运行组（设计 16）。分组只能在这一层做：Claude 每次工具调用
  // 单独成一条消息，一串 5 条命令就是 5 条消息，消息内部的分段对它无能为力。
  const items = useMemo(() => (results ? groupRuns(visible, results) : null), [visible, results])

  // 贴底时自动跟随新消息；用户上滚后不打扰，改成累计未读
  useEffect(() => {
    if (atBottom.current) {
      if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
      seenCount.current = messages.length
      setUnread(0)
    } else {
      setUnread(Math.max(0, messages.length - seenCount.current))
    }
  }, [messages, pending])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setShowJump(!atBottom.current)
    if (atBottom.current) { seenCount.current = messages.length; setUnread(0) }
  }

  const jump = () => {
    atBottom.current = true; setShowJump(false)
    seenCount.current = messages.length; setUnread(0)
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
  // 工具行里的路径要能点开：用 context 送到最里层，不然要一路穿过工具注册表
  const actions = useMemo(() => ({ openFile: onOpenFile, tasks }), [onOpenFile, tasks])
  const hasStatus = !!(status && (status.mode || status.context || status.tasks || status.quota != null || status.branch || status.errors))

  // 状态条上每一格自己那件事。三件都落在这一层：这里既有会话名（能注入按键、能发消息），
  // 又有滚动容器（能定位到某条消息），再往上传反而绕。
  const statusActions: StatusActions = useMemo(() => ({
    // 轮换权限模式＝在 TUI 里按 Shift+Tab，跟人手动按是同一个动作。
    // 乐观更新没意义：下一轮转录会带回真实的 permission-mode 行，等它对账即可。
    onCycleMode: () => { api('POST', `/sessions/${encodeURIComponent(name)}/keys`, { keys: ['BTab'] }).catch(() => {}) },
    onOpenGit,
    onJumpError: lastErrorId ? () => {
      const el = boxRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(lastErrorId)}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      // 闪一下：一屏里可能有好几条红，得指明是「这一条」
      el.classList.add('cc-flash')
      setTimeout(() => el.classList.remove('cc-flash'), 1200)
    } : undefined,
    onCompact: () => { api('POST', '/tasks/_/send', { sess: name, msg: '/compact' }).catch(() => {}) },
  }), [name, onOpenGit, lastErrorId])

  return (
    <ChatActionsProvider value={actions}>
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
          <div style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-2)', background: 'rgba(0,0,0,0.45)', border: `2px dashed ${accent}`, borderRadius: 'var(--r-card)', color: accent, fontSize: 'var(--fs-lg)', fontWeight: 600 }}>
            {dropMode === 'path' ? <FileTextIcon size={16} /> : <PaperclipIcon size={16} />}
            {dropMode === 'path' ? t('chat.dropInsertPath') : t('chat.dropUpload')}
          </div>
        )}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <div ref={boxRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', padding: '8px 12px' }}>
            {messages.length === 0 && !pending && <div style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: 30 }}>{t('chat.loadingTranscript')}</div>}
            {hidden > 0 && (
              <div style={{ textAlign: 'center', margin: '2px 0 8px' }}>
                <a onClick={() => setLimit((l) => l + 200)} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)', color: 'var(--text-dim)', fontSize: 'var(--fs-meta)' }}>
                  <ArrowUp size={12} />{t('chat.loadEarlier', { count: hidden })}
                </a>
              </div>
            )}
            {items
              ? items.map((it, i) => (it.kind === 'run'
                ? <ToolRun key={it.run.key} run={it.run} isLast={i === items.length - 1} />
                : renderMessage(it.msg, it.index)))
              : visible.map(renderMessage)}
            {/* 实时回显自带「正在生成」那颗脉冲点，扒不到东西时才退回省略号气泡——
                两个都画等于同一件事说两遍（见截图里那块重复） */}
            {busy ? <LiveTail name={name} accent={accent} idle={pending} lastUser={lastUserText} /> : pending}
          </div>
          {/* 「回到底部」已并进下方状态条（带未读数）；状态条一个字段都没有时（刚进页面、
              转录还没扫出状态）才退回这颗悬浮钮，免得离底了没处点。 */}
          {showJump && !hasStatus && (
            <button onClick={jump} title={t('chat.jumpToBottom')}
              style={{ position: 'absolute', right: 14, bottom: 12, width: 34, height: 34, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-container)', color: accent, cursor: 'pointer', boxShadow: 'var(--card-hover-shadow)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ArrowToBottom size={16} />
            </button>
          )}
          {/* 桌面端悬浮语音按钮（长按说话，识别回填输入框）：挂在消息区这层而不是整页外壳——
              它是 bottom:54 的绝对定位，挂外层时会压住底部输入行的「停止/发送」（输入框一涨到
              两行以上尤其明显，点上去变成录音）和上方的选择框面板。挂这层就永远浮在输入区之上，
              与 bottom:12 的「回到底部」钮天然错开。手机端不走这里，已内联到按钮行。 */}
          {!isMobile && showVoice && <VoiceInput accent={accent} onResult={appendText} />}
        </div>
        {/* 状态条在选择框之上：选择框要人立刻动手，得离输入框更近 */}
        {(hasStatus || unread > 0) && (
          <StatusBar status={status || {}} accent={accent} unread={unread} onJump={jump} actions={statusActions} />
        )}
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
                <Button shape="circle" title={t('chat.uploadToCwd')} loading={uploading} onMouseDown={noBlur} onClick={() => fileRef.current?.click()} icon={<PaperclipIcon size={15} />} />
                {showVoice && <VoiceInput inline accent={accent} onResult={appendText} />}
                <span style={{ flex: 1 }} />
                {busy && <Button danger title={t('chat.stopTitle')} onMouseDown={noBlur} onClick={stop} icon={<StopIcon size={11} />}>{t('chat.stop')}</Button>}
                <Button type="primary" loading={sending} onMouseDown={noBlur} onClick={send} style={{ background: accent, borderColor: accent }}>{t('common.send')}</Button>
              </div>
            </>
          ) : (
            <>
              <Button title={t('chat.uploadToCwd')} loading={uploading} onClick={() => fileRef.current?.click()} icon={<PaperclipIcon size={15} />} />
              <Input.TextArea
                value={input} onChange={(e) => setInput(e.target.value)}
                autoSize={{ minRows: 1, maxRows: 5 }} placeholder={placeholder}
                onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
                onPaste={onPaste}
              />
              {busy && <Button danger title={t('chat.stopTitle')} onClick={stop} icon={<StopIcon size={11} />}>{t('chat.stop')}</Button>}
              <Button type="primary" loading={sending} onClick={send} style={{ background: accent, borderColor: accent }}>{t('common.send')}</Button>
            </>
          )}
        </div>
      </div>
    </div>
    </ChatActionsProvider>
  )
}
