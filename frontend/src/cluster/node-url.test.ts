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

// 引导失败时**不能**悄悄退化成单机：在中心上那意味着每条业务请求都少了 /n/<id> 前缀，
// 整页 404 而且没有任何提示。这里盯住「引导没成功就不该有 nodeId」这条底线。
describe('引导失败的兜底', () => {
  // 本地镜像会跨用例留着（它本来就是「刷新后还记得上次那台」），这里要的是干净起点
  beforeEach(() => { localStorage.clear() })

  it('中心返回 401（没登录）时不进多机态，也不乱认一台机器', async () => {
    const m = await fresh()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await m.bootstrapCluster()
    expect(m.isHubMode()).toBe(false)
    expect(m.currentNodeId()).toBe(null)
    vi.unstubAllGlobals()
  })

  it('一台在线的都没有时不选任何机器——总比选个连不上的强', async () => {
    const m = await fresh()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { recommended: '', nodes: [{ id: 'n_a', online: false }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await m.bootstrapCluster()
    expect(m.isHubMode()).toBe(true)
    expect(m.currentNodeId()).toBe(null)
    vi.unstubAllGlobals()
  })
})

// 认证类路径**永远不能带节点前缀**：登录发到 /n/<id>/api/login 会被转发到那台节点，
// 校验的是节点的口令而不是中心的——「用中心的口令登不进去、用某台机器的口令反而能进」。
// 这条是真实浏览器里踩出来的：测试用全新 profile 没有 nodeId，一路不带前缀全绿，
// 而浏览器里存着上次的 nodeId 就必炸。
describe('认证类路径不加机器前缀', () => {
  beforeEach(() => { localStorage.clear() })

  it('登录/登出/首次设置/探测/自身信息 一律打到中心', async () => {
    const m = await fresh()
    m.setCurrentNode('n_01')
    for (const p of ['/login', '/logout', '/setup', '/pubconfig', '/me', '/version', '/update-check']) {
      expect(m.nodeApi(p)).toBe('/api' + p)
    }
    // 中心本地的机器名单同理
    expect(m.nodeApi('/hub/nodes')).toBe('/api/hub/nodes')
    expect(m.nodeApi('/hub/bootstrap')).toBe('/api/hub/bootstrap')
  })

  it('业务路径照旧带前缀，别把这条改过头', async () => {
    const m = await fresh()
    m.setCurrentNode('n_01')
    expect(m.nodeApi('/sessions')).toBe('/n/n_01/api/sessions')
    expect(m.nodeApi('/projects')).toBe('/n/n_01/api/projects')
    // 名字里带 me/login 的业务路径不能被误伤
    expect(m.nodeApi('/files?path=/home/me')).toBe('/n/n_01/api/files?path=/home/me')
    expect(m.nodeApi('/metrics')).toBe('/n/n_01/api/metrics')
  })
})
