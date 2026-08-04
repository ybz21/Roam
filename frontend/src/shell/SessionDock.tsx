// 会话坞（13 设计 §4.2）——手机上最缺的那块。
//
// 今天手机上的会话只有两态：全屏覆盖，或完全看不见。退回项目页那一刻，你就不知道
// 还有几个会话在跑、哪个在等你确认——而这恰恰是 Roam 存在的理由。
//
// 于是在底栏之上加一条 50px 的常驻坞（无会话时整条消失）：左边是当前会话，中间是
// 「几个在等你」，右边是总数。点或上滑展开会话，点徽标出切换 sheet。
//
// badge 规则与 14 §4.4 一致——只标「要行动的」。坞右侧的总数是唯一例外：坞的职责
// 就是回答「还有几个在跑」，那不是装饰性计数。
import { useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { sessionLabel } from '../session-label'
import { useSessionProject } from '../session-project'
import { MobileSheet, SheetRow } from './MobileSheet'

/** `项目 · 会话`：空间不足时先截项目名，会话名不省略——会话名才是你要找的那个 */
export function DockTitle({ name }: { name: string }) {
  const proj = useSessionProject(name)
  return (
    <span className="ttl">
      {proj && <span className="pj">{proj.name} ·</span>}
      <span className="nm">{sessionLabel(name) || name}</span>
    </span>
  )
}

export function SessionDock({ sessions, active, needsInput, running, onOpen, onPick, onClose }: {
  sessions: string[]
  active: string | null
  needsInput: Record<string, boolean>
  /** 会话是否有 Agent 在跑，只用于状态点颜色 */
  running: (name: string) => boolean
  onOpen: () => void
  onPick: (name: string) => void
  onClose: (name: string) => void
}) {
  const { t } = useI18n()
  const [sheet, setSheet] = useState(false)
  const touch = useRef<{ y: number; t: number } | null>(null)
  const waiting = sessions.filter((n) => needsInput[n]).length
  if (!sessions.length) return null

  const cur = active && sessions.includes(active) ? active : sessions[0]
  const dotColor = (n: string) => (needsInput[n] ? '#d29922' : running(n) ? '#3fb950' : 'var(--text-dimmer)')

  return (
    <>
      <div className="tt-sessdock" role="button" tabIndex={0}
        aria-label={t('mobile.sessionDock')}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
        // 上滑展开：拇指从坞往上一推就是"把会话拉出来"，比瞄准点按快
        onTouchStart={(e) => { touch.current = { y: e.touches[0].clientY, t: Date.now() } }}
        onTouchEnd={(e) => {
          const s = touch.current
          touch.current = null
          if (!s) return
          const dy = e.changedTouches[0].clientY - s.y
          if (dy < -30 && Date.now() - s.t < 600) { e.preventDefault(); onOpen() }
        }}>
        <i className="d" style={{ background: dotColor(cur) }} />
        <DockTitle name={cur} />
        {waiting > 0 && <span className="wait">{t('mobile.waitingN', { count: waiting })}</span>}
        <svg className="up" viewBox="0 0 24 24" width={14} height={14} aria-hidden="true"
          fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 14 12 8 18 14" />
        </svg>
        <button type="button" className="cnt" aria-label={t('mobile.switchSession')}
          onClick={(e) => { e.stopPropagation(); setSheet(true) }}>{sessions.length}</button>
      </div>

      <SessionSwitchSheet open={sheet} onClose={() => setSheet(false)}
        sessions={sessions} active={cur} needsInput={needsInput} running={running}
        onPick={onPick} onCloseSession={onClose} />
    </>
  )
}

/**
 * 会话切换 sheet（13 §4.2 / §5.1）。会话坞和手机会话页顶栏共用同一个：
 * 两处问的是同一个问题「切到哪个会话」，长两套就会慢慢长歪。
 *
 * 一屏 8 行 × 56，比横滑标签条能看到的 2–3 个多一个数量级——这正是标签条在手机上
 * 被换掉的原因（App.tsx 里那句 scrollIntoView 就是标签条滑出视口的补丁）。
 */
export function SessionSwitchSheet({ open, sessions, active, needsInput, running, onPick, onCloseSession, onClose }: {
  open: boolean
  sessions: string[]
  active: string | null
  needsInput: Record<string, boolean>
  running: (name: string) => boolean
  onPick: (name: string) => void
  onCloseSession: (name: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const dotColor = (n: string) => (needsInput[n] ? '#d29922' : running(n) ? '#3fb950' : 'var(--text-dimmer)')
  return (
    <MobileSheet open={open} title={t('mobile.switchSession')} onClose={onClose}>
      {sessions.map((n) => (
        <SheetRow key={n}
          icon={<i style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor(n), display: 'block' }} />}
          title={<DockTitle name={n} />}
          desc={needsInput[n] ? t('session.waiting') : undefined}
          active={n === active}
          minHeight={56}
          onClick={() => { onClose(); onPick(n) }}
          extra={(
            <button type="button" className="tt-sessdock-x" aria-label={t('common.close')}
              onClick={(e) => { e.stopPropagation(); onCloseSession(n) }}>✕</button>
          )}
        />
      ))}
      {/* 这张 sheet 只列「开着的终端」；搜索、筛选、Worktree 管理、新建竞赛都在会话页。
          你正想着会话的时候就在这儿，入口放这里比绕回概览近得多。 */}
      <SheetRow
        icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></svg>}
        title={t('project.allSessions')}
        onClick={() => { onClose(); location.hash = '#/sessions' }}
      />
    </MobileSheet>
  )
}
