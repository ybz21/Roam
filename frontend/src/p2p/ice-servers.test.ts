import { describe, expect, it } from 'vitest'
import { STUN_PRESETS, normalizeStun, parseStunList, toIceServers } from './ice-servers'

describe('STUN 列表解析', () => {
  it('逗号、空格、换行都能分', () => {
    expect(parseStunList('stun:a:3478, stun:b:3478\nstun:c:3478')).toEqual([
      'stun:a:3478', 'stun:b:3478', 'stun:c:3478',
    ])
  })

  it('漏掉 stun: 前缀自动补上——否则浏览器整条丢掉，配了等于没配', () => {
    expect(parseStunList('a.example.com:3478')).toEqual(['stun:a.example.com:3478'])
    expect(normalizeStun('turn:x:3478')).toBe('turn:x:3478')
    expect(normalizeStun('stuns:x:5349')).toBe('stuns:x:5349')
  })

  it('去重且保序', () => {
    expect(parseStunList('stun:b:1, stun:a:1, b:1')).toEqual(['stun:b:1', 'stun:a:1'])
  })

  it('空、纯空白、连主机:端口都不是的丢掉', () => {
    expect(parseStunList('')).toEqual([])
    expect(parseStunList(undefined)).toEqual([])
    expect(parseStunList('  ,  , nonsense')).toEqual([])
  })

  it('一台一条 RTCIceServer，不挤进同一条（同条共享凭据，将来混 TURN 会连坐）', () => {
    expect(toIceServers(['stun:a:1', 'stun:b:1'])).toEqual([{ urls: 'stun:a:1' }, { urls: 'stun:b:1' }])
  })

  it('下拉预置都是规范写法', () => {
    for (const p of STUN_PRESETS) expect(normalizeStun(p.value)).toBe(p.value)
  })
})
