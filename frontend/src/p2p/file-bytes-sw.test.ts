import { describe, expect, it, vi } from 'vitest'

vi.mock('../components/cluster/node-url', () => ({ currentNodeId: () => 'n_me' }))

const { parseRange, pathOf, isCurrentNode } = await import('./file-bytes-sw')

describe('Range 解析', () => {
  it('认单段：起止都给 / 只给起点', () => {
    expect(parseRange('bytes=100-199')).toEqual({ offset: 100, length: 100 })
    expect(parseRange('bytes=100-')).toEqual({ offset: 100, length: 0 })
    expect(parseRange(' bytes=0-0 ')).toEqual({ offset: 0, length: 1 })
  })

  it('不认的花样一律返回 null，让它走 HTTP —— 猜错一个字节就是一段坏视频', () => {
    expect(parseRange('bytes=-500')).toBeNull()        // 后缀区间：要先知道文件多大
    expect(parseRange('bytes=0-99,200-299')).toBeNull() // 多段：响应体得是 multipart
    expect(parseRange('items=0-1')).toBeNull()
    expect(parseRange('bytes=200-100')).toBeNull()      // 起点比终点大
    expect(parseRange('')).toBeNull()
  })
})

describe('取路径与机器归属', () => {
  it('从 query 里取绝对路径', () => {
    expect(pathOf('https://h/api/file/raw?path=%2Ftmp%2Fa%20b.mp4')).toBe('/tmp/a b.mp4')
    expect(pathOf('https://h/api/file/raw')).toBe('')
    expect(pathOf('不是个 URL')).toBe('')
  })

  it('别的机器上的文件不走直连 —— 直连只通向当前这台，拿错就是给错文件', () => {
    expect(isCurrentNode('https://hub/n/n_me/api/file/raw?path=%2Fa')).toBe(true)
    expect(isCurrentNode('https://hub/n/n_other/api/file/raw?path=%2Fa')).toBe(false)
    expect(isCurrentNode('https://node/api/file/raw?path=%2Fa')).toBe(true) // 单机/本机直通口
  })
})
