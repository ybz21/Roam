import { describe, expect, it } from 'vitest'
import {
  estimateWidth, formatValue, humanBytes, pickCells, rawSeverity, trackSustain,
  type Cell, type CellSpec, type Severity,
} from './status-cells'

const spec = (over: Partial<CellSpec> & { id: string }): CellSpec => ({
  provider: 'roam.core', kind: 'system', label: '', align: 'left',
  priority: 50, tier: 3, render: 'text', ...over,
})

const cell = (over: Partial<Cell> & { id: string }): Cell => ({
  ...spec(over as Partial<CellSpec> & { id: string }),
  val: {}, severity: 'ok', width: 100, ...over,
})

describe('阈值判等级', () => {
  const thr = { warn: 80, danger: 92 }
  it('按档位升级', () => {
    expect(rawSeverity(50, thr)).toBe('ok')
    expect(rawSeverity(80, thr)).toBe('warn')
    expect(rawSeverity(95, thr)).toBe('danger')
  })
  it('没有阈值声明就永远是 ok —— 插件不能自己说自己是红的', () => {
    expect(rawSeverity(999, undefined)).toBe('ok')
  })
  it('取不到值不算越线', () => {
    expect(rawSeverity(undefined, thr)).toBe('ok')
    expect(rawSeverity(NaN, thr)).toBe('ok')
  })
  it('invert：值越小越糟（剩余空间那类）', () => {
    expect(rawSeverity(3, { warn: 10, danger: 2, invert: true })).toBe('warn')
    expect(rawSeverity(1, { warn: 10, danger: 2, invert: true })).toBe('danger')
    expect(rawSeverity(50, { warn: 10, danger: 2, invert: true })).toBe('ok')
  })
})

describe('CPU 那条 60s 滞后', () => {
  it('刚越线不上色 —— 每次编译都黄一下，两天后没人再看这条', () => {
    let s = trackSustain(undefined, 'warn', 0, 60)
    expect(s.shown).toBe('ok')
    s = trackSustain(s, 'warn', 30_000, 60)
    expect(s.shown).toBe('ok')
  })
  it('熬满 60s 才升级', () => {
    let s = trackSustain(undefined, 'warn', 0, 60)
    s = trackSustain(s, 'warn', 60_000, 60)
    expect(s.shown).toBe('warn')
  })
  it('中途掉回 ok 就重新计时，不许攒时长', () => {
    let s = trackSustain(undefined, 'warn', 0, 60)
    s = trackSustain(s, 'ok', 50_000, 60)
    expect(s.shown).toBe('ok')
    s = trackSustain(s, 'warn', 51_000, 60)
    s = trackSustain(s, 'warn', 100_000, 60) // 距新起点才 49s
    expect(s.shown).toBe('ok')
    s = trackSustain(s, 'warn', 111_000, 60)
    expect(s.shown).toBe('warn')
  })
  it('降级立刻生效 —— 已经不烧了就别再红着', () => {
    let s: ReturnType<typeof trackSustain> | undefined
    s = trackSustain(s, 'danger', 0, 0)
    expect(s.shown).toBe('danger')
    s = trackSustain(s, 'ok', 1, 60)
    expect(s.shown).toBe('ok')
  })
  it('sustainSec=0 时立刻升级（内存、磁盘本来就是慢变量）', () => {
    const s = trackSustain(undefined, 'danger', 0, 0)
    expect(s.shown).toBe('danger')
  })
})

describe('格式化', () => {
  it('按单位出文案', () => {
    expect(formatValue({ value: 34.2 }, 'percent')).toBe('34%')
    expect(formatValue({ value: 61.7 }, 'celsius')).toBe('62°C')
    expect(formatValue({ value: 2202009 }, 'bytesPerSec')).toBe('2.1M/s')
  })
  it('插件给了 text 就用它，不再格式化', () => {
    expect(formatValue({ value: 34, text: '12.1/32G' }, 'percent')).toBe('12.1/32G')
  })
  it('过期或没值都是 --，不是 0', () => {
    // 一个停在 34% 的假数字比空白危险得多 —— 它看起来像「一切正常」
    expect(formatValue({ value: 34, stale: true }, 'percent')).toBe('--')
    expect(formatValue({}, 'percent')).toBe('--')
  })
  it('humanBytes 进位', () => {
    expect(humanBytes(1024)).toBe('1K')
    expect(humanBytes(1536)).toBe('1.5K')
    expect(humanBytes(34359738368)).toBe('32G')
  })
})

describe('估宽', () => {
  it('中日韩字按两倍宽算', () => {
    const zh = estimateWidth(spec({ id: 'a', label: '内存' }), '12.1/32G')
    const en = estimateWidth(spec({ id: 'a', label: 'ab' }), '12.1/32G')
    expect(zh).toBeGreaterThan(en)
  })
  it('gauge 比 text 宽（多一条迷你条）', () => {
    expect(estimateWidth(spec({ id: 'a', render: 'gauge' }), '34%'))
      .toBeGreaterThan(estimateWidth(spec({ id: 'a', render: 'text' }), '34%'))
  })
})

