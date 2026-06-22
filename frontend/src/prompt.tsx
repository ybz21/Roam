// 交互式选择框检测与响应 —— 供 ClaudeChat / CodexChat 专业渲染模式复用。
//
// 背景：Claude/Codex 的权限确认、选项菜单是终端 TUI 实时状态，不在 JSONL transcript 里，
// 所以对话面板渲染不出、也无从响应。这里从实时屏幕(capture，纯文本含 ❯/框线)解析出
// 选择框，渲染成可点按钮；点击经 POST /sessions/:name/keys 注入原始按键完成选择。
import { useEffect, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

export interface Choice { num: number; label: string; selected: boolean }
export interface Prompt { kind: 'select' | 'yesno'; question: string; choices: Choice[] }

const CURSOR = /[❯➤▶►▸→›»☞◉●>]/u                      // 选中游标常见字形（含 ASCII >）
const LEAD = /^[\s│┃|╎┆┊╭╰├╞┝─━═]+/u                  // 行首方框线/竖线/空白
const TAIL = /[\s│┃|╎┆┊╮╯┤╡┥─━═]+$/u                  // 行尾同上
const OPT = /^(?:[❯➤▶►▸→›»☞◉●>]\s*)?(\d+)[.)]\s+(\S.*)$/u // [游标?] N. 文本
const KW = /(would you like|proceed|allow|continue|overwrite|apply|approve|trust|run|command|是否|确认|继续|允许|要不要|执行|命令)/i
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const CTRL = /[\x00-\x08\x0b-\x1f\x7f]/g
const stripCtl = (s: string) => s.replace(ANSI, '').replace(CTRL, '')
const clean = (s: string) => stripCtl(s).replace(LEAD, '').replace(TAIL, '').trim()

// 从一屏纯文本里解析当前是否有交互式选择框；没有则返回 null
export function detectPrompt(capture: string): Prompt | null {
  const lines = stripCtl(capture || '').replace(/\r/g, '').split('\n')
  type P = { num: number; label: string; selected: boolean; idx: number }
  const opts: P[] = []
  lines.forEach((raw, idx) => {
    const m = clean(raw).match(OPT)
    if (m) opts.push({ num: Number(m[1]), label: m[2].trim(), selected: CURSOR.test(raw), idx })
  })
  // 取最后一组相邻选项（允许 ≤3 行间隔，兼容 Codex 长选项换行）
  const g: P[] = []
  for (let i = opts.length - 1; i >= 0; i--) {
    if (!g.length) g.unshift(opts[i])
    else if (g[0].idx - opts[i].idx <= 3) g.unshift(opts[i])
    else break
  }
  // 必须是从 1 起的连续编号、至少两项 —— 否则当普通编号列表，不误判
  const sequential = g.length >= 2 && g.every((o, k) => o.num === k + 1)
  if (sequential) {
    const qlines: string[] = []
    for (let i = g[0].idx - 1; i >= 0 && g[0].idx - i <= 6; i--) {
      const c = clean(lines[i])
      if (!c) { if (qlines.length) break; else continue }
      if (OPT.test(c)) continue
      qlines.unshift(c)
      if (qlines.length >= 3) break
    }
    const question = qlines.join(' ').trim()
    const windowText = lines.slice(Math.max(0, g[0].idx - 8), Math.min(lines.length, g[g.length - 1].idx + 3)).map(clean).join(' ')
    // 有游标，或上下文像个确认提示 → 认定为选择框（capture 无颜色，故用游标/关键词双保险）
    if (g.some((o) => o.selected) || KW.test(question) || KW.test(windowText)) {
      const choices = g.map((o) => ({ num: o.num, label: o.label, selected: o.selected }))
      if (!choices.some((c) => c.selected)) choices[0].selected = true
      return { kind: 'select', question, choices }
    }
  }
  // y/n 兜底
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= 12; i--) {
    const c = clean(lines[i])
    if (/\((?:y\/n|yes\/no|y\/N|Y\/n)\)|\[y\/n\]/i.test(c)) return { kind: 'yesno', question: c, choices: [] }
  }
  return null
}

