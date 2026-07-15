// 概览页（08 设计 P6）——项目为主的作战地图：
//   ①「需要你」横幅置顶：跨项目汇总 待输入任务 / 待收尾孤儿 / 蜂群待解锁，零事项整条消失
//   ② 统计条一排直达；③ 主体 = 活跃项目作战卡（内嵌 进行中任务前 3 + ⬡ 蜂群摘要 + 待收尾黄条）
//   ④ 底部双列：散会话 ｜ 最近活动（跨项目 commit + 收尾留痕）
// 数据全部复用现有接口（/projects、annotations、per-session 探测、/swarms 投影、activity），零新后端。
import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'
import { detectPrompt } from './prompt'
import { relTime } from './App'
import { Lifec, dot } from './Projects'

const P6_CSS = `
.p6-wrap{max-width:1180px;margin:0;padding:0 0 32px;display:flex;flex-direction:column;gap:12px}
.p6-attn{border:1px solid rgba(210,153,34,.4);border-radius:12px;padding:10px 14px;
  background:linear-gradient(180deg,rgba(210,153,34,.09),rgba(210,153,34,.04))}
.p6-attn .hd{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;color:#e3b341}
.p6-attn .it{display:flex;align-items:center;gap:8px;padding:6px 2px 0;font-size:12.5px;cursor:pointer}
.p6-attn .it .proj{color:var(--text-dimmer)}
.p6-attn .it .sep{color:var(--text-dimmer);opacity:.6}
.p6-attn .it a{margin-left:auto;font-size:12px;flex:0 0 auto}
.p6-stats{display:flex;gap:10px;flex-wrap:wrap}
.p6-stat{flex:1 1 120px;min-width:110px;cursor:pointer;background:var(--bg-container);
  border:1px solid var(--border-subtle);border-radius:11px;padding:10px 13px;
  transition:border-color .15s,transform .15s}
.p6-stat:hover{border-color:rgba(88,166,255,.4);transform:translateY(-1px)}
.p6-stat .v{font-size:20px;font-weight:800;font-family:ui-monospace,monospace}
.p6-stat .k{font-size:11.5px;color:var(--text-dim);margin-top:1px}
.p6-stat.g .v{color:#3fb950}.p6-stat.y .v{color:#d29922}.p6-stat.p .v{color:#a371f7}
.p6-sect{display:flex;align-items:center;gap:8px;margin:4px 2px 0;font-size:11px;
  letter-spacing:.08em;color:var(--text-dim);font-weight:700}
.p6-sect .n{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-dimmer);font-weight:400}
.p6-sect .ln{flex:1;border-top:1px dashed var(--border-subtle)}
.p6-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.p6-proj{background:var(--bg-container);border:1px solid var(--border-subtle);border-radius:12px;
  padding:12px 14px 10px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s}
.p6-proj:hover{border-color:rgba(88,166,255,.35)}
.p6-proj .hd{display:flex;align-items:center;gap:8px}
.p6-proj .hd b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p6-proj .hd a{margin-left:auto;font-size:12px;flex:0 0 auto}
.p6-trow{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:7px;
  font-size:12.5px;cursor:pointer;transition:background .14s}
.p6-trow:hover{background:var(--list-hover)}
.p6-trow .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p6-trow .tm{margin-left:auto;color:var(--text-dimmer);font-size:11px;flex:0 0 auto}
.p6-swarm{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:8px;
  border:1px solid rgba(163,113,247,.25);background:rgba(163,113,247,.06);font-size:12px}
.p6-unfin{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:8px;
  border:1px solid rgba(210,153,34,.25);background:rgba(210,153,34,.06);font-size:12px;color:#e3b341}
.p6-swarm a,.p6-unfin a{margin-left:auto;font-size:11.5px;flex:0 0 auto}
.p6-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.p6-mini{background:var(--bg-container);border:1px solid var(--border-subtle);border-radius:12px;padding:10px 12px}
.p6-mini .row{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px;color:var(--text-dim)}
.p6-mini .row .tm{margin-left:auto;color:var(--text-dimmer);font-size:11px;flex:0 0 auto}
.p6-mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.p6-in{animation:p6In .38s cubic-bezier(.2,.85,.3,1) backwards}
@keyframes p6In{from{opacity:0;transform:translateY(6px)}}
`

type Proj = {
  key: string; name: string; dir: string; git: boolean; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; races: number
  lastActivity: number; firstSeen: number; top: { name: string }[] | null
}

