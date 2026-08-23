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