function PromptActions({ p, accent, busy, choose, press }: {
  p: Prompt
  accent: string
  busy: boolean
  choose: (target: Choice) => void
  press: (keys: string[]) => void
}) {
  const { t } = useI18n()
  return (
    <>
      {p.question && <div style={{ color: 'var(--text-bright)', fontSize: 13, marginBottom: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.question}</div>}
      {p.kind === 'select' ? (
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          {p.choices.map((ch) => (
            <Button key={ch.num} block disabled={busy} onClick={() => choose(ch)}
              style={{
                textAlign: 'left', height: 'auto', minHeight: 32, whiteSpace: 'normal', padding: '6px 10px',
                borderColor: ch.selected ? accent : 'var(--border)', color: 'var(--text-bright)',
                background: ch.selected ? accent + '22' : 'transparent',
              }}>
              <b style={{ color: accent, marginRight: 6 }}>{ch.selected ? '❯' : ''}{ch.num}.</b>{ch.label}
            </Button>
          ))}
        </Space>
      ) : (
        <Space>
          <Button disabled={busy} onClick={() => press(['y'])} style={{ color: '#3fb950', borderColor: '#3fb95066' }}>{t('prompt.yes')}</Button>
          <Button disabled={busy} onClick={() => press(['n'])} style={{ color: '#f85149', borderColor: '#f8514966' }}>{t('prompt.no')}</Button>
        </Space>
      )}
      <Space size={4} style={{ marginTop: 8 }}>
        <Button size="small" disabled={busy} onClick={() => press(['Up'])} title={t('prompt.up')}>↑</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Down'])} title={t('prompt.down')}>↓</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Enter'])}>{t('prompt.enter')}</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Escape'])}>Esc</Button>
      </Space>
    </>
  )
}

function usePromptControl(name: string) {
  const [p, setP] = useState<Prompt | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!name) { setP(null); return }
    let stop = false
    const poll = async () => { const r = await fetchPrompt(name); if (!stop) setP(r) }
    poll()
    const t = setInterval(poll, 1200)
    return () => { stop = true; clearInterval(t) }
  }, [name])

  const press = async (keys: string[]) => {
    setBusy(true)
    try {
      await api('POST', `/sessions/${encodeURIComponent(name)}/keys`, { keys })
      setTimeout(async () => { setP(await fetchPrompt(name)) }, 350)
    } catch (err) {
      console.error('failed to send prompt keys', err)
    } finally {
      setBusy(false)
    }
  }

  const choose = (target: Choice) => {
    press([String(target.num), 'Enter'])
  }

  return { p, busy, press, choose }
}

async function fetchPrompt(name: string): Promise<Prompt | null> {
  try {
    const r = await api('GET', `/sessions/${encodeURIComponent(name)}/capture?lines=50`)
    return detectPrompt(r.data || '')
  } catch { return null }
}

// 选择框面板：检测到 TUI 提示时显示在输入框上方，点击即注入按键完成选择
export function PromptPanel({ name, accent }: { name: string; accent: string }) {
  const { p, busy, press, choose } = usePromptControl(name)
  const { t } = useI18n()

  if (!p) return null

  return (
    <div style={{ borderTop: `1px solid ${accent}55`, background: 'var(--bg-base)', padding: '10px 12px' }}>
      <div style={{ color: accent, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>● {t('prompt.confirmRequired')}</div>
      <PromptActions p={p} accent={accent} busy={busy} choose={choose} press={press} />
    </div>
  )
}

export function PromptDialog({ name, accent, enabled = true }: { name: string; accent: string; enabled?: boolean }) {
  const { p, busy, press, choose } = usePromptControl(enabled ? name : '')
  const { t } = useI18n()
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const promptKey = p ? `${p.kind}:${p.question}:${p.choices.map((c) => `${c.num}:${c.label}`).join('|')}` : ''
  if (!enabled || !p || dismissedKey === promptKey) return null
  return (
    <Modal
      open
      title={<span style={{ color: accent }}>{t('prompt.confirmRequired')}</span>}
      footer={null}
      closable
      onCancel={() => setDismissedKey(promptKey)}
      mask={false}
      width={520}
      centered
      styles={{ header: { textAlign: 'center' }, body: { paddingTop: 12 } }}
    >
      <PromptActions p={p} accent={accent} busy={busy} choose={choose} press={press} />
    </Modal>
  )
}
