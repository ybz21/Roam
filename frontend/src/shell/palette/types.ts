import type { ReactNode } from 'react'
import type { HitKind } from '../../search'

/** 本地条目（页面导航、已打开的会话、就地能执行的命令）：数据在内存里，打字即出 */
export type PaletteItem = {
  key: string
  /** 分组标题，同组连续排列 */
  group: string
  title: string
  desc?: string
  icon?: ReactNode
  /** 参与匹配但不显示的别名（如页面的英文名） */
  keywords?: string
  run: () => void
}

/**
 * 打开结果要做的事由外面给：面板只管找，不管路由和终端怎么开。
 * 三个动作对应后端 Action 的三种 type（route / session / file），没有第四种——
 * 后端加一类可搜的东西时，它只需要挑一个已有动作，前端不用跟着改。
 */
export type PaletteActions = {
  /** hash 路由，如 `#/projects/xxx`、`#/plugins` */
  openRoute: (hash: string) => void
  openSession: (name: string) => void
  openFile: (path: string) => void
}

/** 列表里的一行——本地条目和后端结果都归一成它，面板只有一种东西可渲染 */
export type PaletteRow = {
  key: string
  kind: HitKind
  title: string
  subtitle?: string
  /** 条目自带的图标（页面用它在侧栏那一枚）；没有才退回按类别取 */
  icon?: ReactNode
  /** 右侧标签（文件的所属项目）与分组标题（本地条目的原分组名） */
  badge?: string
  positions?: number[]
  score: number
  run: () => void
}
