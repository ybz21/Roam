// 输入行最左那枚「+」：低频、但每次都要找的那几件事。
//
// 为什么不是一排 pill：手机上输入行只有 392px，摆得下的只有「说话」和「发送」。
// 为什么不是一张普通菜单：这里每一条都关系到**这一轮怎么跑**，而「现在是哪一档」
// 恰恰是菜单答不出来的——于是右端带上当前值（权限模式 / 模型 / 上下文占用），
// 面板一打开就先回答「现在什么样」，再谈改不改。
//
// 内容与取值在 composer-plus.ts（纯函数、可测），这里只管画和点。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Dropdown } from 'antd'
import { api } from '../../api'
import { useI18n } from '../../i18n'
import { ArchiveIcon, BotIcon, ForkIcon, PaperclipIcon, PlusIcon, ShieldIcon } from '../../icons'
import { modeFromPane, plusGroups, type PlusGroupId, type PlusRowId } from './composer-plus'
import { toMode, type AgentStatus } from './status'

const ICON: Record<PlusRowId, ReactNode> = {
  files: <PaperclipIcon size={14} />,
  mode: <ShieldIcon size={14} />,
  model: <BotIcon size={14} />,
  compact: <ArchiveIcon size={14} />,
  git: <ForkIcon size={14} />,
}

const GROUP_LABEL: Record<PlusGroupId, string> = {
  bring: 'chat.plus.bring',
  turn: 'chat.plus.turn',
  goto: '', // 单独一行的跳转，只靠分隔线断开，不值得再加一行标题
}

// 按完 Shift+Tab 之后回读画面的节奏：TUI 重画很快，但按键要先过一趟 tmux。
// 拿到不一样的档就停，全都一样就认命（可能这个会话根本没在轮换模式）。
const CONFIRM_AT = [250, 600, 1200, 2200]

export function ComposerPlus({ name, agent, status, uploading, onFiles, onCycleMode, onPickModel, onCompact, onOpenGit, onMouseDown }: {
  /** 会话名：面板要自己回读一次终端画面，看当前是哪一档 */
  name: string
  agent?: 'claude' | 'codex'
  status?: AgentStatus
  uploading?: boolean
  onFiles: () => void
  /** 注入 Shift+Tab（tmux 的 BTab）：跟人在 TUI 里按是同一个动作，两端都认 */
  onCycleMode: () => void
  onPickModel: () => void
  onCompact: () => void
  onOpenGit?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // 当前权限档以**画面**为准：转录里那份要等下一条消息才更新，而这里问的就是「此刻」
  const [paneMode, setPaneMode] = useState<string | undefined>()
  const [switching, setSwitching] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = [] }

  const readPane = useCallback(async (): Promise<string | undefined> => {
    try {
      const r = await api('GET', `/sessions/${encodeURIComponent(name)}/capture?lines=12`)
      // 认不出就还原成 undefined、退回转录那份：Codex 的默认档**本来就没有那枚片**，
      // 「读不到」在这里是有意义的答案，留着上一次的值反而会一直显示已经离开的模式
      const m = modeFromPane(r?.data || '')
      setPaneMode(m)
      return m
    } catch { return undefined }
  }, [name])

  // 打开就读一次；关掉停掉所有在飞的回读
  useEffect(() => {
    if (!open || !agent) return
    void readPane()
    return clearTimers
  }, [open, agent, readPane])
  useEffect(() => clearTimers, [])

  const cycle = () => {
    const before = paneMode
    setSwitching(true)
    onCycleMode()
    clearTimers()
    timers.current = CONFIRM_AT.map((ms) => setTimeout(async () => {
      const now = await readPane()
      if (now && now !== before) { clearTimers(); setSwitching(false) }
      else if (ms === CONFIRM_AT[CONFIRM_AT.length - 1]) setSwitching(false)
    }, ms))
  }

  const mode = paneMode ? toMode(paneMode) : status?.mode
  const groups = plusGroups({ agent, status, mode, uploading, canGit: !!onOpenGit, modePending: switching, t })

  const LABEL: Record<PlusRowId, string> = {
    files: t('chat.uploadToCwd'),
    mode: t('chat.plus.mode'),
    model: t('chat.model'),
    compact: t('chat.compact'),
    git: t('git.title'),
  }
  const TITLE: Record<PlusRowId, string> = {
    files: t('chat.uploadToCwd'),
    mode: t('chat.plus.modeHint'),
    model: t('chat.modelPick'),
    compact: t('chat.plus.compactHint'),
    git: t('git.title'),
  }
  // 改模式后面板不关：值就在眼前，切到了哪一档看得见（其余几条都会跳到别的界面，点完即关）
  const RUN: Record<PlusRowId, () => void> = {
    files: () => { setOpen(false); onFiles() },
    mode: cycle,
    model: () => { setOpen(false); onPickModel() },
    compact: () => { setOpen(false); onCompact() },
    git: () => { setOpen(false); onOpenGit?.() },
  }

  return (
    <Dropdown trigger={['click']} placement="topLeft" open={open} onOpenChange={setOpen}
      popupRender={() => (
        <div className="cc-plus" role="menu">
          {groups.map((g) => (
            <div className="cc-plus-grp" key={g.id}>
              {GROUP_LABEL[g.id] && <div className="cc-plus-head">{t(GROUP_LABEL[g.id])}</div>}
              {g.rows.map((r) => (
                <button key={r.id} type="button" role="menuitem"
                  className={`cc-plus-row${r.pending ? ' is-pending' : ''}`}
                  disabled={r.disabled} title={TITLE[r.id]} onClick={RUN[r.id]}>
                  <span className="ic" aria-hidden>{ICON[r.id]}</span>
                  <span className="nm">{LABEL[r.id]}</span>
                  {r.value && (
                    <span className="val" style={r.tone ? { color: r.tone } : undefined}>
                      {r.dot && <i style={{ background: r.dot }} />}{r.value}
                    </span>
                  )}
                  {r.kbd && <kbd>{r.kbd}</kbd>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}>
      <button type="button" className="tt-pill ico" aria-label={t('chat.more')} title={t('chat.more')}
        onMouseDown={onMouseDown}><PlusIcon size={14} /></button>
    </Dropdown>
  )
}
