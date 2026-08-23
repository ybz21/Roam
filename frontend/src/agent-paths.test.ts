import { describe, expect, it } from 'vitest'
import { appendPaths, atPath, atPaths } from './agent-paths'

describe('交给 agent 的路径写法', () => {
  it('每个路径都带上 @', () => {
    expect(atPaths(['/tmp/a.png', '/w/b.txt'])).toBe('@/tmp/a.png @/w/b.txt ')
  })

  // 末尾这个空格是有用的：粘完接着打字不会和路径粘成 "@/tmp/a.png然后"
  it('末尾留一个空格', () => {
    expect(atPaths(['/tmp/a.png']).endsWith(' ')).toBe(true)
  })

  it('已经带 @ 的不再叠一个', () => {
    expect(atPath('@/tmp/a.png')).toBe('@/tmp/a.png')
    expect(atPaths(['@/tmp/a.png', '/tmp/b.png'])).toBe('@/tmp/a.png @/tmp/b.png ')
  })

  // 上传失败/返回空数组时不该往输入框里塞一个孤零零的空格
  it('空输入产出空串', () => {
    expect(atPaths([])).toBe('')
    expect(atPaths(['', '  '])).toBe('')
    expect(atPath('')).toBe('')
    expect(appendPaths('已有文字', [])).toBe('已有文字')
  })

  it('接到已有文字后面时补一个空格', () => {
    expect(appendPaths('看看这个', ['/tmp/a.png'])).toBe('看看这个 @/tmp/a.png ')
  })

  // 用户已经打了空格的话别再加一个，否则连点几次会攒出一串空格
  it('已有文字末尾的空白折成一个', () => {
    expect(appendPaths('看看这个   ', ['/tmp/a.png'])).toBe('看看这个 @/tmp/a.png ')
    expect(appendPaths('', ['/tmp/a.png'])).toBe('@/tmp/a.png ')
  })
})
