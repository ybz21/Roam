import { describe, expect, it } from 'vitest'
import { parseTerminalPong } from './terminal-lifecycle'

describe('parseTerminalPong', () => {
  it('accepts a matching terminal heartbeat response', () => {
    expect(parseTerminalPong('{"type":"pong","id":"resume-7"}')).toEqual({ type: 'pong', id: 'resume-7' })
  })

  it('does not consume terminal text or unrelated JSON controls', () => {
    expect(parseTerminalPong('shell output')).toBeNull()
    expect(parseTerminalPong('{"type":"resize","cols":120}')).toBeNull()
    expect(parseTerminalPong('{not-json')).toBeNull()
  })
})
