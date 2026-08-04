// 概览页（14 设计 §5）——首屏回答的是「下一步做什么」，不是「一共有多少」：
//   ① 问候区：当前有几件事需要你 + 一句运行摘要
//   ② 状态概况：● 运行中 ◐ 等待输入 ⚑ 待收尾 ⬡ 蜂群 —— 数字仍是导航入口，但不再各占一张卡
//   ③「需要你」→ 最多 3 张行动卡（等待输入 / 待收尾 / 蜂群待解锁），超出显示「查看全部 N 项」，
//      零事项时整层消失（旧版是常驻琥珀横幅，没事也占一屏）
//   ④ 活跃项目作战卡：列数走 **Canvas 容器查询**（900 / 1320 → 1/2/3 列），
//      终端开合只改 Canvas，不该由 viewport 决定列数
//   ⑤ 最近活动：Canvas ≥1180 进右侧 320 侧轨（sticky），窄于此自动落回页尾
// 数据全部复用现有接口（/projects、annotations、per-session 探测、/swarms 投影、activity），零新后端。
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { useI18n } from './i18n'
import { detectPrompt } from './prompt'
import { relTime } from './App'
import { sessionLabel } from './session-label'
import { dot } from './Projects'
import { useLayout } from './layout'
import { sessionLocation } from './session-project'

