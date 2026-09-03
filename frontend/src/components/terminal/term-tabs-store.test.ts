// @vitest-environment jsdom
// 按机器记标签 + 还原时滤掉死 token。
//
// 后者是 #190 那个 bug 的护栏：URL 里带着上一台机器的会话 id 切过去，会在新机器上
// 还原出一堆打不开的空标签。那次是靠「切之前清空」躲掉的，代价是切回来也没了；
// 现在按机器各记各的，就必须在还原这一步真的把查无此会话的 id 拦下来。
import { describe, it, expect, beforeEach } from 'vitest'
import { saveTabs, loadTabs, dropDeadTokens } from './term-tabs-store'

describe('按机器记终端标签', () => {
  beforeEach(() => localStorage.clear())

  it('两台机器各记各的，互不覆盖', () => {
    saveTabs('node-a', ['2026-0808-0859-002v'], '2026-0808-0859-002v')
    saveTabs('node-b', ['2026-0101-1200-aaaa', '2026-0101-1200-bbbb'], '2026-0101-1200-bbbb')
    expect(loadTabs('node-a').terms).toEqual(['2026-0808-0859-002v'])
    expect(loadTabs('node-b').terms).toHaveLength(2)
    expect(loadTabs('node-b').active).toBe('2026-0101-1200-bbbb')
  })

  it('单机（没有 nodeId）也占一格，不和别人串', () => {
    saveTabs(null, ['x'], 'x')
    saveTabs('node-a', ['y'], 'y')
    expect(loadTabs(null).terms).toEqual(['x'])
    expect(loadTabs('node-a').terms).toEqual(['y'])
  })

  it('没记过的机器返回空，不返回别人的', () => {
    saveTabs('node-a', ['x'], 'x')
    expect(loadTabs('node-zzz')).toEqual({ terms: [], active: '', task: '' })
  })

  it('最多记 8 台，按最后使用淘汰', () => {
    for (let i = 0; i < 12; i++) saveTabs('node-' + i, ['t' + i], 't' + i)
    const kept = Array.from({ length: 12 }, (_, i) => loadTabs('node-' + i).terms.length).filter(Boolean).length
    expect(kept).toBe(8)
    expect(loadTabs('node-11').terms).toEqual(['t11']) // 最近的一定在
    expect(loadTabs('node-0').terms).toEqual([])       // 最早的被挤掉
  })

  it('localStorage 里是垃圾时按空处理，不抛', () => {
    localStorage.setItem('roam.terms', '{{{')
    expect(loadTabs('node-a')).toEqual({ terms: [], active: '', task: '' })
  })
})

// 这条是真机上撞出来的：从书签打开裸域名（URL 上没有 terms=）时，如果不回落到本机记的
// 那份，还原就是空的，紧接着这个空集会被写回 store，把上次开着的一笔勾销——跨机保留于是
// 「只在带参数的链接里有效」，等于没有。App.tsx 的还原副作用负责回落，这里钉住 store 侧的契约：
// 存过就必须读得回来，读回来的顺序也不能乱。
describe('URL 没写标签时靠 store 兜底', () => {
  beforeEach(() => localStorage.clear())

  it('存过的原样读回来，顺序不乱', () => {
    const terms = ['2026-0101-1200-aaaa', '2026-0101-1200-bbbb', '2026-0101-1200-cccc']
    saveTabs('node-a', terms, '2026-0101-1200-bbbb')
    const back = loadTabs('node-a')
    expect(back.terms).toEqual(terms)
    expect(back.active).toBe('2026-0101-1200-bbbb')
  })

  it('用户关光了标签就是空——不该被「兜底」复活', () => {
    saveTabs('node-a', ['2026-0101-1200-aaaa'], '2026-0101-1200-aaaa')
    saveTabs('node-a', [], '')
    expect(loadTabs('node-a').terms).toEqual([])
  })
})

describe('还原前滤掉死 token', () => {
  const known = { '2026-0808-0859-002v': 'roam-sh' }

  it('这台机器上查无此会话的 id 丢掉', () => {
    expect(dropDeadTokens(['2026-0808-0859-002v', '2026-0101-1200-dead'], known))
      .toEqual(['2026-0808-0859-002v'])
  })

  it('不像 id 的 token 是老链接里的会话名，照旧放行', () => {
    // 那时 URL 里写的是名字；名字查不到可能只是列表还没刷到，不能当死标签丢
    expect(dropDeadTokens(['roam-sh', 'dev'], known)).toEqual(['roam-sh', 'dev'])
  })

  it('全都查无此会话时还原出空，而不是一排空标签', () => {
    expect(dropDeadTokens(['2026-0101-1200-dead', '2026-0101-1200-gone'], known)).toEqual([])
  })
})

describe('当前任务跟着标签一起记（22 设计）', () => {
  beforeEach(() => localStorage.clear())

  it('存了就能读回来，切机器各记各的', () => {
    saveTabs('a', ['x'], 'x', '/w/.worktrees/a')
    saveTabs('b', ['y'], 'y', 'loose:y')
    expect(loadTabs('a').task).toBe('/w/.worktrees/a')
    expect(loadTabs('b').task).toBe('loose:y')
  })

  it('老数据没有 task 字段：照常读，任务是空串', () => {
    localStorage.setItem('roam.terms', JSON.stringify({ '': { terms: ['x'], active: 'x', at: 1 } }))
    expect(loadTabs(null)).toEqual({ terms: ['x'], active: 'x', task: '' })
  })
})
