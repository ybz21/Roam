// 交互式选择框检测与响应 —— 供 ClaudeChat / CodexChat 专业渲染模式复用。
//
// 背景：Claude/Codex 的权限确认、选项菜单是终端 TUI 实时状态，不在 JSONL transcript 里，
// 所以对话面板渲染不出、也无从响应。这里从实时屏幕(capture，纯文本含 ❯/框线)解析出
// 选择框，渲染成可点按钮；点击经 POST /sessions/:name/keys 注入原始按键完成选择。
import { useEffect, useState } from 'react'
import { Button, Space } from 'antd'
import { api } from './api'

export interface Choice { num: number; label: string; selected: boolean }
export interface Prompt { kind: 'select' | 'yesno'; question: string; choices: Choice[] }

const CURSOR = /[❯➤▶►▸→›»☞◉●>]/u                      // 选中游标常见字形（含 ASCII >）
const LEAD = /^[\s│┃|╎┆┊╭╰├╞┝─━═]+/u                  // 行首方框线/竖线/空白
const TAIL = /[\s│┃|╎┆┊╮╯┤╡┥─━═]+$/u                  // 行尾同上
const OPT = /^(?:[❯➤▶►▸→›»☞◉●>]\s*)?(\d+)[.)]\s+(\S.*)$/u // [游标?] N. 文本
const KW = /(proceed|allow|continue|overwrite|apply|approve|trust|run|是否|确认|继续|允许|要不要|执行)/i
const clean = (s: string) => s.replace(LEAD, '').replace(TAIL, '')

// 从一屏纯文本里解析当前是否有交互式选择框；没有则返回 null
export function detectPrompt(capture: string): Prompt | null {
  const lines = (capture || '').replace(/\r/g, '').split('\n')
  type P = { num: number; label: string; selected: boolean; idx: number }
  const opts: P[] = []
  lines.forEach((raw, idx) => {
    const m = clean(raw).match(OPT)
    if (m) opts.push({ num: Number(m[1]), label: m[2].trim(), selected: CURSOR.test(raw), idx })
  })
  // 取最后一组相邻选项（允许 ≤2 行间隔，跳过空行/装饰行）
  const g: P[] = []
  for (let i = opts.length - 1; i >= 0; i--) {
    if (!g.length) g.unshift(opts[i])
    else if (g[0].idx - opts[i].idx <= 2) g.unshift(opts[i])
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
    // 有游标，或问题像个确认提示 → 认定为选择框（capture 无颜色，故用游标/关键词双保险）
    if (g.some((o) => o.selected) || KW.test(question)) {
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

async function fetchPrompt(name: string): Promise<Prompt | null> {
  try {
    const r = await api('GET', `/sessions/${encodeURIComponent(name)}/capture?lines=50`)
    return detectPrompt(r.data || '')
  } catch { return null }
}

// 选择框面板：检测到 TUI 提示时显示在输入框上方，点击即注入按键完成选择
export function PromptPanel({ name, accent }: { name: string; accent: string }) {
  const [p, setP] = useState<Prompt | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stop = false
    const poll = async () => { const r = await fetchPrompt(name); if (!stop) setP(r) }
    poll()
    const t = setInterval(poll, 1200)
    return () => { stop = true; clearInterval(t) }
  }, [name])

  if (!p) return null

  const press = async (keys: string[]) => {
    setBusy(true)
    try { await api('POST', `/sessions/${encodeURIComponent(name)}/keys`, { keys }) } catch {}
    finally { setBusy(false) }
    // 选完尽快重抓，面板及时消失/更新（不等下一个轮询周期）
    setTimeout(async () => { setP(await fetchPrompt(name)) }, 350)
  }

  // 点选某项：从当前游标用方向键移动到目标项再回车确认。
  // 比直接发数字键更可靠——纯方向键菜单（无数字热键）也能点选。
  const choose = (target: Choice) => {
    const cur = Math.max(0, p!.choices.findIndex((c) => c.selected))
    const tgt = p!.choices.findIndex((c) => c.num === target.num)
    if (tgt < 0) return
    const delta = tgt - cur
    const keys = Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up')
    keys.push('Enter')
    press(keys)
  }

  return (
    <div style={{ borderTop: `1px solid ${accent}55`, background: 'var(--bg-base)', padding: '10px 12px' }}>
      <div style={{ color: accent, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>● 需要你确认</div>
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
          <Button disabled={busy} onClick={() => press(['y'])} style={{ color: '#3fb950', borderColor: '#3fb95066' }}>是 (y)</Button>
          <Button disabled={busy} onClick={() => press(['n'])} style={{ color: '#f85149', borderColor: '#f8514966' }}>否 (n)</Button>
        </Space>
      )}
      {/* 通用导航：应对无编号或需上下微调的提示 */}
      <Space size={4} style={{ marginTop: 8 }}>
        <Button size="small" disabled={busy} onClick={() => press(['Up'])} title="上移">↑</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Down'])} title="下移">↓</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Enter'])}>⏎ 回车</Button>
        <Button size="small" disabled={busy} onClick={() => press(['Escape'])}>Esc</Button>
      </Space>
    </div>
  )
}
