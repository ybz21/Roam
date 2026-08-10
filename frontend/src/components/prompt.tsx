// 交互式选择框检测与响应 —— 供 ClaudeChat / CodexChat 专业渲染模式复用。
//
// 背景：Claude/Codex 的权限确认、选项菜单是终端 TUI 实时状态，不在 JSONL transcript 里，
// 所以对话面板渲染不出、也无从响应。这里从实时屏幕(capture，纯文本含 ❯/框线)解析出
// 选择框，渲染成可点按钮；点击经 POST /sessions/:name/keys 注入原始按键完成选择。
import { useEffect, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { api } from '../api'
import { useI18n } from '../i18n'
import { ArrowDown, ArrowUp, ChevronRight, DotIcon } from '../icons'

export interface Choice { num: number; label: string; selected: boolean }
export interface Prompt { kind: 'select' | 'yesno'; question: string; choices: Choice[] }

const CURSOR_PREFIX = /^[❯➤▶►▸→›»☞◉●>]\s*/u           // 选中游标必须位于选项开头，不能匹配正文里的 > / ●
const LEAD = /^[\s│┃|╎┆┊╭╰├╞┝─━═]+/u                  // 行首方框线/竖线/空白
const TAIL = /[\s│┃|╎┆┊╮╯┤╡┥─━═]+$/u                  // 行尾同上
const OPT = /^(?:[❯➤▶►▸→›»☞◉●>]\s*)?(\d+)[.)]\s+(\S.*)$/u // [游标?] N. 文本
// 无可见游标时只接受“明确提问 + 操作提示”的组合。run/command/执行/命令太常见，
// Agent 的普通编号总结很容易命中，造成后台标签在“待确认/运行中”之间反复闪动。
const QUESTION = /(?:would you like|do you want|are you sure|should (?:we|i)|(?:proceed|allow|continue|overwrite|approve|trust).*[?？]|是否(?:继续|允许|确认|执行)|(?:继续|允许|确认|执行).*[?？])/i
const ACTION_HINT = /(?:(?:enter|return).*(?:select|confirm|continue|submit|accept)|(?:esc|escape).*(?:cancel|back)|(?:回车|enter).*(?:选择|确认|继续)|(?:按|press).*(?:y|n|yes|no).*(?:确认|confirm))/i
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
    if (m) opts.push({ num: Number(m[1]), label: m[2].trim(), selected: CURSOR_PREFIX.test(clean(raw)), idx })
  })
  // 取最后一组选项。绑定条件是「编号正好接上」而不是单纯挨得近：手机 attach 后 tmux 窗格常只有
  // 40 多列，Claude 的选项被折成五六行，按行距卡 ≤3 会把每个选项都拆成孤岛 → 一条都识别不出来
  // （表现为手机上根本不弹提问框）。编号连续性本身就足够防误判，行距只留一个宽松上限兜底。
  const g: P[] = []
  for (let i = opts.length - 1; i >= 0; i--) {
    if (!g.length) { g.unshift(opts[i]); continue }
    if (opts[i].num === g[0].num - 1 && g[0].idx - opts[i].idx <= 12) g.unshift(opts[i])
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
    // 有开头游标，或“明确提问 + Enter/Esc 等操作提示”同时成立，才认定为选择框。
    // 不能仅凭普通关键词判断，否则 Agent 输出的命令清单会被误报为待确认。
    const selectedCount = g.filter((o) => o.selected).length
    if (selectedCount === 1 || (QUESTION.test(question) && ACTION_HINT.test(windowText))) {
      const choices = g.map((o) => ({ num: o.num, label: o.label, selected: o.selected }))
      if (!choices.some((c) => c.selected)) choices[0].selected = true
      return { kind: 'select', question, choices }
    }
  }
  // y/n 兜底
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= 12; i--) {
    const c = clean(lines[i])
    if (!c) continue
    if (/\((?:y\/n|yes\/no|y\/N|Y\/n)\)|\[y\/n\]/i.test(c)) return { kind: 'yesno', question: c, choices: [] }
    break // 只检查屏幕最后一条非空行，避免把历史说明文字里的 (y/n) 当作当前提示
  }
  return null
}

// 后台标签的待确认状态需要连续采样后才切换。终端 TUI 在重绘中途可能短暂形成
// “编号列表 + 游标”的残帧；单次采样不能让标签立刻增删“待确认”并造成视觉闪动。
export interface PromptSignal { candidate: boolean; streak: number; stable: boolean }
export function advancePromptSignal(previous: PromptSignal | undefined, candidate: boolean, confirmations = 2): PromptSignal {
  const sameCandidate = previous?.candidate === candidate
  const streak = sameCandidate ? (previous?.streak || 0) + 1 : 1
  const stable = streak >= confirmations ? candidate : (previous?.stable || false)
  return { candidate, streak, stable }
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
              <b style={{ color: accent, marginRight: 6, display: 'inline-flex', alignItems: 'center' }}>{ch.selected ? <ChevronRight size={12} /> : null}{ch.num}.</b>{ch.label}
            </Button>
          ))}
        </Space>
      ) : (
        <Space>
          <Button disabled={busy} onClick={() => press(['y'])} style={{ color: 'var(--ok)', borderColor: 'var(--ok-border)' }}>{t('prompt.yes')}</Button>
          <Button disabled={busy} onClick={() => press(['n'])} style={{ color: '#f85149', borderColor: '#f8514966' }}>{t('prompt.no')}</Button>
        </Space>
      )}
      <Space size={4} style={{ marginTop: 8 }}>
        <Button size="small" disabled={busy} onClick={() => press(['Up'])} title={t('prompt.up')} icon={<ArrowUp size={13} />} />
        <Button size="small" disabled={busy} onClick={() => press(['Down'])} title={t('prompt.down')} icon={<ArrowDown size={13} />} />
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
      <div style={{ color: accent, fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}><DotIcon size={9} />{t('prompt.confirmRequired')}</div>
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
      // 这是「浮在终端上的提示」，不是模态框：
      //   maskClosable=false —— 点别处不再算「取消」。默认 true 时 rc-dialog 见点击落在 wrap 上就
      //     onCancel，于是随手点一下终端这条提问就被 dismissedKey 记死、再也不弹（用户报的「点鼠标就没了」）。
      //   wrapper 透传 —— antd 的 .ant-modal-wrap 不论 mask 真假都是 fixed+inset:0 且可点，会把整页点击
      //     全吃掉（点不到底下的终端）。置 pointerEvents:none 让它透传；弹框本体 .ant-modal-content
      //     自带 pointer-events:auto，照常可点。关闭只走右上角 × 或答完题。
      maskClosable={false}
      width={520}
      centered
      styles={{ wrapper: { pointerEvents: 'none' }, header: { textAlign: 'center' }, body: { paddingTop: 12 } }}
    >
      <PromptActions p={p} accent={accent} busy={busy} choose={choose} press={press} />
    </Modal>
  )
}
