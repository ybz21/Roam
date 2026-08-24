// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatMessage } from './Message'
import { I18nProvider } from '../../i18n'
import type { Msg } from './types'

afterEach(cleanup)

const user = (text: string): Msg => ({ role: 'user', blocks: [{ kind: 'text', text }], id: 'u1' })
const show = (text: string) => render(<I18nProvider><ChatMessage m={user(text)} results={{}} side="claude" /></I18nProvider>)

describe('对话里被 @ 引用的图片', () => {
  it('渲染成能点开的卡片，而不是一行路径', () => {
    show('看看这个 @/tmp/clipboard-20260823.png')
    const card = screen.getByRole('button', { name: /clipboard-20260823\.png/ })
    expect(card).toBeTruthy()
    // 缩略图指向后端 raw，路径要转义（文件名里带空格 / # 的话不转义就断在半路）
    const img = card.querySelector('img')
    expect(img?.getAttribute('src')).toContain(encodeURIComponent('/tmp/clipboard-20260823.png'))
    // 卡片上给的是文件名，不是整条路径 —— 气泡宽度有限，整条路径会把它撑爆
    expect(card.textContent).toContain('clipboard-20260823.png')
    expect(card.textContent).not.toContain('/tmp/')
  })

  it('路径两边的文字留在原地，句子不断开', () => {
    const { container } = show('看看 @/tmp/a.png 这个问题')
    const txt = container.textContent || ''
    expect(txt).toContain('看看')
    expect(txt).toContain('这个问题')
  })

  it('非图片的 @ 路径不动它 —— 那还是句子的一部分', () => {
    const { container } = show('读一下 @/tmp/notes.txt')
    expect(screen.queryByRole('button', { name: /notes\.txt/ })).toBeNull()
    expect(container.textContent).toContain('@/tmp/notes.txt')
  })

  it('取不到图就退回原样的路径文字', () => {
    // 对话是历史记录，文件早被删掉是常态：那时候一张碎图标比一行路径更没用
    const { container } = show('@/tmp/gone.png')
    const img = container.querySelector('.tt-atimg img') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    expect(container.querySelector('.tt-atimg')).toBeNull()
    expect(container.textContent).toContain('@/tmp/gone.png')
  })

  it('一条消息里多张图各出一张卡', () => {
    show('@/tmp/a.png @/tmp/b.jpg')
    expect(screen.getByRole('button', { name: /a\.png/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /b\.jpg/ })).toBeTruthy()
  })

  it('没有图片的消息照常走 Markdown', () => {
    const { container } = show('普通一句话')
    expect(container.querySelector('.tt-atimg')).toBeNull()
    expect(container.textContent).toContain('普通一句话')
  })
})

describe('长文件名', () => {
  it('从中间断，扩展名留住 —— 手机上气泡窄，尾部省略会把它吃掉', () => {
    show('@/tmp/Screenshot_2026-08-24-10-03-09-56_3ded4b2ed06754eed0cc76c603f59da4.jpg')
    const card = screen.getByRole('button', { name: /Screenshot/ })
    expect(card.textContent).toContain('.jpg')
    expect(card.textContent).toContain('…')
    // aria-label 与 title 仍给完整名字，读屏和悬停都拿得到
    expect(card.getAttribute('aria-label')).toContain('3ded4b2ed06754eed0cc76c603f59da4.jpg')
  })
})
