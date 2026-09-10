import { describe, expect, it } from 'vitest'
import { pickFastest } from './stun-probe'

describe('STUN 优选', () => {
  const r = (url: string, ok: boolean, ms?: number) => ({ url, ok, ms })

  it('按快慢取前四台：不是只留最快那一台（它一挂就没有候选了）', () => {
    expect(pickFastest([
      r('stun:e:1', true, 200), r('stun:a:1', true, 9), r('stun:d:1', true, 150),
      r('stun:b:1', true, 25), r('stun:c:1', true, 57),
    ])).toEqual(['stun:a:1', 'stun:b:1', 'stun:c:1', 'stun:d:1'])
  })

  it('不通的一台都不要——写进列表只会让人以为配了', () => {
    expect(pickFastest([r('stun:x:1', false), r('stun:y:1', true, 30)])).toEqual(['stun:y:1'])
  })

  it('一台都不通就返回空，调用方据此不动偏好', () => {
    expect(pickFastest([r('stun:x:1', false), r('stun:y:1', false)])).toEqual([])
  })

  it('通的不足四台就有几台给几台', () => {
    expect(pickFastest([r('stun:y:1', true, 30), r('stun:z:1', true, 10)])).toEqual(['stun:z:1', 'stun:y:1'])
  })
})
