// 会话 → 项目 的归属表（14 设计 §6.3）。
//
// 终端标签是跨页常驻的：你在概览页开了 roam 的会话，切到别的项目页，标签还在那儿。
// 标签上只写会话名的话，第三个标签是哪个项目的就得靠记。所以标签统一写
// `项目 · 会话`，分支进 Tooltip——而不是再加一条 context strip（14 §6.3.2）。
//
// 和 session-label 一样是模块级小表 + useSyncExternalStore：要用它的地方（终端标签、
// 会话胶囊、标签右键菜单）散在各处，数据源却只有 App 那一份轮询。
import { useSyncExternalStore } from 'react'

export type SessionProject = { key: string; name: string; branch?: string }

let table: Record<string, SessionProject> = {}
const listeners = new Set<() => void>()

/** 内容没变就不触发重渲染——这张表 15s 刷一次，绝大多数时候是一样的。 */
export function setSessionProjects(next: Record<string, SessionProject>) {
  const keys = Object.keys(next)
  const same = keys.length === Object.keys(table).length && keys.every((k) => {
    const a = table[k], b = next[k]
    return a && b && a.key === b.key && a.name === b.name && a.branch === b.branch
  })
  if (same) return
  table = next
  listeners.forEach((fn) => fn())
}

export function sessionProject(name?: string | null): SessionProject | undefined {
  return name ? table[name] : undefined
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useSessionProject(name?: string | null): SessionProject | undefined {
  return useSyncExternalStore(subscribe, () => sessionProject(name), () => sessionProject(name))
}

/**
 * 从 `/projects` 与 `/sessions/annotations` 两条现成接口拼归属表。
 *
 * git 项目按 annotation 里的 repo 目录匹配；非 git 项目后端只给了 `top` 名单
 * （每个项目最近几个会话），只能近似——够用了，标签前缀标错的代价是"看着眼熟但
 * 不对"，不是功能失效，而为此新开一条接口不值。
 */
export function buildSessionProjects(
  projects: { key: string; name: string; dir: string; git: boolean; top?: { name: string }[] | null }[],
  annotations: Record<string, any>,
): Record<string, SessionProject> {
  const byDir = new Map<string, { key: string; name: string }>()
  for (const p of projects) if (p.git) byDir.set(p.dir, { key: p.key, name: p.name })

  const out: Record<string, SessionProject> = {}
  for (const [session, ann] of Object.entries(annotations || {})) {
    const primary = (ann as any)?.primary
    const hit = primary?.repo && byDir.get(primary.repo)
    if (hit) out[session] = { ...hit, branch: primary.branch || undefined }
  }
  // 非 git 项目兜底：已经有归属的不覆盖（annotation 比 top 名单准）
  for (const p of projects) {
    if (p.git) continue
    for (const s of p.top || []) if (!out[s.name]) out[s.name] = { key: p.key, name: p.name }
  }
  return out
}