const OV_CSS = `
.ov{display:flex;flex-direction:column;gap:var(--sp-4);padding-bottom:32px;max-width:var(--content-overview)}

.ov-sum{display:flex;align-items:center;gap:var(--sp-2) var(--sp-5);flex-wrap:wrap;min-height:40px;
  padding:var(--sp-2) var(--sp-3);border-radius:var(--r-sm);background:var(--bg-container);font-size:var(--fs-meta)}
/* 窄档：状态条是页头下方的一条横条（它挂在页头的 .acts 槽里，靠 100% 宽换行成整条） */
.ov .tt-pagehead .acts{width:100%;margin-left:0}
.ov .tt-pagehead .acts>.ov-sum{flex:1}
.ov-sum button{display:inline-flex;align-items:center;gap:var(--sp-2);padding:var(--sp-1);margin:calc(var(--sp-1) * -1);border:0;border-radius:var(--r-xs);
  background:none;color:var(--text-dim);font:inherit;cursor:pointer}
.ov-sum button:hover{color:var(--text-bright);background:var(--list-hover)}
.ov-sum b{font-family:ui-monospace,monospace;font-weight:700;font-size:var(--fs-sm);color:var(--text-bright)}
.ov-sum .d{width:6px;height:6px;border-radius:50%;background:#3fb950;flex:0 0 auto}
.ov-sum .d.a{background:#d29922}.ov-sum .d.p{background:#a371f7}
/* 手指档把 tab 撑到 44：真机上默认高度只有 40（13 §7.1 的命中区下限） */

.ov-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--sp-4);align-items:start}
.ov-feed{min-width:0;display:flex;flex-direction:column;gap:var(--sp-3)}
.ov-sect{display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-sm);font-weight:600;color:var(--text-bright)}
.ov-sect .n{min-width:20px;height:20px;padding:0 6px;display:grid;place-items:center;border-radius:var(--r-pill);
  background:var(--bg-container);color:var(--text-dim);font:600 var(--fs-micro)/1 ui-monospace,monospace}
.ov-sect .ln{flex:1}
.ov-sect a{font-size:var(--fs-meta);font-weight:400}

/* 行动卡：一屏最多三张，超出走「查看全部」，不让黄框把项目卡挤到首屏以下 */
.ov-cards{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--sp-3)}
.ov-card{position:relative;min-width:0;min-height:118px;padding:12px 13px 34px;cursor:pointer;
  border:1px solid rgba(210,153,34,.28);border-radius:var(--r-card);
  background:radial-gradient(circle at 100% 0,rgba(210,153,34,.13),transparent 38%),
    linear-gradient(145deg,rgba(210,153,34,.09),rgba(210,153,34,.025));
  transition:border-color .15s,transform .15s}
.ov-card:hover{border-color:rgba(210,153,34,.55);transform:translateY(-1px)}
.ov-card.p{border-color:rgba(163,113,247,.28);
  background:radial-gradient(circle at 100% 0,rgba(163,113,247,.13),transparent 38%),rgba(163,113,247,.04)}
.ov-card.p:hover{border-color:rgba(163,113,247,.55)}
.ov-card .ty{display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-meta);font-weight:600;color:#e3b341}
.ov-card.p .ty{color:#a371f7}
.ov-card .ty .pj{color:var(--text-dimmer);font-weight:400}
.ov-card h4{margin:var(--sp-2) 0 var(--sp-1);font-size:var(--fs-body);color:var(--text-bright);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-card p{margin:0;height:36px;overflow:hidden;font-size:var(--fs-meta);line-height:1.5;color:var(--text-dim);
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.ov-card .go{position:absolute;left:var(--sp-3);bottom:var(--sp-3);font-size:var(--fs-meta);color:var(--accent)}

/* 项目卡栅格：阈值看 Canvas，不看 viewport */

/* 最近活动：≥1180 时是右侧 sticky 侧轨；窄于此它只是网格的第二行，自然落回页尾 */
.ov-rail{min-width:0;padding:var(--sp-3);border-radius:var(--r-card);background:var(--bg-container)}
.ov-rail h3{margin:0 0 var(--sp-3);font-size:var(--fs-sm);font-weight:600;color:var(--text-bright)}
.ov-tl{position:relative;display:flex;flex-direction:column;gap:var(--sp-4)}
.ov-tl::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;border-left:1px solid var(--border-subtle)}
.ov-ev{position:relative;padding-left:18px}
.ov-ev::before{content:"";position:absolute;left:1px;top:4px;width:7px;height:7px;border-radius:50%;
  border:2px solid var(--bg-container);background:#39c5cf}
.ov-ev.g::before{background:#3fb950}.ov-ev.p::before{background:#a371f7}
.ov-ev b{display:block;font-size:var(--fs-meta);color:var(--text-bright);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-ev p{margin:var(--sp-1) 0 0;font-size:var(--fs-meta);line-height:1.55;color:var(--text-dim);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ov-ev time{display:block;margin-top:var(--sp-1);font-size:var(--fs-micro);color:var(--text-dimmer)}

.ov-flow{display:flex;flex-direction:column}
.ov-frow{display:flex;align-items:center;gap:var(--sp-2);min-height:44px;padding:var(--sp-1) var(--sp-2);
  border-radius:var(--r-sm);cursor:pointer;transition:background .14s}
.ov-frow+.ov-frow{border-top:1px solid var(--border-subtle)}
.ov-frow:hover{background:var(--list-hover)}
.ov-frow .pj{flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--text-dimmer);font-size:var(--fs-meta)}
.ov-frow .nm{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--fs-sm);font-weight:600}
.ov-frow .ag{flex:0 0 auto;padding:1px 6px;border-radius:var(--r-pill);font-size:var(--fs-micro);
  color:#9ccaff;background:var(--accent-soft)}
.ov-frow .ag.cx{color:#7fd18f;background:rgba(63,185,80,.12)}
/* 六个格子在手机上按需塌陷：空的项目/Agent 格不占 gap，位置列整条不出现 */
.ov-frow .agw{display:flex;gap:var(--sp-1);flex:0 0 auto}
.ov-frow .pj::after{content:" ·"}
.ov-frow .pj:empty,.ov-frow .agw:empty,.ov-frow .loc{display:none}
.ov-frow .tm{margin-left:auto;flex:0 0 auto;font-size:var(--fs-meta);color:var(--text-dimmer);white-space:nowrap}
.ov-go-i{margin-left:3px;vertical-align:-1px;opacity:.75}
a:hover>.ov-go-i,button:hover>.ov-go-i,.ov-card:hover .ov-go-i{opacity:1}
.ov-mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.ov-in{animation:ovIn .34s cubic-bezier(.2,.85,.3,1) backwards}
@keyframes ovIn{from{opacity:0;transform:translateY(6px)}}

@container canvas (min-width: 900px){
  .ov-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ov-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  /* 会话流在桌面对齐成列（图纸 14-desktop-workspace/desktop-ia.html §一）。
     手机那行是「名字贴左、时间贴右」，拉到 838 宽之后中间 570px 是空的；
     桌面排成六列，空出来的宽度交给「位置」——⎇ 分支，或与项目目录不同时的工作目录。 */
  .ov-frow{display:grid;grid-template-columns:8px 128px minmax(170px,1fr) 60px 260px 74px;
    column-gap:var(--sp-3);align-items:center;min-height:40px}
  .ov-frow>*{min-width:0}
  .ov-frow .pj,.ov-frow .nm{flex:none;display:block}
  .ov-frow .pj::after{content:none}
  .ov-frow .agw{display:flex}
  .ov-frow .loc{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:var(--fs-meta);color:var(--text-dimmer)}
  .ov-frow .loc .br{color:#7ed0d8}
  .ov-frow .tm{margin-left:0;justify-self:end}
  /* 状态条并进页头右端：省掉一整行，也不会再出现「一枚数字 + 1092px 空白」的胶囊。
     它仍然是导航入口，所以只脱掉横条的底和内边距，hover/手型都留着。 */
  .ov .tt-pagehead{align-items:flex-end}
  .ov .tt-pagehead .acts{width:auto;margin-left:auto;padding-bottom:3px}
  .ov .tt-pagehead .acts>.ov-sum{flex:0 0 auto}
  .ov-sum{background:none;padding:0;min-height:0;border-radius:0}
}
@container canvas (min-width: 1180px){
  .ov-cards{grid-template-columns:repeat(3,minmax(0,1fr))}
  .ov-layout{grid-template-columns:minmax(0,1fr) var(--activity-rail)}
  .ov-rail{position:sticky;top:0;align-self:start}
}
@container canvas (min-width: 1320px){
  .ov-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
}
/* 不支持容器查询的老 WebView：退回单列，只是信息密度低，不会错位 */

/* 手指操作时把「进入项目 →」这类行内链接的命中区撑到 44，视觉尺寸不变（13 §7.1）。
   桌面鼠标不需要，撑了反而会互相咬到。 */
html[data-pointer="coarse"] .ov a,
html[data-pointer="coarse"] .ov-sum button{position:relative}
html[data-pointer="coarse"] .ov a::after,
html[data-pointer="coarse"] .ov-sum button::after{content:"";position:absolute;left:0;right:0;top:50%;
  height:44px;transform:translateY(-50%)}
`

