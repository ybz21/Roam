// 对话页能对外发起的动作。目前只有一个「打开这个文件」——工具行里的路径要能点开。
//
// 用 context 而不是一路 prop 钻：路径出现在 ToolRow / DiffPane / FileListPane 三层里，
// 从 ChatShell 钻到最里面要穿过工具注册表，注册表就得为此改签名。
import { createContext, useContext, type ReactNode } from 'react'
import type { TaskIndex } from './tasks'

export type ChatActions = {
  /** 在文件面板打开该路径；给了 line 就跳到那一行 */
  openFile?: (path: string, line?: number) => void
  /** 整段转录归拢出的任务清单：TaskUpdate 只给 id，标题要回这里查（见 tasks.ts） */
  tasks?: TaskIndex
}

const Ctx = createContext<ChatActions>({})

export function ChatActionsProvider({ value, children }: { value: ChatActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChatActions(): ChatActions {
  return useContext(Ctx)
}
