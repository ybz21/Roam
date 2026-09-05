// 左栏项目树的本地快照：刷新后第一帧就能把树画出来。
//
// 树的原料要两步才齐：/projects（几毫秒）+ 每个 git 项目一条 /git/worktrees。后者在后端
// 每个 worktree 要跑十来条 git 命令，串行扫十几个项目实测 1.5~2s（冷盘更久）——这段时间里
// 树是空的，会话全挤在「散会话」下面，等 worktree 到了再整棵跳一次。台账早就在库里了，
// 用户看到的却是每次刷新都重新长出来一遍。
//
// 所以把上一轮扫到的原料按机器存一份，下次进来先拿它画（AGENTS.md「Preferences Arrive
// Late」那条同一个道理：看得见的东西，第一帧就得是对的）。服务端仍是唯一真相源，快照只
// 负责这 1~2 秒的空窗；扫完照旧整份替换，所以项目没了、worktree 没了都会自己收敛。
import { currentNodeId } from '../cluster/node-url'

/** 树的两份服务端原料（第三份 /sessions 5s 一轮、自己就很快，不进快照） */
export type TreeSrc = { projects: any[]; worktrees: Record<string, any[]> }

const KEY = 'roam.tree'
/** 最多记几台机器——和终端标签一样按最后使用时间淘汰 */
const MAX_NODES = 4
/** 过了这么久的快照不再顶上：隔了一天再回来，工作区大概已经不是那个样子了 */
const MAX_AGE_MS = 24 * 3600 * 1000

type Entry = TreeSrc & { at: number }

/** 单机（没有 nodeId）也占一格，键是空串——单机与多机走同一条路径，不写分支 */
function slot(nodeId: string | null): string {
  return nodeId || ''
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

/** 上一轮的原料；没有 / 过期 / 存坏了都返回空树，调用方照旧等接口 */
export function loadTreeSrc(nodeId: string | null = currentNodeId()): TreeSrc {
  const e = readAll()[slot(nodeId)]
  if (!e || !Array.isArray(e.projects) || Date.now() - (e.at || 0) > MAX_AGE_MS) return { projects: [], worktrees: {} }
  return { projects: e.projects, worktrees: e.worktrees && typeof e.worktrees === 'object' ? e.worktrees : {} }
}

/** 一轮 worktree 扫完后存一份。只在扫完整存：半份快照会让下次刷新画出缺几个项目的树 */
export function saveTreeSrc(src: TreeSrc, nodeId: string | null = currentNodeId()) {
  const all = readAll()
  const cur = slot(nodeId)
  all[cur] = { projects: src.projects, worktrees: src.worktrees, at: Date.now() }
  // 刚写的这台永远留着，只在**其余**里淘汰
  const others = Object.keys(all).filter((k) => k !== cur)
  if (others.length > MAX_NODES - 1) {
    others.sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0))
    for (const k of others.slice(MAX_NODES - 1)) delete all[k]
  }
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* 隐私模式/配额满：记不住而已，不该崩 */ }
}