export default function Overview({ openTerm }: { openTerm: (n: string) => void }) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Proj[]>([])
  const [loose, setLoose] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [ann, setAnn] = useState<Record<string, any>>({})
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [waiting, setWaiting] = useState<Record<string, boolean>>({})
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
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/capture?lines=50`); if (!stop) setWaiting((m) => ({ ...m, [n]: !!detectPrompt(r.data || '') })) } catch {}
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
  const inactiveCount = projects.length - activeProjects.length

  //「需要你」条目：待输入任务 + 待收尾项目 + 蜂群待解锁（上限 5）
  const attention = useMemo(() => {
    const items: { key: string; proj: Proj; label: string; tag: string; onGo: () => void }[] = []
    for (const p of projects) {
      for (const s of (sessByProj.get(p.key) || [])) {
        if (waiting[s.name]) items.push({ key: 'w' + s.name, proj: p, label: s.name, tag: t('overview.waiting'), onGo: () => openTerm(s.name) })
      }
      if (p.unfinished > 0) items.push({ key: 'u' + p.key, proj: p, label: t('overview.unfinishedN', { count: p.unfinished }), tag: t('project.section.unfinished'), onGo: () => { location.hash = '#/projects/' + encodeURIComponent(p.key) } })
    }
    for (const sw of swarms) {
      if (sw.pending > 0) {
        const p = projects.find((x) => x.key === sw.projKey)
        if (p) items.push({ key: 's' + sw.name, proj: p, label: '⬡ ' + sw.name, tag: t('overview.pendingN', { count: sw.pending }), onGo: () => { location.hash = '#/swarm/' + encodeURIComponent(sw.name) } })
      }
    }
    return items
  }, [projects, sessByProj, waiting, swarms, t])

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
          for (const c of (r?.data?.commits || []).slice(0, 2)) all.push({ ...c, kind: 'commit', projName: p?.name })
          for (const tr of (r?.data?.traces || []).slice(0, 1)) all.push({ ...tr, kind: 'trace', projName: p?.name })
        } catch {}
      }))
      if (!stop) setActs(all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 6))
    }
    load()
    const i = setInterval(load, 60000)
    return () => { stop = true; clearInterval(i) }
  }, [activeProjects.map((p) => p.key).join(',')])

  // 统计
  const stats = {
    projects: projects.length,
    running: projSess.filter((s) => running(s.name)).length,
    waiting: projSess.filter((s) => waiting[s.name]).length,
    unfinished: projects.reduce((n, p) => n + (p.unfinished || 0), 0),
    swarms: swarms.length,
  }
  const goProjects = () => { location.hash = '#/projects' }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <style>{P6_CSS}</style>
      <div className="p6-wrap">
        {/* 标题行（品牌 hero 压缩）：主角是项目 */}
        <div className="p6-in" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{t('nav.overview')}</span>
          <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('overview.activeHint', { count: activeProjects.length })}</span>
          <span style={{ flex: 1 }} />
          <Button size="small" onClick={goProjects}>{t('overview.gotoProjects')} →</Button>
        </div>

        {/* ①「需要你」横幅：零事项整条消失 */}
        {attention.length > 0 && (
          <div className="p6-attn p6-in" style={{ animationDelay: '50ms' }}>
            <div className="hd">⚠ {t('overview.needsYou')}
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-dim)' }}>{t('overview.needsYouCount', { count: attention.length })}</span>
            </div>
            {attention.slice(0, 5).map((it) => (
              <div key={it.key} className="it" onClick={it.onGo}>
                {dot(false, '#d29922')}
                <span className="proj">{it.proj.name}</span><span className="sep">›</span>
                <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</b>
                <Tag color="warning" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>{it.tag}</Tag>
                <a>→</a>
              </div>
            ))}
            {attention.length > 5 && <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', paddingTop: 4 }}>+{attention.length - 5}</div>}
          </div>
        )}

        {/* ② 统计条 */}
        <div className="p6-stats p6-in" style={{ animationDelay: '90ms' }}>
          <div className="p6-stat" onClick={goProjects}><div className="v">{stats.projects}</div><div className="k">{t('project.title')}</div></div>
          <div className="p6-stat g" onClick={goProjects}><div className="v">{stats.running}</div><div className="k">{t('overview.runningTasks')}</div></div>
          <div className="p6-stat y" onClick={goProjects}><div className="v">{stats.waiting}</div><div className="k">{t('overview.waiting')}</div></div>
          <div className="p6-stat y" onClick={goProjects}><div className="v">{stats.unfinished}</div><div className="k">{t('project.section.unfinished')}</div></div>
          <div className="p6-stat p" onClick={goProjects}><div className="v">{stats.swarms}</div><div className="k">{t('nav.swarm')}</div></div>
        </div>

        {/* ③ 活跃项目作战卡 */}
        <div className="p6-sect"><span>{t('overview.activeProjects')}</span><span className="n">{activeProjects.length}</span><span className="ln" /></div>
        <div className="p6-grid">
          {activeProjects.map((p, i) => {
            const rows = (sessByProj.get(p.key) || [])
              .sort((a, b) => (Number(running(b.name)) - Number(running(a.name))) || (Number(b.last_activity || 0) - Number(a.last_activity || 0)))
            const shown = rows.slice(0, 3)
            const projSwarms = swarms.filter((sw) => sw.projKey === p.key)
            return (
              <div key={p.key} className="p6-proj p6-in" style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}>
                <div className="hd">
                  <b>{p.name}</b>
                  {p.git && <span className="p6-mono" style={{ fontSize: 10.5, color: 'var(--text-dimmer)' }}>{p.dir.split('/').pop()}</span>}
                  <a onClick={() => { location.hash = '#/projects/' + encodeURIComponent(p.key) }}>{t('overview.enterProject')} →</a>
                </div>
                {shown.map((s) => {
                  const w = waiting[s.name]
                  const r = running(s.name)
                  return (
                    <div key={s.name} className="p6-trow" onClick={() => openTerm(s.name)}>
                      {dot(false, w ? '#d29922' : r ? '#3fb950' : undefined)}
                      <span className="nm">{s.name}</span>
                      {ann[s.name]?.primary?.linked && <Tag color="cyan" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px', padding: '0 5px' }}>⎇</Tag>}
                      <Lifec done={r ? 1 : 2} cur={r && !w ? 2 : w ? 3 : undefined} />
                      <span className="tm">{relTime(s.last_activity, t)}</span>
                    </div>
                  )
                })}
                {rows.length > 3 && <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', paddingLeft: 6 }}>{t('overview.moreTasks', { count: rows.length - 3 })}</div>}
                {projSwarms.map((sw) => (
                  <div key={sw.name} className="p6-swarm">
                    <span style={{ color: '#a371f7' }}>⬡</span><b>{sw.name}</b>
                    <span style={{ color: 'var(--text-dimmer)' }}>{t('project.swarm.members', { mine: sw.inProj, total: sw.total })}</span>
                    <a onClick={() => { location.hash = '#/swarm/' + encodeURIComponent(sw.name) }}>{t('project.swarm.board')} →</a>
                  </div>
                ))}
                {p.unfinished > 0 && (
                  <div className="p6-unfin">⚑ {t('overview.unfinishedN', { count: p.unfinished })}
                    <a onClick={() => { location.hash = '#/projects/' + encodeURIComponent(p.key) }}>{t('overview.goFinish')} →</a>
                  </div>
                )}
              </div>
            )
          })}
          {inactiveCount > 0 && (
            <div className="p6-proj" style={{ borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dimmer)', fontSize: 12.5, minHeight: 96, cursor: 'pointer' }}
              onClick={goProjects}>
              {t('overview.inactiveRest', { count: inactiveCount })}
            </div>
          )}
        </div>

        {/* ④ 散会话 ｜ 最近活动 */}
        <div className="p6-cols">
          {loose.length > 0 && (
            <div className="p6-mini">
              <div className="p6-sect" style={{ margin: '0 0 6px' }}><span>{t('project.loose')}</span><span className="n">{loose.length}</span><span className="ln" /></div>
              {loose.slice(0, 5).map((s: any) => (
                <div key={s.name} className="row" style={{ cursor: 'pointer' }} onClick={() => openTerm(s.name)}>
                  {dot(s.attached)}
                  <b style={{ color: 'var(--text-bright)' }}>{s.name}</b>
                  <span className="tm">{relTime(s.lastActivity, t)}</span>
                </div>
              ))}
            </div>
          )}
          {acts.length > 0 && (
            <div className="p6-mini">
              <div className="p6-sect" style={{ margin: '0 0 6px' }}><span>{t('overview.recentActivity')}</span><span className="ln" /></div>
              {acts.map((e: any) => (
                <div key={(e.oid || e.branch) + e.at} className="row">
                  {e.kind === 'trace'
                    ? <span style={{ color: '#a371f7' }}>⇥</span>
                    : <span className="p6-mono" style={{ color: '#39c5cf', opacity: 0.8 }}>{e.oid}</span>}
                  <span className="p6-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.kind === 'trace' ? t('project.act.traceMerged', { branch: e.branch, base: e.base || '?', strategy: e.strategy || 'squash' }) : e.subject}
                  </span>
                  <span className="tm">{e.projName} · {relTime(e.at, t)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
