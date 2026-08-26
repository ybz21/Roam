import { describe, expect, it } from 'vitest'
import {
  MAX_ITEMS_BUILTIN, MAX_ITEMS_PLUGIN, MIN_REFRESH_MS, SYSTEM_BASE,
  groupRefreshMs, groupSources, pluginCells, readPath, systemCell,
  type PluginRecord, type StatusItemContrib,
} from './status-registry'
import { pickCells, type Cell, type CellSpec } from './status-cells'

const item = (over: Partial<StatusItemContrib> & { id: string }): StatusItemContrib => ({
  title: { 'zh-CN': 'CPU' },
  source: { command: 'x.stats', refresh: 3, path: 'cpu.usagePercent' },
  ...over,
})

const plug = (
  id: string,
  items: StatusItemContrib[],
  over: Partial<PluginRecord> & { kind?: string } = {},
): PluginRecord => ({
  manifest: { id, runtime: { kind: over.kind ?? 'exec' }, contributes: { statusItems: items } },
  enabled: over.enabled ?? true,
})

describe('插件注册进来的格', () => {
  it('摊平成 CellSpec，全局 id 带插件前缀', () => {
    const { specs } = pluginCells([plug('acme.ci', [item({ id: 'build' })])], 'zh-CN')
    expect(specs).toHaveLength(1)
    expect(specs[0].id).toBe('acme.ci/build')
    expect(specs[0].kind).toBe('plugin')
    expect(specs[0].provider).toBe('acme.ci')
  })

  it('停用的插件一格都不给', () => {
    const { specs } = pluginCells([plug('acme.ci', [item({ id: 'build' })], { enabled: false })], 'zh-CN')
    expect(specs).toHaveLength(0)
  })

  it('第三方 2 格封顶，builtin 6 格 —— 超出的截断，不是整条拒绝', () => {
    const many = Array.from({ length: 8 }, (_, i) => item({ id: 'i' + i }))
    expect(pluginCells([plug('acme.ci', many)], 'zh-CN').specs).toHaveLength(MAX_ITEMS_PLUGIN)
    expect(pluginCells([plug('roam.hm', many, { kind: 'builtin' })], 'zh-CN').specs)
      .toHaveLength(MAX_ITEMS_BUILTIN)
  })

  it('refresh 不许低于地板 —— plugin run 每次起一个子进程', () => {
    const { sources } = pluginCells([plug('a.b', [item({ id: 'x', source: { command: 'x.s', refresh: 1, path: 'p' } })])], 'zh-CN')
    expect(sources[0].refreshMs).toBe(MIN_REFRESH_MS)
  })

  it('白名单之外的 onClick 丢掉 —— 插件给不了任意跳转', () => {
    const { specs } = pluginCells([plug('a.b', [
      item({ id: 'x', onClick: { kind: 'eval', id: 'alert(1)' } }),
    ])], 'zh-CN')
    expect(specs[0].onClick).toBeUndefined()
  })

  it('没声明阈值就没有阈值 —— 插件不能自己说自己是红的', () => {
    const { specs } = pluginCells([plug('a.b', [item({ id: 'x' })])], 'zh-CN')
    expect(specs[0].thresholds).toBeUndefined()
  })

  it('不认识的 render 退回 text，不报错', () => {
    const { specs } = pluginCells([plug('a.b', [item({ id: 'x', render: 'canvas' as any })])], 'zh-CN')
    expect(specs[0].render).toBe('text')
  })

  it('push 型不进拉取清单', () => {
    const { sources } = pluginCells([plug('a.b', [item({ id: 'x', source: { push: true } })])], 'zh-CN')
    expect(sources).toHaveLength(0)
  })
})

describe('插件抢不到系统格的位置', () => {
  const cell = (s: CellSpec): Cell => ({ ...s, val: {}, severity: 'ok', width: 60 })

  it('左半：插件声明再大的 priority 也排在系统格之后', () => {
    const sys = systemCell('roam.core', 'machine', { priority: 100, tier: 1 })
    const { specs } = pluginCells([plug('a.b', [item({ id: 'x', priority: 999999 })])], 'zh-CN')
    const order = pickCells([cell(specs[0]), cell(sys)], 9999).map((c) => c.id)
    expect(order[0]).toBe('roam.core/machine')
  })

  it('右半：插件排在系统格之前（right-head）', () => {
    const sys = systemCell('roam.core', 'version', { align: 'right', priority: 0 })
    const { specs } = pluginCells([plug('a.b', [item({ id: 'x', align: 'right', priority: 1 })])], 'zh-CN')
    const order = pickCells([cell(sys), cell(specs[0])], 9999).map((c) => c.id)
    expect(order[0]).toBe('a.b/x')
  })

  it('系统格的 priority 一律在底座之上', () => {
    expect(systemCell('roam.core', 'x', { priority: 0 }).priority).toBeGreaterThanOrEqual(SYSTEM_BASE)
  })
})

