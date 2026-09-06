// GET /git/branches 的本地分支条目：名字之外还带着挑选时要看的两件事——
// 多久没动过（at），以及有没有被某个 worktree（含主仓库）占着（worktree）。
// 被占着的分支开不了新工作区：git 不许一条分支同时检出两次。
export type LocalBranch = { name: string; at?: number; worktree?: string }

/** 只要名字的调用方（「基于」选择器之类）用它拍平。 */
export const branchNames = (list: LocalBranch[] | undefined | null): string[] => (list || []).map((b) => b.name)
