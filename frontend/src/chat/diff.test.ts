import { describe, it, expect } from 'vitest'
import { calculateDiff, cachedDiff, parsePatch } from './diff'

describe('calculateDiff', () => {
  it('只吐真正变动的行，不整块替换', () => {
    const before = ['a', 'b', 'c', 'd'].join('\n')
    const after = ['a', 'B', 'c', 'd'].join('\n')
    expect(calculateDiff(before, after)).toEqual([
      { type: 'removed', content: 'b', lineNum: 2 },
      { type: 'added', content: 'B', lineNum: 2 },
    ])
  })

  it('纯插入不会把后续行也算成变动', () => {
    const before = ['a', 'b'].join('\n')
    const after = ['a', 'x', 'b'].join('\n')
    expect(calculateDiff(before, after)).toEqual([{ type: 'added', content: 'x', lineNum: 2 }])
  })

  it('纯删除同理', () => {
    const before = ['a', 'x', 'b'].join('\n')
    const after = ['a', 'b'].join('\n')
    expect(calculateDiff(before, after)).toEqual([{ type: 'removed', content: 'x', lineNum: 2 }])
  })

  it('内容相同则没有变动行', () => {
    expect(calculateDiff('same\ntext', 'same\ntext')).toEqual([])
  })

  it('新建文件（旧文本为空）整篇算新增', () => {
    const d = calculateDiff('', 'x\ny')
    expect(d.every((l) => l.type === 'added')).toBe(true)
    expect(d).toHaveLength(2)
  })

  it('超大文本降级成整块替换，不跑 O(n·m) DP', () => {
    // 1001 × 1001 > 100 万格上限
    const before = Array.from({ length: 1001 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 1001 }, (_, i) => `new ${i}`).join('\n')
    const t0 = Date.now()
    const d = calculateDiff(before, after)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(d).toHaveLength(2002)
    expect(d[0].type).toBe('removed')
    expect(d[d.length - 1].type).toBe('added')
  })

  it('缓存命中不改变结果', () => {
    const a = 'p\nq'
    const b = 'p\nQ'
    expect(cachedDiff(a, b)).toEqual(calculateDiff(a, b))
    expect(cachedDiff(a, b)).toEqual(calculateDiff(a, b))
  })
})

describe('parsePatch', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/session/mod.rs',
    '@@ fn attach()',
    '-    let size = term.size().unwrap();',
    '+    let size = term.size().unwrap_or(DEFAULT_SIZE);',
    '*** Add File: src/new.rs',
    '+pub fn hello() {}',
    '*** End Patch',
  ].join('\n')

  it('按 *** X File: 切成每文件一段', () => {
    const files = parsePatch(patch)
    expect(files.map((f) => [f.op, f.path])).toEqual([
      ['update', 'src/session/mod.rs'],
      ['add', 'src/new.rs'],
    ])
  })

  it('段内保留原始行，Begin/End 标记不混进去', () => {
    const [first, second] = parsePatch(patch)
    expect(first.lines).toEqual([
      '@@ fn attach()',
      '-    let size = term.size().unwrap();',
      '+    let size = term.size().unwrap_or(DEFAULT_SIZE);',
    ])
    expect(second.lines).toEqual(['+pub fn hello() {}'])
    expect(patch).toContain('*** Begin Patch')
    expect(first.lines.join('\n')).not.toContain('Begin Patch')
  })

  it('不是补丁格式时返回空数组（调用方回退成整段着色）', () => {
    expect(parsePatch('just some text')).toEqual([])
  })
})
