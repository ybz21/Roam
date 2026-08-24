import { describe, expect, it } from 'vitest'
import { appendPaths, atPath, atPaths, splitAtPaths } from './agent-paths'

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

describe('splitAtPaths', () => {
  const png = (p: string) => /\.png$/i.test(p)

  it('把认得的路径单独切出来，前后文字原样保留', () => {
    expect(splitAtPaths('看看 @/tmp/a.png 这个', png)).toEqual([
      { kind: 'text', text: '看看 ' },
      { kind: 'path', path: '/tmp/a.png' },
      { kind: 'text', text: ' 这个' },
    ])
  })

  it('不认的路径留在文字里，不单独成段', () => {
    // 否则「看看 @a.txt 和 @b.txt 的区别」会被拆成三块，句子读不成句子
    expect(splitAtPaths('看 @/tmp/a.txt 和 @/tmp/b.png', png)).toEqual([
      { kind: 'text', text: '看 @/tmp/a.txt 和 ' },
      { kind: 'path', path: '/tmp/b.png' },
    ])
  })

  it('只认绝对路径——相对路径没有基准目录，取不出文件', () => {
    expect(splitAtPaths('@src/a.png', png)).toEqual([{ kind: 'text', text: '@src/a.png' }])
  })

  it('@ 前面必须是行首或空白，别把 foo@/bar.png 认成引用', () => {
    expect(splitAtPaths('mail:foo@/x.png', png)).toEqual([{ kind: 'text', text: 'mail:foo@/x.png' }])
  })

  it('开头就是路径 / 连着两条 / 空文本', () => {
    expect(splitAtPaths('@/tmp/a.png', png)).toEqual([{ kind: 'path', path: '/tmp/a.png' }])
    expect(splitAtPaths('@/tmp/a.png @/tmp/b.png', png)).toEqual([
      { kind: 'path', path: '/tmp/a.png' },
      { kind: 'text', text: ' ' },
      { kind: 'path', path: '/tmp/b.png' },
    ])
    expect(splitAtPaths('', png)).toEqual([])
  })

  it('atPaths 拼出来的东西切得回来——两个方向必须对得上', () => {
    const paths = ['/tmp/a.png', '/tmp/b.png']
    const segs = splitAtPaths(appendPaths('看这个', paths), png)
    expect(segs.filter((s) => s.kind === 'path').map((s: any) => s.path)).toEqual(paths)
  })

  // 正则是模块级的，带 /g 就带着 lastIndex —— 忘了清会让第二次调用从上次的位置开始，
  // 表现是「同一条消息，重渲染之后图片没了」。
  it('连续调用两次结果一样', () => {
    const a = splitAtPaths('看 @/tmp/a.png', png)
    const b = splitAtPaths('看 @/tmp/a.png', png)
    expect(b).toEqual(a)
  })
})
