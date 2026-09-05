// 输入行「+」面板的内容：哪几行、每行右端那截**当前值**是什么。
//
// 这一层单独抽出来，是因为面板的价值全在「值」上：一条写着「切换权限模式」的菜单项
// 是盲的——点下去会变成什么、现在又是哪一档，都得回终端看。带上当前模式、当前模型、
// 当前上下文占用之后，它才是「更多设置」，而不是三个说不清后果的按钮。
//
// 渲染（图标、文案、点击）留在 ComposerPlus.tsx：这里只回答「显示什么」。
import { CTX_FULL, CTX_TIGHT, MODE_COLOR, modeKey, type AgentStatus } from './status'

/**
 * 从 TUI 页脚那枚模式片里读**当前**权限档。
 *
 * 转录里的 permissionMode 挂在消息行上，一条不发就不更新——按下 Shift+Tab 之后
 * 它要等到下一轮才变。而「我刚按完，现在到底是哪一档」正是那一秒最想知道的事，
 * 所以这里改从终端画面读（/sessions/:name/capture 本来就在轮询实时回显）。
 *
 * 只认页脚：必须与 `shift+tab` 那句提示同一行。否则 Claude 自己写的一句
 * 「切到 plan mode 再看」也会被当成当前档。认不出就返回 undefined，退回转录那份。
 */
export function modeFromPane(text: string): string | undefined {
  const lines = String(text).replace(/\r/g, '').split('\n').slice(-8)
  for (const line of lines) {
    if (!/shift\+tab/i.test(line)) continue
    const s = line.toLowerCase()
    if (/bypass(ing)? permissions/.test(s)) return 'bypassPermissions'
    if (/plan mode/.test(s)) return 'plan'
    if (/accept edits/.test(s)) return 'acceptEdits'
    if (/auto mode/.test(s)) return 'auto'
  }
  return undefined
}

export type PlusRowId = 'files' | 'mode' | 'model' | 'compact' | 'git'
export type PlusGroupId = 'bring' | 'turn' | 'goto'

export type PlusRow = {
  id: PlusRowId
  /** 右端那截当前值；没有就不画（宁可空着，也不画一个「—」占位） */
  value?: string
  /** 值前面那颗点的颜色：模式的含义靠颜色说（计划蓝 / 自动接受绿 / 越权黄） */
  dot?: string
  /** 值本身的颜色；只有上下文快满时才上色 */
  tone?: string
  /** 按键提示（同一件事在终端里怎么按） */
  kbd?: string
  disabled?: boolean
  /** 点过了、新状态还没回来：值淡一档，别让人以为没生效又点一次 */
  pending?: boolean
}

export type PlusGroup = { id: PlusGroupId; rows: PlusRow[] }

/** 上下文占用 → 值的颜色。阈值与状态条同源（CTX_TIGHT / CTX_FULL） */
function ctxColor(percent: number): string | undefined {
  if (percent >= CTX_FULL) return 'var(--danger)'
  if (percent >= CTX_TIGHT) return 'var(--warn)'
  return undefined
}

export function plusGroups(o: {
  /** 没有 agent（纯终端会话）时整组「这一轮怎么干」不出现：那几条都是发给 agent 的 */
  agent?: 'claude' | 'codex'
  status?: AgentStatus
  /** 从终端画面读到的当前权限档；有就盖过转录那份（转录要下一轮才更新） */
  mode?: AgentStatus['mode']
  uploading?: boolean
  canGit?: boolean
  /** 正在等这次模式切换生效 */
  modePending?: boolean
  t: (key: string, vars?: Record<string, unknown>) => string
}): PlusGroup[] {
  const { status, t } = o
  const groups: PlusGroup[] = [
    { id: 'bring', rows: [{ id: 'files', disabled: !!o.uploading }] },
  ]

  if (o.agent) {
    const rows: PlusRow[] = []

    // 认不出的模式 id 原样显示：新模式先出现在 CLI 里是常态，不该把 key 画到面板上
    const mode = o.mode ?? status?.mode
    const label = mode ? t(modeKey(mode.id)) : ''
    rows.push({
      id: 'mode',
      value: o.modePending ? t('chat.plus.modeWaiting') : mode ? (label.startsWith('chat.mode.') ? mode.id : label) : undefined,
      dot: mode && !o.modePending ? MODE_COLOR[mode.tone] : undefined,
      kbd: 'Shift+Tab',
      pending: !!o.modePending,
    })

    rows.push({ id: 'model', value: status?.model })

    const ctx = status?.context
    rows.push({
      id: 'compact',
      value: ctx ? `${Math.round(ctx.percent)}%` : undefined,
      tone: ctx ? ctxColor(ctx.percent) : undefined,
    })

    groups.push({ id: 'turn', rows })
  }

  if (o.canGit) groups.push({ id: 'goto', rows: [{ id: 'git' }] })
  return groups
}
