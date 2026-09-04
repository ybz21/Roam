// 系统格：宿主自己注册的那几格（20 设计 §05「三个来源，两个等级」）。
//
// 和插件格的差别只有两处：数据源是**进程内已有的 state**（一条新请求都不发），
// 位置落在固定槽位而不是两个尾段。除此之外走的是同一个 CellSpec、同一套渲染器、
// 同一套阈值与折叠规则——要是宿主自己的格走后门，这套注册制两个月就烂了。
//
// M1 只登载 App 手里已经有的东西。分支 / 改动 / 蜂群 / 后台任务要各自的数据源，
// 那些留 M2；缺了就不渲染那一格，**不为了填满一条状态条去加一条轮询**。
import { systemCell } from './status-registry'
import type { CellValue, Severity } from './status-cells'
import type { SystemCell } from './WorkspaceStatusBar'

export type SystemInput = {
  /** 浏览器与后端连着没有（单机时机器格的状态点看它） */
  online: boolean
  /** 当前机器；单机（没接入中心）时为 null */
  node: { name: string; online: boolean; latencyMs: number } | null
  /** 中心不健康时的一句话原因；健康或没接中心时为空 */
  hubAlarm?: string
  clustered: boolean
  sessions: number
  /** 卡在权限确认的会话数 */
  waiting: number
  /** 已合入待清理的 worktree 数 */
  unfinished: number
  /** 有 Agent 在跑的会话数 */
  agents: number
  /** Roam 版本；还没取到时为空，那一格就不出现 */
  version: string
  /** 当前会话所属仓库；不在仓库里时为 null，分支那几格整组不出现 */
  git: { branch: string; ahead: number; behind: number; files: number; state: string; conflicts: number } | null
  /** 当前会话所属项目的 key，分支那几格点开去它的项目页 */
  projectKey: string
  /** 活跃蜂群数（已归档的不算） */
  swarms: number
  t: (key: string, vars?: Record<string, unknown>) => string
}

/** 延迟超过这个数就算慢：跨网连一台机器，300ms 往上打字已经能感觉到 */
const SLOW_MS = 300

/**
 * 版本号在条上只留标签那一截。
 *
 * `git describe` 给的是 `0.1.0-rc.2-291-gb6624ee-dirty` —— 189px，比机器格还宽，
 * 而后面那截提交计数和哈希在状态条上一眼也读不出意思。剥掉 `-<n>-g<hash>`
 * 和 `-dirty`，完整串留给悬停。
 */
export function shortVersion(v: string): string {
  const bare = v.replace(/^v/, '').replace(/-\d+-g[0-9a-f]+(-dirty)?$/i, '').replace(/-dirty$/i, '')
  return 'v' + bare
}

