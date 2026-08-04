// 工具调用的显示件：一行式 / 命令行 / 可折叠卡片 / diff / 待办 / 文件列表 / 错误行。
// 参考 claudecodeui（siteboon，AGPL-3.0）的 tools/components 分层：一屏里绝大多数工具
// 只值一行，值得展开的才给卡片——原先每个工具都套一张描边卡，十几次 Read 就把正文淹了。
// 这里按本仓库的令牌体系重写（无 Tailwind），颜色一律走 --accent / --ok / --warn / --danger。
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { cachedDiff, parsePatch } from './diff'
import { CheckIcon, ChevronRight, CircleIcon, ClockIcon, CopyIcon, WarnIcon } from '../icons'
import { copyText, MONO } from './blocks'
import { useChatActions } from './actions'

// 类别底色：蓝=读/查/计划，绿=命令，黄=改文件，红=错，灰=其它。四支色都是令牌，不写十六进制。
export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'neutral'

const TONE: Record<Tone, { line: string; soft: string; border: string }> = {
  accent: { line: 'var(--accent)', soft: 'var(--accent-soft)', border: 'var(--accent-border)' },
  ok: { line: 'var(--ok)', soft: 'var(--ok-soft)', border: 'var(--ok-border)' },
  warn: { line: 'var(--warn)', soft: 'var(--warn-soft)', border: 'var(--warn-border)' },
  danger: { line: 'var(--danger)', soft: 'var(--danger-soft)', border: 'var(--danger-border)' },
  neutral: { line: 'var(--border)', soft: 'transparent', border: 'var(--border)' },
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

// ── 小件 ────────────────────────────────────────────────────────────────

export function CopyBtn({ text, title }: { text: string; title?: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  return (
    <button className="cc-toolcopy" title={title || t('common.copy')} aria-label={title || t('common.copy')}
      onClick={(e) => { e.stopPropagation(); copyText(text); setDone(true); setTimeout(() => setDone(false), 1200) }}>
      {done ? <span style={{ color: 'var(--ok)', display: 'flex' }}><CheckIcon size={12} /></span> : <CopyIcon size={12} />}
    </button>
  )
}

// 状态：只有「跑着」和「出错/被拒」值得占位置——历史转录里每条都成功，
// 给每条都盖一枚 Completed 徽标等于没有信息。
export function StatusChip({ status }: { status?: ToolStatus }) {
  const { t } = useI18n()
  if (!status || status === 'ok') return null
  if (status === 'running') return <span className="cc-spin" title={t('chat.toolRunning')} aria-label={t('chat.toolRunning')} />
  const danger = status === 'error'
  return (
    <span style={{
      flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-micro)',
      padding: '1px 6px', borderRadius: 'var(--r-pill)', whiteSpace: 'nowrap',
      color: danger ? 'var(--danger)' : 'var(--warn)',
      background: danger ? 'var(--danger-soft)' : 'var(--warn-soft)',
    }}>{danger ? t('chat.toolFailed') : t('chat.toolDenied')}</span>
  )
}

// 长路径截头留尾：…/frontend/src/App.tsx。
// 有信息量的是**尾巴**（文件名 + 最近的几层目录），`/home/ai/codes/…` 那截谁都一样，
// 留着只会把真正要看的挤出去；CSS 的尾部省略正好反了，所以在这里算。
export function shortPath(p: string, keep = 44): string {
  const v = String(p ?? '')
  if (v.length <= keep) return v
  const parts = v.split('/')
  const file = parts.pop() || v
  if (file.length + 2 >= keep) return '…' + file.slice(-(keep - 1)) // 文件名本身就超长
  let tail = file
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i]) continue
    const next = `${parts[i]}/${tail}`
    if (next.length + 2 > keep) break
    tail = next
  }
  return '…/' + tail
}

// 路径：文件面板接得住就画成可点的链接，接不住就是普通文字（手机上没有面板时不给假链接）。
export function PathLink({ path, line, text, style }: { path: string; line?: number; text?: string; style?: React.CSSProperties }) {
  const { openFile } = useChatActions()
  const label = text ?? path
  if (!openFile || !path) return <span className="cc-toolval" style={{ fontFamily: MONO, ...style }} title={path}>{label}</span>
  return (
    <button className="cc-toolval cc-pathlink" style={{ fontFamily: MONO, ...style }} title={path}
      onClick={(e) => { e.stopPropagation(); openFile(path, line) }}>{label}</button>
  )
}

