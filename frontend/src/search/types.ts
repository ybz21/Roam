// 搜索结果的公共类型。前后端同一套形状：后端 /search 直接返回这些字段
// （见 backend/api/search.go 的 searchHit），本地条目在 rank.ts 里补成同一形状，
// 面板拿到的就只有一种东西可渲染。
// 已知类别。**这是开放集合**：后端加一个数据源（search_sources.go）就会多一种 kind，
// 前端只要给它一枚图标和一个分组名即可，匹配、排序、打开都不用改。
export type HitKind = 'page' | 'command' | 'project' | 'session' | 'file' | 'content' | 'plugin' | 'swarm' | (string & {})

/** 点开一条结果要做的事。前端只认这三种动作，不认它背后是项目还是插件。 */
export type HitAction = {
  type: 'route' | 'session' | 'file' | (string & {})
  /** route → hash 路由；session → 会话名；file → 绝对路径 */
  target: string
}

export type SearchHit = {
  kind: HitKind
  /** 同类里唯一：页面 key / 项目 key / 会话名 / 文件绝对路径 */
  id: string
  title: string
  subtitle?: string
  path?: string
  project?: string
  projectKey?: string
  action?: HitAction
  score: number
  /** 命中字符在 title 上的下标，用于高亮 */
  positions?: number[]
  attached?: boolean
  /** 内容搜索：命中行号 */
  line?: number
}

export type SearchResponse = {
  hits: SearchHit[]
  truncated: boolean
  /** 有项目的文件索引还在后台建：这一批文件结果可能不全，UI 要说一句 */
  indexing?: boolean
  tookMs: number
}
