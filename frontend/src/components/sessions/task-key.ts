// 会话属于哪个任务：全站只有这一个函数说了算（22 设计 §3.2）。
//
// 任务 = worktree。有 worktree 路径的会话归那个 worktree；没有的（直接在项目目录里开的、
// 命令行手敲的）一律是「散会话」，每个会话自成一个任务。**不看项目目录**——主仓库不是任务位，
// 界面上也不鼓励在主仓库里开会话（所有新建入口默认新建 worktree）。
//
// 纯函数、按名字重算：会话改名不影响归属，也不需要第二份「哪些会话属于哪个任务」的列表。
export type TaskKey = string

export const LOOSE_PREFIX = 'loose:'

export function taskKeyOf(name: string, worktree?: string | null): TaskKey {
  return worktree ? worktree : LOOSE_PREFIX + name
}

export function isLooseTask(key: TaskKey | null | undefined): boolean {
  return !!key && key.startsWith(LOOSE_PREFIX)
}

/** 散会话任务对应的会话名；不是散会话返回空串 */
export function looseSessionOf(key: TaskKey): string {
  return isLooseTask(key) ? key.slice(LOOSE_PREFIX.length) : ''
}
