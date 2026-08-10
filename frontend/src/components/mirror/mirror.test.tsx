// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Omnibox, splitUrl, StreamControl } from './mirror'
import { I18nProvider } from '../../i18n'

const wrap = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('splitUrl：域名亮、其余灰', () => {
  it('带协议的按 host / 其余拆', () => {
    expect(splitUrl('http://127.0.0.1:18077/home?x=1')).toEqual({ host: '127.0.0.1:18077', rest: '/home?x=1' })
    expect(splitUrl('https://example.com')).toEqual({ host: 'example.com', rest: '' })
  })
  it('没协议也能拆', () => {
    expect(splitUrl('example.com/a/b')).toEqual({ host: 'example.com', rest: '/a/b' })
  })
  it('空串不炸', () => {
    expect(splitUrl('')).toEqual({ host: '', rest: '' })
  })
})

describe('Omnibox：这一页唯一的主角', () => {
  it('失焦时域名与路径分开着色，且没有「前往」按钮抢戏', () => {
    const { container } = wrap(<Omnibox value="http://127.0.0.1:18077/home" goLabel="前往" />)
    expect(container.querySelector('.mc-omni-txt .host')?.textContent).toBe('127.0.0.1:18077')
    expect(container.querySelector('.mc-omni-txt .path')?.textContent).toBe('/home')
    expect(container.querySelector('.mc-omni-go')).toBeNull()
  })

  it('点一下进入编辑：出输入框、✕ 与「前往」', () => {
    const { container } = wrap(<Omnibox value="http://a.com/x" goLabel="前往" onChange={() => {}} />)
    fireEvent.click(container.querySelector('.mc-omni-txt')!)
    const input = container.querySelector('.mc-omni-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('http://a.com/x')
    expect(container.querySelector('.mc-omni-x')).toBeTruthy()
    expect(screen.getByText('前往')).toBeTruthy()
  })

  it('回车提交；Esc 还原原地址，不留半截脏值', () => {
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    const { container } = wrap(<Omnibox value="http://a.com" onChange={onChange} onSubmit={onSubmit} goLabel="前往" />)
    fireEvent.click(container.querySelector('.mc-omni-txt')!)
    const input = container.querySelector('.mc-omni-input')!
    fireEvent.change(input, { target: { value: 'http://b.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalled()

    fireEvent.click(container.querySelector('.mc-omni-txt')!)
    const again = container.querySelector('.mc-omni-input')!
    fireEvent.change(again, { target: { value: '乱改的' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(onChange).toHaveBeenLastCalledWith('http://a.com')
  })

  it('聚焦状态通知调用方（地址栏聚焦时轮询不许回写）', () => {
    const onFocusChange = vi.fn()
    const { container } = wrap(<Omnibox value="http://a.com" onFocusChange={onFocusChange} goLabel="前往" />)
    fireEvent.click(container.querySelector('.mc-omni-txt')!)
    expect(onFocusChange).toHaveBeenCalledWith(true)
  })

  it('只读态（手机镜像页的 devbox）不给输入框', () => {
    const { container } = wrap(<Omnibox readOnly value="Pixel 7" sub="Android 14 · 1080×2400" />)
    fireEvent.click(container.querySelector('.mc-omni-txt')!)
    expect(container.querySelector('.mc-omni-input')).toBeNull()
    expect(container.querySelector('.mc-omni-sub')?.textContent).toContain('1080×2400')
  })
})

describe('StreamControl：连接与画质是一个部件', () => {
  const base = {
    connected: true, label: '已连接', quality: 92 as const, onQuality: () => {},
    latency: 32, bytesPerSec: 1024 * 1024, fps: 24,
  }

  it('徽标形态：状态点 + 当前档位，档位藏在浮层里', () => {
    const { container } = wrap(<StreamControl {...base} variant="badge" />)
    const lead = container.querySelector('.mc-lead')!
    expect(lead.querySelector('.mc-dot.is-on')).toBeTruthy()
    expect(lead.textContent).toContain('超清')
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    fireEvent.click(lead)
    expect(screen.getAllByRole('radio')).toHaveLength(4)
  })

  it('浮层里状态与四档在一起：点哪儿开的都是同一个面板', () => {
    const { container } = wrap(<StreamControl {...base} variant="chip" />)
    fireEvent.click(container.querySelector('.mc-chip')!)
    const pop = document.querySelector('.mc-pop')!
    expect(pop.querySelector('.mc-pop-h')?.textContent).toContain('已连接')
    expect(pop.querySelector('.mc-pop-h')?.textContent).toContain('32ms')
    expect(pop.querySelectorAll('.ant-segmented-item')).toHaveLength(4)
  })

  it('auto 档显示后端实际选中的那档', () => {
    const { container } = wrap(<StreamControl {...base} quality="auto" level="高清" variant="badge" />)
    expect(container.querySelector('.mc-lead b')?.textContent).toBe('高清')
  })

  it('没连上时状态点不是绿的', () => {
    const { container } = wrap(<StreamControl {...base} connected={false} label="未连接" variant="badge" />)
    expect(container.querySelector('.mc-dot.is-on')).toBeNull()
    expect(container.querySelector('.mc-dot')).toBeTruthy()
  })

  it('换档回调把 auto 与数字档分开给', () => {
    const onQuality = vi.fn()
    const { container } = wrap(<StreamControl {...base} onQuality={onQuality} variant="badge" />)
    fireEvent.click(container.querySelector('.mc-lead')!)
    fireEvent.click(screen.getAllByRole('radio')[0])
    expect(onQuality).toHaveBeenCalledWith('auto')
    fireEvent.click(screen.getAllByRole('radio')[1])
    expect(onQuality).toHaveBeenCalledWith(50)
  })
})