// 左侧色条 + 一行内容：Read / Grep / Glob / 网络请求这类「知道发生了就够」的工具。
export function ToolRow({ icon, label, value, secondary, tone = 'neutral', status, copy, path, line }: {
  icon?: ReactNode
  label: string
  value?: string
  secondary?: string
  tone?: Tone
  status?: ToolStatus
  copy?: string
  path?: string
  line?: number
}) {
  return (
    <div className="cc-toolrow" style={{ borderLeft: `2px solid ${TONE[tone].line}` }}>
      {icon && <span style={{ flex: '0 0 auto', color: TONE[tone].line, display: 'flex' }}>{icon}</span>}
      <span style={{ flex: '0 0 auto', color: 'var(--text-dim)' }}>{label}</span>
      {value && (path
        ? <PathLink path={path} line={line} text={value} />
        : <span className="cc-toolval" style={{ fontFamily: MONO }} title={value}>{value}</span>)}
      {!value && <span style={{ flex: 1 }} />}
      {secondary && <span style={{ flex: '0 0 auto', color: 'var(--text-dimmer)', fontSize: 'var(--fs-micro)' }}>{secondary}</span>}
      <StatusChip status={status} />
      {copy && <CopyBtn text={copy} />}
    </div>
  )
}

// 命令行：`$ cmd` 一行，有输出就整行变成可展开的下拉，输出内联在下面。
// 折叠时右侧显示行数；跑着时是转圈，不是一枚静态徽标。
export function CommandRow({ command, description, output, isError, status, label }: {
  command: string
  description?: string
  output?: string
  isError?: boolean
  status?: ToolStatus
  label?: string
}) {
  const { t } = useI18n()
  const text = (output || '').replace(/\s+$/, '')
  const has = text.length > 0
  const lines = has ? text.split('\n').length : 0
  const [open, setOpen] = useState(false)
  // 出错默认展开一次：红边只说明「失败了」，人下一步一定是想看为什么。
  const auto = useRef(false)
  useEffect(() => {
    if (!auto.current && has && isError) { auto.current = true; setOpen(true) }
  }, [has, isError])
  const toggle = () => { if (has) setOpen((v) => !v) }
  return (
    <div className="cc-cmd" style={{ borderColor: isError ? 'var(--danger-border)' : 'var(--border)' }}>
      <div className={`cc-cmd-head${has ? ' is-clickable' : ''}`} role={has ? 'button' : undefined} tabIndex={has ? 0 : undefined}
        aria-expanded={has ? open : undefined} onClick={toggle}
        onKeyDown={(e) => { if (has && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}>
        <span className="cc-cmd-chev" style={{ opacity: has ? 1 : 0, transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={12} /></span>
        <span style={{ flex: '0 0 auto', color: 'var(--ok)', fontFamily: MONO, fontWeight: 600, userSelect: 'none' }}>{label || '$'}</span>
        <span className={open ? 'cc-cmd-text is-open' : 'cc-cmd-text'} style={{ fontFamily: MONO }}>{command}</span>
        <StatusChip status={status} />
        {!open && has && status !== 'running' && (
          <span className="cc-cmd-lines">{t('chat.outputLines', { count: lines })}</span>
        )}
        <CopyBtn text={command} />
      </div>
      {description && <div className="cc-cmd-desc">{description}</div>}
      {open && has && (
        <pre className="cc-cmd-out" style={{ color: isError ? 'var(--danger)' : 'var(--text-dim)' }}>{text}</pre>
      )}
    </div>
  )
}

// 可折叠卡片：Edit / Write / apply_patch / TodoWrite / 子代理 / 计划这些有内容可看的。
export function ToolCard({ icon, label, title, tone = 'neutral', status, defaultOpen, raw, children }: {
  icon?: ReactNode
  label: string
  title?: string
  tone?: Tone
  status?: ToolStatus
  defaultOpen?: boolean
  raw?: string
  children?: ReactNode
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(!!defaultOpen)
  const [rawOpen, setRawOpen] = useState(false)
  return (
    <div className="cc-toolcard" style={{ borderLeft: `2px solid ${TONE[tone].line}` }}>
      <div className="cc-toolcard-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }}>
        <span className="cc-cmd-chev" style={{ transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={12} /></span>
        {icon && <span style={{ flex: '0 0 auto', color: TONE[tone].line, display: 'flex' }}>{icon}</span>}
        <span style={{ flex: '0 0 auto', color: 'var(--text-dim)' }}>{label}</span>
        {title && <span className="cc-toolval" style={{ fontFamily: MONO }} title={title}>{title}</span>}
        {!title && <span style={{ flex: 1 }} />}
        <StatusChip status={status} />
      </div>
      {open && (
        <div className="cc-toolcard-body">
          {children}
          {raw && (
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <a className="cc-toolraw" onClick={() => setRawOpen((v) => !v)}>
                <span className="cc-cmd-chev" style={{ transform: rawOpen ? 'rotate(90deg)' : 'none' }}><ChevronRight size={10} /></span>
                {t('chat.rawParams')}
              </a>
              {rawOpen && <pre className="cc-toolraw-body">{raw}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 内容件 ──────────────────────────────────────────────────────────────

// 行对齐 diff：文件名 + 角标做头，下面只列真正变动的行（带行号槽）。
export const DiffPane = memo(function DiffPane({ oldText, newText, path, badge, badgeTone = 'neutral' }: {
  oldText: string
  newText: string
  path?: string
  badge?: string
  badgeTone?: Tone
}) {
  const lines = useMemo(() => cachedDiff(oldText || '', newText || ''), [oldText, newText])
  const plus = lines.filter((l) => l.type === 'added').length
  const minus = lines.length - plus
  const copyable = lines.map((l) => (l.type === 'added' ? '+' : '-') + l.content).join('\n')
  return (
    <div className="cc-diff">
      <div className="cc-diff-head">
        {path ? <PathLink path={path} text={shortPath(path)} style={{ color: 'var(--text-dim)' }} /> : <span style={{ flex: 1 }} />}
        <span className="cc-diff-stat" style={{ color: 'var(--ok)' }}>+{plus}</span>
        <span className="cc-diff-stat" style={{ color: 'var(--danger)' }}>−{minus}</span>
        {badge && <span className="cc-diff-badge" style={{ color: TONE[badgeTone].line, background: TONE[badgeTone].soft }}>{badge}</span>}
        <CopyBtn text={copyable} />
      </div>
      <div className="cc-diff-body">
        {lines.map((l, i) => {
          const add = l.type === 'added'
          return (
            <div key={i} className="cc-diff-line" style={{ background: add ? 'var(--ok-soft)' : 'var(--danger-soft)' }}>
              <span className="cc-diff-num">{l.lineNum}</span>
              <span className="cc-diff-sign" style={{ color: add ? 'var(--ok)' : 'var(--danger)' }}>{add ? '+' : '-'}</span>
              <span className="cc-diff-text" style={{ color: add ? 'var(--ok)' : 'var(--danger)' }}>{l.content || ' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
})

// Codex 的 apply_patch 是补丁文本：按 *** Update File: 切成每个文件一段再着色。
export function PatchPane({ text }: { text: string }) {
  const files = useMemo(() => parsePatch(text), [text])
  if (!files.length) return <PatchLines lines={String(text).split('\n')} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      {files.map((f, i) => (
        <div key={i} className="cc-diff">
          <div className="cc-diff-head">
            <PathLink path={f.path} text={shortPath(f.path)} style={{ color: 'var(--text-dim)' }} />
            <span className="cc-diff-badge" style={{ color: TONE[f.op === 'delete' ? 'danger' : f.op === 'add' ? 'ok' : 'warn'].line, background: TONE[f.op === 'delete' ? 'danger' : f.op === 'add' ? 'ok' : 'warn'].soft }}>{f.op}</span>
            <CopyBtn text={f.lines.join('\n')} />
          </div>
          <div className="cc-diff-body"><PatchLines lines={f.lines} /></div>
        </div>
      ))}
    </div>
  )
}

function PatchLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((l, i) => {
        const add = l.startsWith('+')
        const del = l.startsWith('-')
        const hunk = l.startsWith('@@')
        return (
          <div key={i} className="cc-diff-line" style={{ background: add ? 'var(--ok-soft)' : del ? 'var(--danger-soft)' : 'transparent' }}>
            <span className="cc-diff-text" style={{ paddingLeft: 'var(--sp-2)', color: add ? 'var(--ok)' : del ? 'var(--danger)' : hunk ? 'var(--accent)' : 'var(--text-dim)' }}>{l || ' '}</span>
          </div>
        )
      })}
    </>
  )
}

export type TodoItem = { content: string; status?: string; activeForm?: string; id?: string }

// 待办 / 计划步骤：状态用画的图标，不用 ● ○ ✓ 这类字符（设计系统硬规则）。
export function TodoPane({ items }: { items: TodoItem[] }) {
  const { t } = useI18n()
  const done = items.filter((i) => i.status === 'completed').length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-dimmer)' }}>{t('chat.todoProgress', { done, total: items.length })}</div>
      {items.map((it, i) => {
        const s = it.status
        const mark = s === 'completed' ? <span style={{ color: 'var(--ok)', display: 'flex' }}><CheckIcon size={12} /></span>
          : s === 'in_progress' ? <span style={{ color: 'var(--warn)', display: 'flex' }}><ClockIcon size={12} /></span>
            : <span style={{ color: 'var(--text-dimmer)', display: 'flex' }}><CircleIcon size={12} /></span>
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)', fontSize: 'var(--fs-meta)',
            color: s === 'completed' ? 'var(--text-dimmer)' : s === 'in_progress' ? 'var(--text-bright)' : 'var(--text-dim)',
            textDecoration: s === 'completed' ? 'line-through' : 'none',
          }}>
            <span style={{ marginTop: 2 }}>{mark}</span>
            {it.id && <span style={{ flex: '0 0 auto', color: 'var(--text-dimmer)', fontFamily: MONO }}>#{it.id}</span>}
            <span>{it.content}</span>
          </div>
        )
      })}
    </div>
  )
}

// 搜索结果：一行一个命中，能点就点开对应文件（带行号的直接跳到那一行）。
export function FileListPane({ hits }: { hits: { path: string; line?: number; text: string }[] }) {
  const { openFile } = useChatActions()
  return (
    <div className="cc-filelist">
      {hits.map((h, i) => (openFile
        ? <button key={i} className="cc-filelist-row is-link" title={h.path} onClick={() => openFile(h.path, h.line)}>{h.text}</button>
        : <div key={i} className="cc-filelist-row" title={h.path}>{h.text}</div>))}
    </div>
  )
}

// 错误：折叠成一行红条，收起时给一行预览，展开看全文。
export function ErrorRow({ text }: { text: string }) {
  const { t } = useI18n()
  const body = String(text || '').trim()
  const has = body.length > 0
  const [open, setOpen] = useState(false)
  const toggle = () => { if (has) setOpen((v) => !v) }
  return (
    <div className="cc-err">
      <div className={`cc-cmd-head${has ? ' is-clickable' : ''}`} role={has ? 'button' : undefined} tabIndex={has ? 0 : undefined}
        aria-expanded={has ? open : undefined} onClick={toggle}
        onKeyDown={(e) => { if (has && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}>
        <span className="cc-cmd-chev" style={{ opacity: has ? 1 : 0, transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={12} /></span>
        <span style={{ flex: '0 0 auto', color: 'var(--danger)', display: 'flex' }}><WarnIcon size={12} /></span>
        <span style={{ flex: '0 0 auto', color: 'var(--danger)', fontWeight: 600 }}>{t('chat.toolError')}</span>
        {!open && has && <span className="cc-err-peek">{body}</span>}
        {(open || !has) && <span style={{ flex: 1 }} />}
        {has && <CopyBtn text={body} />}
      </div>
      {open && has && <pre className="cc-cmd-out" style={{ color: 'var(--danger)' }}>{body}</pre>}
    </div>
  )
}

// 普通工具输出：折叠一行，展开看全文（默认收起，行数写在标题上）。
export function OutputPane({ text, label, defaultOpen }: { text: string; label?: string; defaultOpen?: boolean }) {
  const { t } = useI18n()
  const body = String(text || '').replace(/\s+$/, '')
  const [open, setOpen] = useState(!!defaultOpen)
  if (!body) return null
  const lines = body.split('\n').length
  return (
    <div style={{ marginTop: 'var(--sp-1)' }}>
      <a className="cc-toolraw" onClick={() => setOpen((v) => !v)}>
        <span className="cc-cmd-chev" style={{ transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={10} /></span>
        {label || t('common.output')}
        <span style={{ color: 'var(--text-dimmer)' }}>{t('chat.outputLines', { count: lines })}</span>
      </a>
      {open && <pre className="cc-cmd-out">{body}</pre>}
    </div>
  )
}