type Proj = {
  key: string; name: string; dir: string; git: boolean; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; races: number
  lastActivity: number; firstSeen: number; top: { name: string }[] | null
}

type Card = {
  key: string; kind: 'waiting' | 'unfinished' | 'swarm'
  proj: string; title: string; desc: string; action: string; go: () => void
  /** 等待输入卡对应的会话名——「最近会话」要把它排除掉，两层才是互补而不是重复 */
  session?: string
}

// 项目图标底色：按名字取一个稳定色，卡片多了才能一眼分辨是哪个项目
// 文字箭头（→）在正文字号下和标点混在一起，粗细也跟不上界面的线性图标语言。
// 换成一枚 12px 的 chevron：与导航、标签条同一套描边风格。
const Go = () => (
  <svg className="ov-go-i" viewBox="0 0 24 24" width={12} height={12} aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 5 16 12 9 19" />
  </svg>
)

const ICO = [
  ['#9ccaff', 'rgba(31,111,235,.13)'], ['#c7a5ff', 'rgba(163,113,247,.13)'],
  ['#76d18a', 'rgba(63,185,80,.13)'], ['#f0ba5d', 'rgba(210,153,34,.13)'],
  ['#72d5de', 'rgba(57,197,207,.13)'], ['#f29089', 'rgba(248,81,73,.11)'],
]
function icoOf(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return ICO[h % ICO.length]
}

