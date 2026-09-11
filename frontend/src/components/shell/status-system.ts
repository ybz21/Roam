// 系统格：宿主自己注册的那几格（20 设计 §05「三个来源，两个等级」）。
//
// 和插件格的差别只有两处：数据源是**进程内已有的 state**（一条新请求都不发），
// 位置落在固定槽位而不是两个尾段。除此之外走的是同一个 CellSpec、同一套渲染器、
// 同一套阈值与折叠规则——要是宿主自己的格走后门，这套注册制两个月就烂了。
//
// M1 只登载 App 手里已经有的东西。分支 / 改动 / 蜂群 / 后台任务要各自的数据源，
// 那些留 M2；缺了就不渲染那一格，**不为了填满一条状态条去加一条轮询**。
import { systemCell } from './status-registry'
import { humanBytes } from './status-cells'
import type { CellValue, Severity } from './status-cells'
import type { SystemCell } from './WorkspaceStatusBar'
import { pathLabelKey } from '../../p2p/labels'
import type { LinkState, LinkStatus } from '../../p2p/transport'

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
  /** Roami 版本；还没取到时为空，那一格就不出现 */
  version: string
  /** 当前会话所属仓库；不在仓库里时为 null，分支那几格整组不出现 */
  git: { branch: string; ahead: number; behind: number; files: number; state: string; conflicts: number } | null
  /** 当前会话所属项目的 key，分支那几格点开去它的项目页 */
  projectKey: string
  /** 活跃蜂群数（已归档的不算） */
  swarms: number
  /** P2P 直连链路；偏好关着（state='disabled'）或没有时整格不出现 */
  link: LinkStatus | null
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

/** 子链路（镜像 / 文件）在悬停里的一句话；空闲就不提它。 */
const SUBLINK_KEY: Record<LinkState, string> = {
  disabled: 'p2p.link.sub.idle',
  connecting: 'p2p.link.sub.connecting',
  connected: 'p2p.link.sub.connected',
  relay: 'p2p.link.sub.relay',
}

/**
 * 速率低于这个数就不往条上写。
 *
 * control 那条保活心跳常年几百字节/秒，写上去就是一个永远在 0.2K 附近抖的读数——
 * 既不说明问题，又让整格宽度每 1.5 秒变一次，挤得右边的读数跟着晃。
 * 有真流量（镜像几百 K、下载几 M）时才值得占这个位置。
 */
const RATE_FLOOR = 16 * 1024

/** 同网直连往返常常不到 1ms，取整成 `0ms` 像是没测出来；那种时候直说「不到 1ms」。 */
function rttText(i: SystemInput, ms: number, full = false): string {
  if (ms > 0) return i.t(full ? 'p2p.link.rttFull' : 'p2p.link.rtt', { ms })
  return i.t(full ? 'p2p.link.rttFullSub1' : 'p2p.link.rttSub1')
}

function subLink(i: SystemInput, labelKey: string, state?: LinkState, path?: string): string {
  if (!state || state === 'disabled') return ''
  const val = state === 'connected'
    ? i.t('p2p.link.sub.directPath', { path: i.t(pathLabelKey(path)) })
    : i.t(SUBLINK_KEY[state])
  return `${i.t(labelKey)} ${val}`
}

export function systemCells(i: SystemInput): SystemCell[] {
  const out: SystemCell[] = []
  const push = (spec: ReturnType<typeof systemCell>, val: CellValue) => out.push({ spec, val })

  // ── 机器：这条的锚，永远在最左、永远不被折叠掉 ──
  // 它同时接管了顶栏那颗「在线/离线」小点：单机看浏览器连没连上，多机看这台机器。
  //
  // 直连也并进这一格：两格说的本来就是同一件事——「你是怎么够到这台机器的」。
  // 分成两格时，左边写「当前设备 在线」、右边写「直连 · 局域网 12ms」，中间还夹着分隔线，
  // 像两件事；而且直连那格是档 3，窄屏一挤就没了，恰恰是想看的时候看不到。
  // 并进档 1 之后它永不消失，读起来也是一句话：这台机器、怎么连的、多快。
  const link = i.link && i.link.state !== 'disabled' ? i.link : null
  const direct = link?.state === 'connected'
  // 条上只写大头那个方向：下载时是下行、上传镜像时是上行，两个数一起写太长
  const peak = Math.max(link?.downBps || 0, link?.upBps || 0)
  const machineSeverity: Severity = i.node
    ? (!i.node.online ? 'danger' : i.node.latencyMs > SLOW_MS ? 'warn' : 'ok')
    : (i.online ? 'ok' : 'danger')
  const machineText = i.node
    ? (i.node.online ? i.t('node.latencyMs', { ms: i.node.latencyMs }) : i.t('node.offline'))
    : (i.online ? i.t('workspace.online') : i.t('workspace.offline'))
  // 怎么连的：直连报路径，中转/连接中各报各的，偏好关着就不提这回事。
  const linkPhrase = !link ? ''
    : direct ? i.t('p2p.link.direct', { path: i.t(pathLabelKey(link.path)) })
      : link.state === 'relay' ? i.t('p2p.link.relay') : i.t('p2p.link.connecting')
  push(
    systemCell('roam.core', 'machine', {
      // 机器名与「怎么连的」都进 label（这两截很少变），变的那两个数留在 value 里——
      // value 有固定预留宽度，延迟涨一位数、速率来了又走都不会推着右边的格子跑。
      label: [i.node?.name || i.t('nav.thisDevice'), linkPhrase].filter(Boolean).join(' '),
      priority: 100, tier: 1, render: 'dot',
      // 直连时报的是 P2P 往返（那才是这条路的延迟），预留 13ch 给「延迟 + 速率」；
      // 其余情况报机器延迟，5ch 就够。
      unit: direct ? 'latencyRate' : 'ms',
      // 多机点它去中心页（机器都在那儿）；单机而直连在跑时，唯一能对它做点什么的地方是设置。
      onClick: i.clustered ? { kind: 'route', id: '#/hub' }
        : link ? { kind: 'route', id: '#/settings/node/p2p' } : undefined,
    }),
    {
      // 直连成立时，延迟说的是那条快路的往返；否则还是机器那句（在线 / 6ms / 离线）。
      text: direct
        ? [link.rttMs != null ? rttText(i, link.rttMs) : '', peak >= RATE_FLOOR ? i.t('p2p.link.rate', { rate: humanBytes(peak) }) : ''].filter(Boolean).join(' ')
        : machineText,
      // 悬停里把两件事都摊开：机器那边的延迟、两个方向的速率、镜像与文件各走哪条路。
      detail: [
        direct && i.node?.online ? i.t('node.latencyMs', { ms: i.node.latencyMs }) : '',
        link ? i.t('p2p.link.title') : '',
        direct && link.rttMs != null ? rttText(i, link.rttMs, true) : '',
        direct
          ? (peak >= RATE_FLOOR
            ? `${i.t('p2p.link.down', { rate: humanBytes(link.downBps || 0) })} · ${i.t('p2p.link.up', { rate: humanBytes(link.upBps || 0) })}`
            : i.t('p2p.link.idleRate'))
          : '',
        link ? subLink(i, 'p2p.link.media', link.media, link.mediaPath) : '',
        link ? subLink(i, 'p2p.link.file', link.file, link.filePath) : '',
      ].filter(Boolean).join(' · ') || undefined,
      severity: machineSeverity,
      // 直连没成立时整格不变暗：这一格首先是「机器在不在」，那件事一直成立。
      // 变暗留给「有这一格、但此刻没有那条快路」——而机器格永远有话说。
    },
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
