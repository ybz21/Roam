// 中心健康判据的回归用例。
//
// 这些数字**不是编的**：涨的那组是 2026-08-11 事故当天 health.log 里的原值
// （09:35–10:20，goroutine 1518 → 18298，RSS 38MB → 294MB），稳的那组是同一天修复后
// 11:00–11:15 的原值（含一次 18 → 50 → 18 的正常尖峰）。
//
// 判据必须同时满足两件事，否则这个红点没有价值：
//   ① 今早那条曲线要报（不然装它干嘛）
//   ② 正常波动和一次性尖峰**绝不能报**——误报一次，以后就没人信了
import { describe, it, expect } from 'vitest'
import { assessHub, type HubSample } from './hub-health'

function mk(goroutines: number[], rss: number[] = []): HubSample[] {
  return goroutines.map((g, i) => ({
    at: 1786000000 + i * 300,
    goroutines: g,
    rss: (rss[i] ?? 22000) * 1024,
    heap: 2_500_000, tunnels: 2, requests: i * 10,
  }))
}

describe('中心健康判据', () => {
  it('今早那条泄漏曲线要报 bad', () => {
    // 真实值：09:35 起每 5 分钟一采
    const h = assessHub(mk([1518, 1518, 1518, 2667, 7126, 12060, 13312, 15164, 18298]))
    expect(h.level).toBe('bad')
    expect(h.reasons).toContain('goroutineClimb')
  })

  it('内存跟着爬也要报', () => {
    const h = assessHub(mk([20, 20, 20, 20, 20, 20, 20], [38484, 38484, 64280, 148432, 229348, 243168, 294524]))
    expect(h.reasons).toContain('memClimb')
  })

  it('正常波动不报（含一次 18 → 50 → 18 的尖峰）', () => {
    // 真实值：修复后 11:00–11:15，50 那一下是我打压测打出来的
    const h = assessHub(mk([18, 18, 18, 50, 18, 21, 18, 20, 21]))
    expect(h.level).toBe('ok')
    expect(h.reasons).toEqual([])
  })

  it('单调但没翻倍不报——从 18 挪到 21 不是泄漏', () => {
    expect(assessHub(mk([18, 18, 19, 19, 20, 20, 21])).level).toBe('ok')
  })

  it('翻倍但不单调不报——一次尖峰不是趋势', () => {
    expect(assessHub(mk([20, 20, 200, 20, 20, 20, 20])).level).toBe('ok')
  })

  it('采样点不够时不报：中心刚重启就是这个状态，不能一起来就红', () => {
    expect(assessHub(mk([100, 400, 900])).level).toBe('ok')
  })

  it('没有样本也不报，不能因为「不知道」就喊', () => {
    expect(assessHub([]).level).toBe('ok')
  })

  it('有机器掉线是 warn，不是 bad——它可能只是那台关机了', () => {
    const h = assessHub(mk([18, 18, 18, 18, 18, 18, 18]), 1)
    expect(h.level).toBe('warn')
    expect(h.reasons).toEqual(['nodeOffline'])
  })

  it('泄漏压过掉线：曲线在爬时先说曲线，那个更要命', () => {
    const h = assessHub(mk([1518, 2667, 7126, 12060, 13312, 15164, 18298]), 1)
    expect(h.level).toBe('bad')
    expect(h.reasons).toContain('goroutineClimb')
  })
})