export function systemCells(i: SystemInput): SystemCell[] {
  const out: SystemCell[] = []
  const push = (spec: ReturnType<typeof systemCell>, val: CellValue) => out.push({ spec, val })

  // ── 机器：这条的锚，永远在最左、永远不被折叠掉 ──
  // 它同时接管了顶栏那颗「在线/离线」小点：单机看浏览器连没连上，多机看这台机器。
  const machineSeverity: Severity = i.node
    ? (!i.node.online ? 'danger' : i.node.latencyMs > SLOW_MS ? 'warn' : 'ok')
    : (i.online ? 'ok' : 'danger')
  const machineText = i.node
    ? (i.node.online ? i.t('node.latencyMs', { ms: i.node.latencyMs }) : i.t('node.offline'))
    : (i.online ? i.t('workspace.online') : i.t('workspace.offline'))
  push(
    systemCell('roam.core', 'machine', {
      label: i.node?.name || i.t('nav.thisDevice'),
      priority: 100, tier: 1, render: 'dot',
      // 多机时点它去中心页（机器都在那儿）；单机没有可去的地方，就不是按钮
      onClick: i.clustered ? { kind: 'route', id: '#/hub' } : undefined,
    }),
    { text: machineText, severity: machineSeverity },
  )

  // ── 中心：只在接入中心时出现 ──
  // 2026-08-11 中心卡死十几个小时无人发现——中心页当时就存在，但得先「发现打不开」
  // 才会想起去看它。这一格是唯一能保证被看见的位置。
  if (i.clustered) {
    push(
      systemCell('roam.core', 'hub', {
        label: i.t('status.hub'), priority: 90, tier: 3, render: 'dot',
        onClick: { kind: 'route', id: '#/hub' },
      }),
      {
        text: i.hubAlarm || i.t('status.hubOk'),
        detail: i.hubAlarm,
        severity: i.hubAlarm ? 'danger' : 'ok',
      },
    )
  }

  // ── 待办：对应 VS Code 的「问题」格。三样都是 0 就不出现 ──
  const todo = i.waiting + i.unfinished
  if (todo > 0) {
    const parts: string[] = []
    if (i.waiting) parts.push(i.t('status.waitingN', { n: i.waiting }))
    if (i.unfinished) parts.push(i.t('status.unfinishedN', { n: i.unfinished }))
    push(
      systemCell('roam.tasks', 'todo', {
        label: '', priority: 80, tier: 1, render: 'text', icon: 'ChecklistIcon',
        onClick: { kind: 'route', id: '#/projects' },
      }),
      // 有会话卡在确认就是警戒色：那是「它在等你，而你不知道」
      { text: parts.join(' · '), severity: i.waiting ? 'warn' : 'ok' },
    )
  }

  // ── 会话数：0 个会话时整格不出现 ──
  if (i.sessions > 0) {
    push(
      systemCell('roam.core', 'sessions', {
        label: '', priority: 70, tier: 2, render: 'text', icon: 'TerminalIcon', unit: 'count',
        onClick: { kind: 'route', id: '#/projects' }, // 会话页退役，会话数点开去项目页（23 设计 §5）
      }),
      { text: String(i.sessions), detail: i.t('nav.sessions') },
    )
  }

  // ── 正在跑的 Agent：会话数说不出「有几个在真干活」，而那是你真正想知道的 ──
  if (i.agents > 0) {
    push(
      systemCell('roam.core', 'agents', {
        label: '', priority: 65, tier: 2, render: 'text', icon: 'BotIcon', unit: 'count',
        onClick: { kind: 'route', id: '#/sessions' },
      }),
      { text: String(i.agents), detail: i.t('status.agentsRunning') },
    )
  }

  // ── 分支：VS Code 状态栏上最有用的那一格 ──
  // 不在仓库里（或者压根没有活动会话）就整组不出现，而不是画一个「-」占位。
  if (i.git?.branch) {
    const g = i.git
    const gitRoute = i.projectKey ? '#/projects/' + encodeURIComponent(i.projectKey) : '#/projects'
    // rebase / merge 进行中是**必须看见**的：那时候一个 git commit 的后果和平时不一样
    // 未知的 state（git 将来加了新模式）退回原文，别把键名画到条上
    const stateKey = 'status.gitState.' + g.state
    const stateText = g.state ? i.t(stateKey) : ''
    const state = stateText === stateKey ? g.state : stateText
    // 分支名可以很长（fix/tabstrip-tree-and-mirror-frame 就是 34 个字符）。整条状态条是
    // 一行、装不下就按档位丢格，而丢弃顺序是「右半先于左半」——于是一个长分支能把右边的
    // 版本号整格挤没。截到 24 个字符，完整名字进 detail（title/aria 里还看得到全名）。
    const full = state ? `${g.branch} · ${state}` : g.branch
    const text = full.length > 24 ? full.slice(0, 23) + '…' : full
    push(
      systemCell('roam.git', 'branch', {
        label: '', priority: 85, tier: 3, render: 'text', icon: 'ForkIcon',
        // Git 面板挂在 Inspector 槽位里、不是一条路由，所以去这个仓库的项目页——
        // worktree、待收尾、开 Git 面板的入口都在那儿
        onClick: { kind: 'route', id: gitRoute },
      }),
      {
        text,
        detail: [text === full ? '' : full, g.conflicts ? i.t('status.conflictsN', { n: g.conflicts }) : '']
          .filter(Boolean).join(' · ') || undefined,
        severity: g.conflicts ? 'danger' : g.state ? 'warn' : 'ok',
      },
    )

    // ── 同步：落后/领先。箭头是图标不是文字符号，数字用文案说清哪头是哪头 ──
    if (g.ahead || g.behind) {
      const parts: string[] = []
      if (g.behind) parts.push(i.t('status.behindN', { n: g.behind }))
      if (g.ahead) parts.push(i.t('status.aheadN', { n: g.ahead }))
      push(
        systemCell('roam.git', 'sync', {
          label: '', priority: 84, tier: 4, render: 'text',
          icon: g.behind ? 'ArrowDown' : 'ArrowUp',
          onClick: { kind: 'route', id: gitRoute },
        }),
        // 落后才上色：领先只是「还没推」，那是你自己知道的事
        { text: parts.join(' · '), severity: g.behind ? 'warn' : 'ok' },
      )
    }

    // ── 改动：几个文件动过。0 就不出现 ──
    if (g.files) {
      push(
        systemCell('roam.git', 'changed', {
          label: '', priority: 83, tier: 4, render: 'text', icon: 'DiffIcon', unit: 'count',
          onClick: { kind: 'route', id: gitRoute },
        }),
        { text: String(g.files), detail: i.t('status.changedFiles') },
      )
    }
  }

  // ── 蜂群：有活跃的才出现 ──
  if (i.swarms > 0) {
    push(
      systemCell('roam.tasks', 'swarm', {
        label: '', priority: 60, tier: 4, render: 'text', icon: 'SwarmIcon', unit: 'count',
        onClick: { kind: 'route', id: '#/swarm' },
      }),
      { text: String(i.swarms), detail: i.t('status.swarmsActive') },
    )
  }

  // ── 版本：最右、最暗、最先被折叠掉。它只在你要报 bug 那天有用 ──
  if (i.version) {
    push(
      systemCell('roam.core', 'version', {
        label: '', align: 'right', priority: 0, tier: 4, render: 'text',
        onClick: { kind: 'route', id: '#/about' },
      }),
      // 完整串留在 detail（悬停与读屏拿得到），条上只留标签
      { text: shortVersion(i.version), detail: i.version },
    )
  }

  return out
}