describe('窄窗折叠', () => {
  const bar = (): Cell[] => [
    cell({ id: 'core/machine', tier: 1, priority: 100, width: 120 }),
    cell({ id: 'git/branch', tier: 3, priority: 80, width: 140 }),
    cell({ id: 'hm/cpu', tier: 2, priority: 60, width: 100 }),
    cell({ id: 'hm/disk', tier: 3, priority: 50, width: 80 }),
    cell({ id: 'hm/net', tier: 4, priority: 35, width: 120 }),
    cell({ id: 'core/version', tier: 4, priority: 10, align: 'right', width: 70 }),
    cell({ id: 'editor/lang', tier: 4, priority: 60, align: 'right', width: 90 }),
  ]
  const ids = (cs: Cell[]) => cs.map((c) => c.id)

  it('够宽时一格不丢', () => {
    expect(pickCells(bar(), 2000)).toHaveLength(7)
  })
  it('先丢档 4，且右半先于左半', () => {
    const kept = ids(pickCells(bar(), 620))
    expect(kept).not.toContain('editor/lang')
    expect(kept).not.toContain('core/version')
    expect(kept).toContain('hm/net') // 同为档 4，但它在左半，比右半晚丢
  })
  it('档 1 在任何宽度下都在', () => {
    expect(ids(pickCells(bar(), 10))).toContain('core/machine')
  })
  it('告警格跳过丢弃顺序，被钉住', () => {
    const cs = bar().map((c) => (c.id === 'hm/net' ? { ...c, severity: 'danger' as Severity } : c))
    const kept = ids(pickCells(cs, 300))
    // net 本来是最先丢的档 4，红了就留下
    expect(kept).toContain('hm/net')
    expect(kept).not.toContain('git/branch')
  })
  it('挤不下时告警格提到机器格右边', () => {
    const cs = bar().map((c) => (c.id === 'hm/disk' ? { ...c, severity: 'danger' as Severity } : c))
    const kept = ids(pickCells(cs, 300))
    expect(kept[0]).toBe('core/machine')
    expect(kept[1]).toBe('hm/disk')
  })
  it('宽屏里不挪位 —— 挪位会让格子在眼皮底下跑', () => {
    const cs = bar().map((c) => (c.id === 'hm/disk' ? { ...c, severity: 'danger' as Severity } : c))
    expect(ids(pickCells(cs, 2000))[1]).toBe('git/branch')
  })
  it('同 priority 按 id 字典序，装插件的顺序不影响排布', () => {
    const a = cell({ id: 'zzz/x', priority: 50, width: 50 })
    const b = cell({ id: 'aaa/x', priority: 50, width: 50 })
    expect(ids(pickCells([a, b], 2000))).toEqual(['aaa/x', 'zzz/x'])
    expect(ids(pickCells([b, a], 2000))).toEqual(['aaa/x', 'zzz/x'])
  })
  it('左半永远排在右半前面', () => {
    const kept = ids(pickCells(bar(), 2000))
    expect(kept.indexOf('core/version')).toBeGreaterThan(kept.indexOf('hm/net'))
  })
  it('宽度单调变化时不抖：只要更宽，留下的就是超集', () => {
    // 量→删→变宽→加回来会在临界宽度上抖成无限循环，所以估宽必须是纯函数
    let prev = new Set<string>()
    for (let w = 100; w <= 1000; w += 20) {
      const now = new Set(ids(pickCells(bar(), w)))
      for (const id of prev) expect(now.has(id)).toBe(true)
      prev = now
    }
  })
})

describe('估宽宁可估大', () => {
  // 估小了那一格会被 overflow:hidden 裁掉半个字；估大只是早丢一格。
  // 这几组是 1440 桌面上真机量出来的实测宽度（见 PR 里的验收记录）。
  const measured: [Partial<CellSpec>, string, number][] = [
    [{ render: 'dot', label: '当前设备' }, '在线', 109],
    [{ render: 'gauge', label: 'CPU' }, '16%', 109],
    [{ render: 'gauge', label: '内存' }, '42%', 108],
    [{ render: 'text', label: '磁盘' }, '69%', 72],
    [{ render: 'text', label: '温度' }, '59°C', 75],
    [{ render: 'gauge', label: 'GPU' }, '0%', 103],
    [{ render: 'text', label: '网络' }, '38.5K/s', 89],
  ]
  it.each(measured)('%o %s 的估值不小于实测 %ipx', (over, text, real) => {
    expect(estimateWidth(spec({ id: 'x', ...over }), text)).toBeGreaterThanOrEqual(real)
  })
})

describe('版本号只留标签那一截', () => {
  it('剥掉 git describe 的提交计数与哈希', async () => {
    const { shortVersion } = await import('./status-system')
    // 完整串 189px，比机器格还宽，而那截哈希在状态条上一眼读不出意思
    expect(shortVersion('0.1.0-rc.2-291-gb6624ee-dirty')).toBe('v0.1.0-rc.2')
    expect(shortVersion('v1.2.3-4-gabc1234')).toBe('v1.2.3')
    expect(shortVersion('1.2.3-dirty')).toBe('v1.2.3')
  })
  it('干净的版本号原样留着', () => {
    return import('./status-system').then(({ shortVersion }) => {
      expect(shortVersion('0.4.1-go')).toBe('v0.4.1-go')
      expect(shortVersion('v2.0.0')).toBe('v2.0.0')
    })
  })
})
