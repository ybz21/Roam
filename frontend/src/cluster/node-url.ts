// 「当前机器」与它的 URL 前缀——多机的全部寻址收口在这一个文件。
//
// 单机与多机走**同一份代码**：没有 currentNodeId 时 nodePath() 返回今天的路径，
// 一个字节都不差。这就是「没连 Broker 就零变化」在实现层面的保证——不是靠两条分支，
// 是靠一个恒等式。所以别在调用处写 `isBroker ? … : …`，那等于把分支散回去。
//
// 寻址只用**稳定 nodeId**，显示名可重命名、可重复，永不参与路由（见
// docs/design/cluster/architecture.html §4）。
import { useSyncExternalStore } from 'react'

export type ClusterNode = {
  id: string
  name: string
  hostname: string
  os: string
  version: string
  group?: string
  capabilities?: string[]
  sessionCount: number
  load: number
  latencyMs: number
  online: boolean
}

const MIRROR = 'roam.nodeId'

// 首帧就要有值，否则第一批请求会打到错的机器上——偏好是异步到的，靠不住
// （AGENTS.md「Preferences Arrive Late」）。所以当前机器**先读本地镜像**，
// Broker 的推荐值只在本地没有或已失效时才用。
function readMirror(): string | null {
  try {
    return localStorage.getItem(MIRROR) || null
  } catch {
    return null
  }
}

let nodeId: string | null = readMirror()
let nodes: ClusterNode[] = []
let broker = false
const subs = new Set<() => void>()

function emit() {
  subs.forEach((f) => f())
}

function subscribe(f: () => void) {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}

/** 当前机器 id；null = 单机（或直连某台节点的本机口）。 */
export function currentNodeId(): string | null {
  return nodeId
}

/** 是否连着云端 Broker。单机时为 false，此时所有多机 UI 都不渲染。 */
export function isBrokerMode(): boolean {
  return broker
}

export function clusterNodes(): ClusterNode[] {
  return nodes
}

export function currentNode(): ClusterNode | null {
  return nodes.find((n) => n.id === nodeId) || null
}

export function setCurrentNode(id: string | null) {
  if (nodeId === id) return
  nodeId = id
  try {
    if (id) localStorage.setItem(MIRROR, id)
    else localStorage.removeItem(MIRROR)
  } catch { /* 无痕模式：内存里仍然对，只是刷新后回到推荐节点 */ }
  emit()
}

/**
 * 给路径加上机器前缀。**所有** HTTP / WS / 原生资源 URL 都要过这里——
 * 包括 <img src>、<iframe src>、<a download>、window.open 这些加不了 header 的，
 * 这也正是身份走路径而不走 header 的原因。
 */
export function nodePath(path: string): string {
  return nodeId ? `/n/${encodeURIComponent(nodeId)}${path}` : path
}

/** `/api/...` 的简写；传的 p 以 / 开头，如 nodeApi('/sessions')。 */
export function nodeApi(p: string): string {
  return nodePath('/api' + p)
}

/** WebSocket 绝对地址（Terminal / 镜像 / 信令都用它拼）。 */
export function nodeWs(p: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${nodePath('/api' + p)}`
}

/** 镜像页要把「host + 路径」塞进查询参数（DevTools 的 wss= 就是这么要的）。 */
export function nodeWsHostPath(p: string): string {
  return `${location.host}${nodePath('/api' + p)}`
}

export function useCurrentNodeId(): string | null {
  return useSyncExternalStore(subscribe, currentNodeId, () => null)
}

export function useClusterNodes(): ClusterNode[] {
  return useSyncExternalStore(subscribe, clusterNodes, () => [])
}

export function useBrokerMode(): boolean {
  return useSyncExternalStore(subscribe, isBrokerMode, () => false)
}

/**
 * 启动引导。**必须在应用发出第一条业务请求之前跑完**，否则那几条会打到 /api/*，
 * 在 Broker 上是 404。它只打一个 Broker-local 端点，不依赖 current node
 * ——反过来就是死循环：要读偏好得先知道去哪台机器读。
 *
 * 单机后端没有这个路由，404 即判定为单机，此后一切照旧。
 */
export async function bootstrapCluster(): Promise<void> {
  try {
    const r = await fetch('/api/broker/bootstrap', { cache: 'no-store' })
    if (!r.ok) return // 404 = 单机；401 = 未登录，登录后 App 会再引导一次
    const data = (await r.json())?.data || {}
    nodes = data.nodes || []
    broker = true
    const online = nodes.filter((n) => n.online)
    // 顺序：URL 深链 > 本地镜像 > Broker 推荐。前两者不发请求，所以首帧就定得下来。
    const fromUrl = new URLSearchParams(location.hash.split('?')[1] || '').get('node')
    const candidates = [fromUrl, nodeId, data.recommended]
    const pick = candidates.find((id) => id && online.some((n) => n.id === id))
      || online[0]?.id || null
    setCurrentNode(pick)
    emit()
  } catch {
    // 网络抖动：当单机处理。真连着 Broker 的话，下一次刷新会自愈，
    // 而误判成多机（把请求打到 /n/<不存在>）反而会让整个应用不可用。
  }
}

/** 刷新节点列表（切换器打开、掉线重连后调）。 */
export async function refreshClusterNodes(): Promise<void> {
  if (!broker) return
  try {
    const r = await fetch('/api/broker/nodes', { cache: 'no-store' })
    if (!r.ok) return
    nodes = (await r.json())?.data || []
    emit()
  } catch { /* 保留上一批，不要闪成空 */ }
}
