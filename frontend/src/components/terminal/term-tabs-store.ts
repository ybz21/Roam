// 每台机器各记一份自己开着的终端标签。
//
// 切机器是整页重载，而 URL 里的 `terms=` 是**上一台**机器的会话 id：原样带过去会在新机器上
// 还原一批根本不存在的标签（#190 修的就是这个，办法是切之前清空）。清空的代价是切回来时
// 上一台开着的终端也没了——人在两台机器之间来回，等于每次都要重开一遍。
//
// 这里把「清空」换成「按机器各记各的」：切走前这台的标签已经存下（URL 同步那一步顺手存），
// 切过去时把那台上次的标签填回 URL，由现有的还原逻辑接手。**同一时刻 dock 里只有当前机器的
// 标签**——这与「机器切换器是全局唯一的一个」这条 UI 决定一致（见 docs/design/cluster/ui.html）：
// 页面从不混着画两台机器的东西，终端也不该例外。
//
// 存 localStorage 而不是服务端偏好：① 切机器要整页重载，异步偏好回来得太晚
// （AGENTS.md「Preferences Arrive Late」）；② 这本来就是「这台浏览器上开着哪些窗口」，
// 跟设备走，不跟账号走。

const KEY = 'roam.terms'
/** 最多记几台机器的标签——超了按最后使用时间淘汰，别让它无限长 */
const MAX_NODES = 8

export type TabSet = { terms: string[]; active: string; task: string }
type Entry = TabSet & { at: number }

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

function writeAll(all: Record<string, Entry>) {
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* 隐私模式/配额满：记不住而已，不该崩 */ }
}

/** 存一台机器当前开着的标签。terms 是**写进 URL 的那种 token**（会话 id），不是显示名。 */
export function saveTabs(nodeId: string | null, terms: string[], active: string, task = '') {
  const all = readAll()
  const cur = slot(nodeId)
  // at 严格递增，不直接用 Date.now()：切标签是连着来的，同一毫秒内存好几次很正常，
  // 时间戳一撞，下面的淘汰就只能按 key 顺序瞎猜，可能把刚用过的那台挤掉。
  const maxAt = Object.values(all).reduce((m, e) => Math.max(m, e?.at || 0), 0)
  all[cur] = { terms, active, task, at: Math.max(Date.now(), maxAt + 1) }
  // 刚写的这台永远留着，只在**其余**里淘汰——否则「存一次就把自己挤掉」是可能的
  const others = Object.keys(all).filter((k) => k !== cur)
  if (others.length > MAX_NODES - 1) {
    others.sort((a, b) => (all[b].at || 0) - (all[a].at || 0))
    for (const k of others.slice(MAX_NODES - 1)) delete all[k]
  }
  writeAll(all)
}

/** 取一台机器上次开着的标签；没记过就是空。 */
export function loadTabs(nodeId: string | null): TabSet {
  const e = readAll()[slot(nodeId)]
  if (!e || !Array.isArray(e.terms)) return { terms: [], active: '', task: '' }
  // 老数据没有 task 字段：照常读，任务由还原时按 active 会话算出来
  return { terms: e.terms.filter((x) => typeof x === 'string' && x), active: typeof e.active === 'string' ? e.active : '', task: typeof e.task === 'string' ? e.task : '' }
}

/** 会话 id 的形状（后端 internal/id：YYYY-MMDD-HHMM-rand4）。 */
const ID_RE = /^\d{4}-\d{4}-\d{4}-[a-z0-9]{4}$/

/**
 * 还原前先滤一遍：**长得像 id 但在这台机器上查无此会话**的一律丢掉。
 *
 * 不丢就会长出打不开的空标签——切机器、或者会话在别处被关掉，都会走到这。
 * 不像 id 的 token 是老链接里存的会话名（那时 URL 写的是名字），照旧放行：
 * 名字查不到可能只是列表还没刷到。
 */
export function dropDeadTokens(tokens: string[], knownIds: Record<string, string>): string[] {
  return tokens.filter((tok) => !ID_RE.test(tok) || !!knownIds[tok])
}
