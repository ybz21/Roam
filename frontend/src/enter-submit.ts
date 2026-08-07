// 「回车＝提交」的唯一写法。
//
// 中文输入法里那记回车是**上屏候选词**，不是提交：浏览器照样派一个 keydown 过来，
// 直接当提交处理就会把还没上屏的半截当成全部——对话框发出去缺字的一句、新建文件夹
// 建出个半拉名字。而且提交后清空的是 React 态，浏览器随后把组合前的值写回 DOM，
// 上一段内容看着像"自己又冒回来了"。
//
// `isComposing` 是标准写法，`keyCode === 229` 是 Chrome 组合态的老写法，两条一起判。
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** 这记回车是输入法在上屏，不是用户要提交 */
export function composingEnter(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const ne = 'nativeEvent' in e ? (e.nativeEvent as KeyboardEvent) : e
  return !!ne.isComposing || ne.keyCode === 229
}

/** 包一层「回车提交」处理器：组合中的回车放行给输入法，其余才提交 */
export function onEnterSubmit<T extends Element>(submit: () => void) {
  return (e: ReactKeyboardEvent<T>) => {
    if (composingEnter(e)) return
    submit()
  }
}
