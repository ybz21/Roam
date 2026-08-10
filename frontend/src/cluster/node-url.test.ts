// @vitest-environment jsdom
// 单机与多机走同一份代码：没有 currentNodeId 时 nodePath() 必须返回**今天的路径**，
// 一个字节都不差。这条恒等式就是「没连中心 就零变化」的全部保证——它一破，
// 单机用户的每个请求都会多一段前缀。
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function fresh() {
  vi.resetModules()
  return await import('./node-url')
}

describe('机器 URL 前缀', () => {
  beforeEach(() => { localStorage.clear() })

  it('单机：裸路径原样返回', async () => {
    const m = await fresh()
    expect(m.currentNodeId()).toBe(null)
    expect(m.nodePath('/api/sessions')).toBe('/api/sessions')
    expect(m.nodeApi('/sessions')).toBe('/api/sessions')
    expect(m.nodeApi('/file/raw?path=%2Fa%20b')).toBe('/api/file/raw?path=%2Fa%20b')
  })

  it('多机：加 /n/<id> 前缀，id 逐段 percent-encode', async () => {
    const m = await fresh()
    m.setCurrentNode('n_01')
    expect(m.nodeApi('/sessions')).toBe('/n/n_01/api/sessions')
    m.setCurrentNode('n/需要编码')
    expect(m.nodeApi('/x')).toBe('/n/n%2F%E9%9C%80%E8%A6%81%E7%BC%96%E7%A0%81/api/x')
  })

  it('当前机器落 localStorage：首帧就能定，不等偏好接口', async () => {
    const m = await fresh()
    m.setCurrentNode('n_42')
    expect(localStorage.getItem('roam.nodeId')).toBe('n_42')
    const m2 = await fresh() // 模拟刷新
    expect(m2.currentNodeId()).toBe('n_42')
  })

  it('bootstrap 打不通就按单机处理，绝不把请求发去 /n/<不存在>', async () => {
    const m = await fresh()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await m.bootstrapCluster()
    expect(m.isHubMode()).toBe(false)
    expect(m.nodeApi('/sessions')).toBe('/api/sessions')
    vi.unstubAllGlobals()
  })

  it('bootstrap 选节点：本地镜像优先于中心推荐，且必须仍在线', async () => {
    const m = await fresh()
    m.setCurrentNode('n_b')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        recommended: 'n_a',
        nodes: [{ id: 'n_a', online: true }, { id: 'n_b', online: true }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await m.bootstrapCluster()
    expect(m.isHubMode()).toBe(true)
    expect(m.currentNodeId()).toBe('n_b') // 上次那台，不是推荐那台
    vi.unstubAllGlobals()
  })

  it('本地记的机器已经掉线 → 退回推荐', async () => {
    const m = await fresh()
    m.setCurrentNode('n_dead')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        recommended: 'n_a',
        nodes: [{ id: 'n_a', online: true }, { id: 'n_dead', online: false }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await m.bootstrapCluster()
    expect(m.currentNodeId()).toBe('n_a')
    vi.unstubAllGlobals()
  })
})

describe('方章取字', () => {
  it('中文取首字，拉丁取两个首字母', async () => {
    const { markText } = await import('./NodeMark')
    expect(markText('公司工作站')).toBe('公')
    expect(markText('云 GPU 机')).toBe('云')
    expect(markText('gpu-box')).toBe('GB')
    expect(markText('jetson')).toBe('JE')
  })
})
