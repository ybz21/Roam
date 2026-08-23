export type TerminalPong = { type: 'pong'; id: string }

/** 后端懒恢复了一个被机器重启带走的会话，它现在换了个新 id。 */
export type TerminalRevived = { type: 'revived'; from: string; to: string }

// PTY 的普通输出一律是 binary frame；text frame 只承载少量控制消息。
// 仍然严格校验结构，避免未来某条文本输出刚好以 “{” 开头时被误吞。
export function parseTerminalPong(data: string): TerminalPong | null {
  if (!data.startsWith('{')) return null
  try {
    const value = JSON.parse(data) as Partial<TerminalPong>
    return value.type === 'pong' && typeof value.id === 'string'
      ? { type: 'pong', id: value.id }
      : null
  } catch {
    return null
  }
}

// 会话被重开成了新 id：标签、URL、后续的 /api/term/<名字> 都得跟着换，
// 否则下次刷新拿的还是那个已经 dead 的旧名字，又是一个打不开的空标签。
export function parseTerminalRevived(data: string): TerminalRevived | null {
  if (!data.startsWith('{')) return null
  try {
    const value = JSON.parse(data) as Partial<TerminalRevived>
    return value.type === 'revived' && typeof value.from === 'string' && typeof value.to === 'string' && value.to
      ? { type: 'revived', from: value.from, to: value.to }
      : null
  } catch {
    return null
  }
}