describe('取值路径', () => {
  const snap = { cpu: { usagePercent: 34.2 }, disks: [{ usagePercent: 62.9 }], gpus: [] as any[] }
  it('点分与下标', () => {
    expect(readPath(snap, 'cpu.usagePercent')).toBe(34.2)
    expect(readPath(snap, 'disks[0].usagePercent')).toBe(62.9)
  })
  it('取不到就是 undefined —— 整格不渲染，不回 0', () => {
    expect(readPath(snap, 'gpus[0].utilPercent')).toBeUndefined()
    expect(readPath(snap, 'nope.deep.deeper')).toBeUndefined()
    expect(readPath(snap, 'cpu.usagePercent.more')).toBeUndefined()
  })
})

describe('合并调用', () => {
  it('同插件同命令的多格合成一次 —— 主机六格共用一次 stats', () => {
    const items = ['cpu', 'mem', 'disk'].map((id) => item({ id }))
    const { sources } = pluginCells([plug('roam.hm', items, { kind: 'builtin' })], 'zh-CN')
    const groups = groupSources(sources)
    expect(groups.size).toBe(1)
    expect([...groups.values()][0]).toHaveLength(3)
  })

  it('不同命令分开', () => {
    const { sources } = pluginCells([plug('roam.hm', [
      item({ id: 'a', source: { command: 'hm.one', path: 'p' } }),
      item({ id: 'b', source: { command: 'hm.two', path: 'p' } }),
    ], { kind: 'builtin' })], 'zh-CN')
    expect(groupSources(sources).size).toBe(2)
  })

  it('一组的间隔取组内最小', () => {
    const { sources } = pluginCells([plug('roam.hm', [
      item({ id: 'a', source: { command: 'hm.s', refresh: 10, path: 'p' } }),
      item({ id: 'b', source: { command: 'hm.s', refresh: 3, path: 'p' } }),
    ], { kind: 'builtin' })], 'zh-CN')
    expect(groupRefreshMs([...groupSources(sources).values()][0])).toBe(3000)
  })
})

describe('快照 → 各格的值', () => {
  const group = [
    { cellId: 'hm/cpu', pluginId: 'roam.hm', command: 'hm.s', refreshMs: 3000, path: 'cpu.usagePercent' },
    { cellId: 'hm/gpu', pluginId: 'roam.hm', command: 'hm.s', refreshMs: 3000, path: 'gpus[0].utilPercent' },
  ]
  it('取得到给值，取不到标 missing —— 那一格整格不渲染', async () => {
    const { extract } = await import('./status-poll')
    const v = extract(group, { cpu: { usagePercent: 34.2 }, gpus: [] })
    expect(v['hm/cpu'].value).toBe(34.2)
    expect(v['hm/gpu'].missing).toBe(true)
  })
  it('0 是真值，不是 missing', async () => {
    const { extract } = await import('./status-poll')
    expect(extract(group, { cpu: { usagePercent: 0 }, gpus: [] })['hm/cpu']).toEqual({ value: 0, text: undefined })
  })
})

describe('已用/总量（bytesRatio）', () => {
  const group = [{
    cellId: 'hm/mem', pluginId: 'roam.hm', command: 'hm.s', refreshMs: 3000,
    path: 'memory.used', totalPath: 'memory.total', unit: 'bytesRatio' as const,
  }]
  it('画成「12.1/32G」，迷你条和阈值走比例', async () => {
    const { extract } = await import('./status-poll')
    const v = extract(group, { memory: { used: 12988366848, total: 34359738368 } })['hm/mem']
    expect(v.text).toBe('12.1/32G') // 同量级时前一半不重复写单位
    expect(Math.round(v.pct!)).toBe(38)
  })
  it('总量取不到就退回原样的数字，不编一个比例出来', async () => {
    const { extract } = await import('./status-poll')
    const v = extract(group, { memory: { used: 12988366848 } })['hm/mem']
    expect(v.pct).toBeUndefined()
  })
})

describe('数值预留宽度', () => {
  it('每个带单位的格都留够最长值的位置 —— 否则位数一变整条平移', async () => {
    const { UNIT_CH, estimateWidth } = await import('./status-cells')
    // 8% 和 100% 必须估出同样的宽度，条才不会每 3 秒抖一次
    const spec = { provider: 'p', kind: 'plugin' as const, label: 'CPU', align: 'left' as const,
      priority: 0, tier: 3 as const, render: 'gauge' as const, unit: 'percent' as const, id: 'x' }
    expect(estimateWidth(spec, '8%')).toBe(estimateWidth(spec, '100%'))
    expect(UNIT_CH.percent).toBe(4)
  })
})
