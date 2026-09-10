// 非 trickle 协商最小单测（P0-2）：waitForIceGathering 应在 iceGatheringState 转 'complete' 时 resolve，
// 且到达上限时间(GATHER_TIMEOUT_MS)前不 resolve；已 complete 时同步 resolve。
// 用一个最小的 fake RTCPeerConnection（EventTarget + 可变 iceGatheringState）驱动。
import { describe, it, expect, vi } from 'vitest'
import { waitForIceGathering } from './transport'

// 最小 fake：带 addEventListener/removeEventListener + 可控 iceGatheringState。
class FakePC extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'new'
  setState(s: RTCIceGatheringState) {
    this.iceGatheringState = s
    this.dispatchEvent(new Event('icegatheringstatechange'))
  }
  // 造一个候选事件：只有 type 会被读到。
  cand(type: RTCIceCandidateType | null) {
    const e = new Event('icecandidate') as Event & { candidate: { type: RTCIceCandidateType } | null }
    e.candidate = type ? { type } : null
    this.dispatchEvent(e)
  }
}

describe('waitForIceGathering (non-trickle)', () => {
  it('resolves immediately when already complete', async () => {
    const pc = new FakePC()
    pc.iceGatheringState = 'complete'
    let resolved = false
    void waitForIceGathering(pc as unknown as RTCPeerConnection).then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('resolves when gathering transitions to complete', async () => {
    vi.useFakeTimers()
    try {
      const pc = new FakePC()
      let resolved = false
      const p = waitForIceGathering(pc as unknown as RTCPeerConnection).then(() => { resolved = true })
      // 'gathering' 不该 resolve。
      pc.setState('gathering')
      await Promise.resolve()
      expect(resolved).toBe(false)
      // 转 'complete' → resolve。
      pc.setState('complete')
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to timeout when gathering never completes', async () => {
    vi.useFakeTimers()
    try {
      const pc = new FakePC()
      let resolved = false
      // 传显式上限 4s（不依赖可配默认值）。
      const p = waitForIceGathering(pc as unknown as RTCPeerConnection, 4_000).then(() => { resolved = true })
      pc.setState('gathering')
      await Promise.resolve()
      expect(resolved).toBe(false)
      // 推进到上限：即便没 complete 也要 resolve（用当前候选发出，不无限等）。
      await vi.advanceTimersByTimeAsync(4_000)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// M1：拿到反射候选就只再宽限一小会儿发 offer，别死等 gathering=complete。
// complete 的语义是「所有 STUN 都答完或超时」，实测 ~40s，而候选 0.2 秒就齐了。
describe('waitForIceGathering：srflx 宽限', () => {
  it('第一个 srflx 之后宽限到点就 resolve，不等 complete', async () => {
    vi.useFakeTimers()
    try {
      const pc = new FakePC()
      let resolved = false
      const p = waitForIceGathering(pc as unknown as RTCPeerConnection, 30_000, 500).then(() => { resolved = true })
      pc.cand('host')
      await vi.advanceTimersByTimeAsync(2000)
      expect(resolved).toBe(false) // host 不算：跨网要的是 srflx

      pc.cand('srflx')
      await vi.advanceTimersByTimeAsync(499)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('后来的 srflx 不重置宽限——否则一台慢服务器就能把它一路往后推', async () => {
    vi.useFakeTimers()
    try {
      const pc = new FakePC()
      let resolved = false
      const p = waitForIceGathering(pc as unknown as RTCPeerConnection, 30_000, 500).then(() => { resolved = true })
      pc.cand('srflx')
      await vi.advanceTimersByTimeAsync(400)
      pc.cand('srflx')
      await vi.advanceTimersByTimeAsync(100)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('一个 srflx 都没有就等满上限——那种情况无从判断它是不是马上要来', async () => {
    vi.useFakeTimers()
    try {
      const pc = new FakePC()
      let resolved = false
      const p = waitForIceGathering(pc as unknown as RTCPeerConnection, 30_000, 500).then(() => { resolved = true })
      pc.cand('host')
      await vi.advanceTimersByTimeAsync(29_999)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
