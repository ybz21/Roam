import { describe, it, expect } from 'vitest'
import { dirTailName } from './dir-name'

describe('dirTailName', () => {
  it('取最后一段', () => {
    expect(dirTailName('/home/ai/codes/ttmux')).toBe('ttmux')
    expect(dirTailName('~/codes/blade-agent')).toBe('blade-agent')
  })
  it('结尾斜杠、连续斜杠都不影响', () => {
    expect(dirTailName('/home/ai/codes/ttmux/')).toBe('ttmux')
    expect(dirTailName('/home/ai/codes/ttmux///')).toBe('ttmux')
    expect(dirTailName('/home//ai//codes//ttmux')).toBe('ttmux')
  })
  it('Windows 反斜杠', () => {
    expect(dirTailName('C:\\Users\\ai\\codes\\ttmux')).toBe('ttmux')
  })
  it('根目录与空串给空——调用方保持原样，不会写进一个奇怪的名字', () => {
    expect(dirTailName('/')).toBe('')
    expect(dirTailName('   ')).toBe('')
    expect(dirTailName('')).toBe('')
  })
  it('单段路径就是它自己', () => {
    expect(dirTailName('ttmux')).toBe('ttmux')
  })
})
