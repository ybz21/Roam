// 会话状态条：输入框正上方一行 28px —— 当前模式 · 推理档 · 上下文占用 · 任务进度 · 未读回底。
//
// 数据全都已经躺在转录里（见 15 设计 §11），搭 /transcript 现有轮询的车，不额外开端点。
// 手机上这 28px 是从终端行数里借的，所以窄屏只留「模式 · 环 · 未读」，模型名与推理档收起来。
import { useState } from 'react'
import { useI18n } from '../i18n'
import { useLayout } from '../layout'
import { ArrowToBottom, BrainIcon, ChecklistIcon } from '../icons'
import { fmtTokens, modeKey, type AgentStatus, type ModeTone } from './status'

const TONE: Record<ModeTone, string> = {
  accent: 'var(--accent)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  neutral: 'var(--text-dim)',
}

// 占用环。用 stroke-dasharray 画：18px 的图形上，一根描边比任何数字都快读。
function Ring({ percent, color, size = 16 }: { percent: number; color: string; size?: number }) {
  const r = 15
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" style={{ transform: 'rotate(-90deg)', flex: '0 0 auto' }} aria-hidden>
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--border)" strokeWidth="3.4" />
      <circle cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="3.4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, percent / 100)))} />
    </svg>
  )
}

export function StatusBar({ status, accent, unread, onJump }: {
  status: AgentStatus
  accent: string
  unread: number
  onJump?: () => void
}) {
  const { t } = useI18n()
  const { phone } = useLayout()
  const [detail, setDetail] = useState(false)

  const ctx = status.context
  // 上下文接近满了要变色：85% 起黄，95% 起红。这是唯一会「越用越糟」的指标。
  const ctxColor = !ctx ? accent : ctx.percent >= 95 ? 'var(--danger)' : ctx.percent >= 85 ? 'var(--warn)' : accent
  const hasAny = status.mode || ctx || status.tasks || status.quota || unread > 0
  if (!hasAny) return null

  const modeLabel = status.mode ? t(modeKey(status.mode.id)) : ''
  // 认不出的模式 id 直接显示原文：新模式先出现在 CLI 里是常态，不该显示成 key
  const modeText = modeLabel.startsWith('chat.mode.') ? status.mode!.id : modeLabel

  return (
    <div className="cc-statusbar">
      {status.mode && (
        <button type="button" className="cc-st-pill" style={{ color: TONE[status.mode.tone] }}
          onClick={() => setDetail((v) => !v)} title={t('chat.statusDetail')}>
          <i style={{ background: TONE[status.mode.tone] }} />{modeText}
        </button>
      )}

      {!phone && status.effort && (
        <span className="cc-st-item" title={t('chat.effort')}><BrainIcon size={13} />{status.effort}</span>
      )}

      {ctx && (
        <span className="cc-st-item" title={`${fmtTokens(ctx.used)} / ${fmtTokens(ctx.window)}`}>
          <Ring percent={ctx.percent} color={ctxColor} />
          <span style={{ color: ctxColor, fontVariantNumeric: 'tabular-nums' }}>{ctx.percent.toFixed(ctx.percent < 10 ? 1 : 0)}%</span>
        </span>
      )}

      {status.quota != null && (
        <span className="cc-st-item" title={t('chat.quotaTitle')}>
          <Ring percent={status.quota} color="var(--warn)" />
          <span style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(status.quota)}%</span>
        </span>
      )}

      {status.tasks && (
        <span className="cc-st-item" title={status.tasks.doing || t('chat.taskPanel')}>
          <ChecklistIcon size={13} />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{status.tasks.done}/{status.tasks.total}</span>
        </span>
      )}

      <span style={{ flex: 1 }} />

      {/* 「回到底部」并进这条：它本来是右下角的悬浮圆钮，跟这里重复，合并后少一个浮层，
          顺带把未读数带上——上滚离底之后，新消息有多少是这条唯一能回答的问题。 */}
      {unread > 0 && (
        <button type="button" className="cc-st-jump" style={{ background: accent }} onClick={onJump} title={t('chat.jumpToBottom')}>
          <ArrowToBottom size={13} />
          <b>{unread > 99 ? '99+' : unread}</b>
        </button>
      )}

      {detail && (
        <div className="cc-st-detail">
          {status.model && <div><span>{t('chat.model')}</span><b>{status.model}</b></div>}
          {status.effort && <div><span>{t('chat.effort')}</span><b>{status.effort}</b></div>}
          {ctx && <div><span>{t('chat.context')}</span><b>{fmtTokens(ctx.used)} / {fmtTokens(ctx.window)}</b></div>}
          {status.tasks?.doing && <div><span>{t('chat.taskPanel')}</span><b>{status.tasks.doing}</b></div>}
        </div>
      )}
    </div>
  )
}