export default function Overview({ openTerm }: { openTerm: (n: string) => void }) {
  const { t, locale } = useI18n()
  const { phone: isPhone } = useLayout()
  const [projects, setProjects] = useState<Proj[]>([])
  const [loose, setLoose] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [ann, setAnn] = useState<Record<string, any>>({})
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [waiting, setWaiting] = useState<Record<string, boolean>>({})
  const [tail, setTail] = useState<Record<string, string>>({}) // 会话最后一行输出，给行动卡当摘要
  const [swarms, setSwarms] = useState<any[]>([]) // {name, goal, pending, members[], supervisor, boardHint}
  const [acts, setActs] = useState<any[]>([])

  // 项目聚合 + 会话/归属（与项目页同两条接口，5s）
  useEffect(() => {
    let stop = false
    const load = () => {
      api('GET', '/projects').then((r) => {
        if (stop) return
        setProjects(r?.data?.projects || []); setLoose(r?.data?.loose || [])
      }).catch(() => {})
      api('GET', '/sessions?tree=1').then((roots) => {
        if (stop) return
        const flat: any[] = []
        const walk = (ns: any[]) => { for (const n of ns || []) { flat.push(n); walk(n.children) } }
        walk(Array.isArray(roots) ? roots : [])
        setSessions(flat)
      }).catch(() => {})
      api('GET', '/sessions/annotations').then((r) => { if (!stop) setAnn(r?.data || {}) }).catch(() => {})
    }
    load()
    const i = setInterval(load, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [])

  // session → 项目 归属（git 按 annotation；非 git 用后端 top 名单近似）
  const sessByProj = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const p of projects) {
      const rows = p.git
        ? sessions.filter((s) => ann[s.name]?.primary?.repo === p.dir)
        : sessions.filter((s) => (p.top || []).some((x) => x.name === s.name))
      m.set(p.key, rows)
    }
    return m
  }, [projects, sessions, ann])
  const projSess = useMemo(() => [...sessByProj.values()].flat(), [sessByProj])

  // Agent 运行 + 待输入探测（只探项目内会话，上限 14 个防雪崩）
  useEffect(() => {
    const names = projSess.map((s) => s.name).slice(0, 14)
    if (!names.length) return
    let stop = false
    const check = () => names.forEach(async (n) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/claude`); if (!stop) setCc((m) => ({ ...m, [n]: !!r.data?.running })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/codex`); if (!stop) setCx((m) => ({ ...m, [n]: !!r.data?.running })) } catch {}
      try {
        const r = await api('GET', `/sessions/${encodeURIComponent(n)}/capture?lines=50`)
        if (stop) return
        const txt = r.data || ''
        setWaiting((m) => ({ ...m, [n]: !!detectPrompt(txt) }))
        // 同一份抓屏顺手留最后一行有内容的输出，给「等待输入」卡当摘要，不额外发请求
        const last = String(txt).split('\n').map((s: string) => s.trim()).filter(Boolean).pop() || ''
        setTail((m) => ({ ...m, [n]: last.slice(0, 120) }))
      } catch {}
    })
    check()
    const i = setInterval(check, 6000)
    return () => { stop = true; clearInterval(i) }
  }, [projSess.map((s) => s.name).join('\n')])

  // 蜂群投影（10s）：归属 = 指挥/成员会话 ∈ 某项目会话
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const list = await api('GET', '/swarms')
        const active = (Array.isArray(list) ? list : []).filter((s: any) => s.status !== 'archived')
        const out: any[] = []
        await Promise.all(active.map(async (sw: any) => {
          try {
            const st = await api('GET', `/swarms/${encodeURIComponent(sw.name)}`)
            const members = (st?.members || []) as any[]
            const names = [st?.supervisor, ...members.map((m) => m.session)].filter(Boolean)
            const proj = projects.find((p) => {
              const rows = sessByProj.get(p.key) || []
              return names.some((n) => rows.some((r) => r.name === n))
            })
            if (proj) out.push({ name: sw.name, projKey: proj.key, projName: proj.name, total: names.length, inProj: names.filter((n) => (sessByProj.get(proj.key) || []).some((r) => r.name === n)).length, pending: (st?.pending || []).length })
          } catch {}
        }))
        if (!stop) setSwarms(out)
      } catch {}
    }
    load()
    const i = setInterval(load, 10000)
    return () => { stop = true; clearInterval(i) }
  }, [projects, sessByProj])

  // 卡片辅助数据
  const running = (n: string) => cc[n] || cx[n]
  const projNeeds = (p: Proj) => {
    const rows = sessByProj.get(p.key) || []
    return rows.filter((s) => waiting[s.name]).length + (p.unfinished || 0)
      + swarms.filter((sw) => sw.projKey === p.key && sw.pending > 0).length
  }
  const activeProjects = useMemo(() => projects
    .filter((p) => {
      const rows = sessByProj.get(p.key) || []
      return rows.length > 0 || p.unfinished > 0 || swarms.some((sw) => sw.projKey === p.key)
    })
    .sort((a, b) => (projNeeds(b) - projNeeds(a)) || ((b.lastActivity || 0) - (a.lastActivity || 0))),
  [projects, sessByProj, swarms, waiting])
  const goProjects = () => { location.hash = '#/projects' }
  const goProject = (key: string) => { location.hash = '#/projects/' + encodeURIComponent(key) }
  const goSwarm = (name: string) => { location.hash = '#/swarm/' + encodeURIComponent(name) }

  // 行动队列：等待输入 / 待收尾 / 蜂群待解锁。等待输入排最前——它是唯一「人不动就卡住」的一类。
  const cards = useMemo(() => {
    const items: Card[] = []
    for (const p of projects) {
      for (const s of (sessByProj.get(p.key) || [])) {
        if (!waiting[s.name]) continue
        items.push({
          key: 'w' + s.name, kind: 'waiting', proj: p.name, session: s.name,
          title: s.label || s.name,
          desc: tail[s.name] || t('overview.cardWaitingDesc'),
          action: t('overview.cardGoSession'), go: () => openTerm(s.name),
        })
      }
    }
    for (const sw of swarms) {
      if (sw.pending <= 0) continue
      items.push({
        key: 's' + sw.name, kind: 'swarm', proj: sw.projName,
        title: '⬡ ' + sw.name,
        desc: t('overview.cardSwarmDesc', { count: sw.pending }),
        action: t('project.swarm.board'), go: () => goSwarm(sw.name),
      })
    }
    for (const p of projects) {
      if (p.unfinished <= 0) continue
      items.push({
        key: 'u' + p.key, kind: 'unfinished', proj: p.name,
        title: t('overview.unfinishedN', { count: p.unfinished }),
        desc: t('overview.cardUnfinishedDesc'),
        action: t('overview.goFinish'), go: () => goProject(p.key),
      })
    }
    return items
  }, [projects, sessByProj, waiting, tail, swarms, t])

  // 「最近会话」：跨项目扁平流，按最近活动倒序。这是概览与另外两页的分工线——
  // 项目页按仓库分组、会话页给全集+筛选，概览只回答「刚才在动的是哪几个」。
  // **排除已经进了行动卡的会话**：那条信息在上面已经说过一遍，重复出现两层就不互补了。
  // 桌面多 4 条：桌面一行 40（手机 44），左栏本来比右侧「最近活动」短一大截，
  // 8 条时页面下方空 310px（图纸 desktop-ia.html §一）。
  const recent = useMemo(() => {
    const inAction = new Set(cards.map((c) => c.session).filter(Boolean) as string[])
    const rows = new Map<string, { name: string; at: number; cwd: string }>()
    for (const s of projSess) if (!rows.has(s.name)) rows.set(s.name, { name: s.name, at: Number(s.last_activity || 0), cwd: s.cwd || '' })
    for (const s of loose as any[]) if (!rows.has(s.name)) rows.set(s.name, { name: s.name, at: Number(s.lastActivity || 0), cwd: s.cwd || '' })
    return [...rows.values()].filter((r) => !inAction.has(r.name))
      .sort((a, b) => b.at - a.at).slice(0, isPhone ? 8 : 12)
  }, [projSess, loose, cards, isPhone])

  // 最近活动：活跃 git 项目前 3 个各取头 2 条（commit+留痕），合并倒序（60s）
  useEffect(() => {
    const keys = activeProjects.filter((p) => p.git).slice(0, 3).map((p) => p.key)
    if (!keys.length) { setActs([]); return }
    let stop = false
    const load = async () => {
      const all: any[] = []
      await Promise.all(keys.map(async (k) => {
        try {
          const r = await api('GET', `/projects/${encodeURIComponent(k)}/activity`)
          const p = activeProjects.find((x) => x.key === k)
          for (const c of (r?.data?.commits || []).slice(0, 3)) all.push({ ...c, kind: 'commit', projName: p?.name })
          for (const tr of (r?.data?.traces || []).slice(0, 2)) all.push({ ...tr, kind: 'trace', projName: p?.name })
        } catch {}
      }))
      if (!stop) setActs(all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 8))
    }
    load()
    const i = setInterval(load, 60000)
    return () => { stop = true; clearInterval(i) }
  }, [activeProjects.map((p) => p.key).join(',')])

  // 状态概况的四个数——都是导航入口，但不再各占一张等权卡片
  const stats = {
    running: projSess.filter((s) => running(s.name)).length,
    waiting: projSess.filter((s) => waiting[s.name]).length,
    unfinished: projects.reduce((n, p) => n + (p.unfinished || 0), 0),
    swarms: swarms.length,
  }
  const lastAt = projects.reduce((n, p) => Math.max(n, p.lastActivity || 0), 0)
  const hour = new Date().getHours()
  const greet = t(hour < 6 ? 'overview.greetNight' : hour < 12 ? 'overview.greetMorning'
    : hour < 18 ? 'overview.greetAfternoon' : 'overview.greetEvening')
  const kicker = useMemo(() => {
    try { return new Date().toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }) } catch { return '' }
  }, [locale])

  // 零值项整个不渲染：「0 等待输入」不是信息，是噪声——四格里常有两格是 0，
  // 在 360 的屏上还把这一条挤到横向溢出。全为零时整条消失。
  // （不在这条右端再放「进入项目页」——下一行的 tab 条右边已经有同一个入口了。）
  const sumItem = (n: number, cls: string, label: string) => (n > 0 ? (
    <button key={label} type="button" onClick={goProjects}>
      <i className={`d ${cls}`} /><b>{n}</b>{label}
    </button>
  ) : null)

  const railNode = acts.length > 0 && (
    <aside className="ov-rail ov-in" style={{ animationDelay: '160ms' }}>
      <h3>{t('overview.recentActivity')}</h3>
      <div className="ov-tl">
        {acts.map((e: any) => (
          <div key={(e.oid || e.branch) + e.at} className={`ov-ev ${e.kind === 'trace' ? 'p' : ''}`}>
            <b>{e.kind === 'trace' ? `⇥ ${e.branch}` : <><span className="ov-mono">{e.oid}</span> · {e.projName}</>}</b>
            <p>{e.kind === 'trace'
              ? t('project.act.traceMerged', { branch: e.branch, base: e.base || '?', strategy: e.strategy || 'squash' })
              : e.subject}</p>
            <time>{e.kind === 'trace' ? `${e.projName} · ` : ''}{relTime(e.at, t)}</time>
          </div>
        ))}
      </div>
    </aside>
  )

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <style>{OV_CSS}</style>
      <div className="ov">
        {/* ① 问候区：首屏第一句话回答「今天有几件事需要你」，零事项时是安静状态。
            ② 状态概况挂在页头的 .acts 槽里：桌面并到标题右端（省一行），窄档换行成一条横条。 */}
        <header className="tt-pagehead ov-in">
          <div className="ttl">
            <h2>{greet}{cards.length > 0
              ? t('overview.headlineNeeds', { count: cards.length })
              : t('overview.headlineQuiet')}</h2>
            {/* 日期从标题上方挪到下方，与「最近活动」合成一行小字（图纸 pagehead.html §三）：
                先说事、再说时间。副句里原本还写着「12 个任务正在运行」——和右端状态条的
                「12 运行中」是同一个数，一左一右钉在同一条基线上、中间空 800px。
                数字归状态条，一个数只说一次。 */}
            <p>{kicker}{' · '}{stats.running > 0
              ? t('overview.metaActivity', { time: relTime(lastAt, t) })
              : t('overview.sublineIdle')}</p>
          </div>
          {(stats.running + stats.waiting + stats.unfinished + stats.swarms) > 0 && (
            <div className="acts">
              <div className="ov-sum ov-in" style={{ animationDelay: '50ms' }}>
                {sumItem(stats.running, '', t('overview.sumRunning'))}
                {sumItem(stats.waiting, 'a', t('overview.sumWaiting'))}
                {sumItem(stats.unfinished, 'a', t('overview.sumUnfinished'))}
                {sumItem(stats.swarms, 'p', t('overview.sumSwarms'))}
              </div>
            </div>
          )}
        </header>

        <div className="ov-layout">
            <div className="ov-feed">
              {/* ③ 行动卡：最多三张，零事项整层不渲染 */}
              {cards.length > 0 && (
                <>
                  <div className="ov-sect">
                    <span>{t('overview.needsYou')}</span><span className="n">{cards.length}</span><span className="ln" />
                    {cards.length > 3 && <a onClick={goProjects}>{t('overview.viewAllN', { count: cards.length })}<Go /></a>}
                  </div>
                  <div className="ov-cards">
                    {cards.slice(0, 3).map((c, i) => (
                      <article key={c.key} className={`ov-card ov-in${c.kind === 'swarm' ? ' p' : ''}`}
                        style={{ animationDelay: `${80 + i * 40}ms` }} onClick={c.go}>
                        <div className="ty">
                          <i className={`d ${c.kind === 'swarm' ? 'p' : 'a'}`}
                            style={{ width: 6, height: 6, borderRadius: '50%', background: c.kind === 'swarm' ? '#a371f7' : '#d29922' }} />
                          {t(c.kind === 'waiting' ? 'overview.cardWaiting' : c.kind === 'swarm' ? 'overview.cardSwarm' : 'overview.cardUnfinished')}
                          <span className="pj">· {c.proj}</span>
                        </div>
                        <h4 title={c.title}>{c.title}</h4>
                        <p>{c.desc}</p>
                        <span className="go">{c.action}<Go /></span>
                      </article>
                    ))}
                  </div>
                </>
              )}

              {/* ④ 最近会话：跨项目扁平流，按最近活动倒序。
                  这一层**不是**项目卡网格——那是项目页的活；也不是带筛选的会话列表——那是会话页的活。
                  概览只回答「刚才在动的是哪几个」，所以不分组、不筛选、只取 8 条。 */}
              {recent.length > 0 && (
                <>
                  <div className="ov-sect">
                    <span>{t('overview.recentSessions')}</span><span className="ln" />
                    <a onClick={() => { location.hash = '#/sessions' }}>{t('overview.allSessions')}<Go /></a>
                  </div>
                  <div className="ov-flow">
                    {recent.map((r) => {
                      const w = waiting[r.name]
                      const proj = projects.find((p) => (sessByProj.get(p.key) || []).some((x) => x.name === r.name))
                      // 六个格子在桌面必须恒定，缺一个就整行错列——所以空的项目/Agent 格照样渲染，
                      // 由 :empty 在手机上塌陷掉。
                      const loc = sessionLocation(ann[r.name], r.cwd, proj?.dir)
                      return (
                        <div key={r.name} className="ov-frow" onClick={() => openTerm(r.name)}>
                          {dot(false, w ? '#d29922' : running(r.name) ? '#3fb950' : undefined)}
                          <span className="pj">{proj?.name}</span>
                          <span className="nm" title={r.name}>{sessionLabel(r.name)}</span>
                          <span className="agw">
                            {cc[r.name] && <span className="ag">Claude</span>}
                            {cx[r.name] && <span className="ag cx">Codex</span>}
                          </span>
                          <span className="loc" title={loc.title}>
                            {loc.branch ? <span className="br">⎇ {loc.branch}</span> : loc.path}
                          </span>
                          <span className="tm">{relTime(r.at, t)}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

          {/* ⑤ 最近活动：Canvas ≥1180 是右侧 sticky 侧轨，窄于此落回页尾 */}
          {railNode}
        </div>
      </div>
    </div>
  )
}
