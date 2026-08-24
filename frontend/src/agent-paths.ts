// 把文件路径交给 agent 的统一写法。
//
// Claude Code / Codex 都认 `@<路径>`：带上它，模型才知道这是个要去读的文件，
// 而不是句子里一串碰巧长得像路径的字。少了那个 @，agent 多半会忽略它，
// 用户看到的就是「文件传上去了但模型没理」。
//
// 之所以要有这么个小模块：上传的入口有四个（终端拖拽、终端粘贴、对话框回形针、
// 项目页需求框），从前各写各的拼接，于是 @ 加了两处、漏了两处 —— 而且漏的那两处
// 还各漏得不一样（一个插裸路径，一个只插文件名）。约定只写一遍，就不会再漏第五处。

/** 一批路径拼成可以直接塞进输入框/终端的一段文本（末尾带空格，接着打字不会粘住）。 */
export function atPaths(paths: string[]): string {
  const list = paths.map((p) => p.trim()).filter(Boolean)
  if (!list.length) return ''
  return list.map(atPath).join(' ') + ' '
}

/** 单个路径。已经带 @ 的原样返回，免得拼成 `@@/tmp/x`。 */
export function atPath(p: string): string {
  const s = p.trim()
  if (!s) return ''
  return s.startsWith('@') ? s : '@' + s
}

/** 往已有文本后面接一段：原文非空时先补一个空格，别和上一个词粘成一坨。 */
export function appendPaths(prev: string, paths: string[]): string {
  const seg = atPaths(paths)
  if (!seg) return prev
  return (prev ? prev.replace(/\s*$/, ' ') : '') + seg
}

/** 一段文本切开之后的片段：普通文字，或一条被 @ 引用的路径。 */
export type AtSegment = { kind: 'text'; text: string } | { kind: 'path'; path: string }

// 只认**绝对路径**：相对路径没有基准目录，取不出文件来，渲染成缩略图只会得到一个碎图标。
// 边界取到空白为止 —— 这与 atPaths 用空格分隔多条路径的写法是同一套约定，
// 所以带空格的文件名在这条链路上从来就表达不了（拼进去就已经分不出边界了）。
const AT_PATH = /(^|\s)@(\/\S+)/g

/**
 * 把文本按「被 @ 引用的路径」切成片段，accept 决定哪些路径值得单独拎出来。
 *
 * 不认的路径**留在文字里**，不单独成段：对话正文是给人读的句子，
 * 把每个路径都抠出来会把「看看 @a.txt 和 @b.txt 的区别」拆成三块。
 */
export function splitAtPaths(text: string, accept: (path: string) => boolean): AtSegment[] {
  if (!text) return []
  const out: AtSegment[] = []
  let last = 0
  const push = (s: string) => { if (s) out.push({ kind: 'text', text: s }) }
  AT_PATH.lastIndex = 0
  for (let m = AT_PATH.exec(text); m; m = AT_PATH.exec(text)) {
    const path = m[2]
    if (!accept(path)) continue
    // m[1] 是前导空白，它属于左边那段文字，不能吞掉 —— 吞了「看看 @x.png」会粘成「看看@x.png」
    push(text.slice(last, m.index + m[1].length))
    out.push({ kind: 'path', path })
    last = m.index + m[0].length
  }
  push(text.slice(last))
  return out
}
