export type TerminalPong = { type: 'pong'; id: string }

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
