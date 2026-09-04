// `_ttmux-` 命名空间 = 基础设施会话，不是人开的活。
//
// 插件守护进程（_ttmux-plugind）、IM 监听（_ttmux-im）这些跑在真实 tmux 会话里，
// 于是 /sessions 会照实列出来，侧栏的项目树里就冒出一条「_ttmux-plugind」挂在某个任务下面
// ——它既不属于那个任务，人也不该点进去。CLI 早就按这个前缀过滤了（internal/app/app.go），
// Web 这边一直没有。
//
// 判据放在前端而不是后端：后端那份列表还要用来做会话归属和状态统计，
// 一刀切藏掉会把「蜂群会话不进 ls 导致项目编队恒 0」那类问题再演一遍。
export function isInfraSession(name: string): boolean {
  return name.startsWith('_ttmux-')
}
