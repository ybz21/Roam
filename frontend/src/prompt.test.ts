// detectPrompt 的回归用例。重点是**窄屏**：手机 attach 后 tmux 窗格常只剩 40 多列，
// Claude 的选项会折成五六行，早期按「行距 ≤3」分组会把每个选项拆成孤岛 → 手机上根本不弹提问框。
import { describe, it, expect } from 'vitest'
import { detectPrompt } from './prompt'

// 宽屏：选项彼此紧挨
const WIDE = `
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions.
     1. Default (recommended)  Opus 5 with 1M context · Best for everyday tasks
   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday tasks
     3. Fable                  Fable 5 · Most capable for your hardest tasks
   Enter to set as default · Esc to cancel
`

// 窄屏（47 列，真机抓的）：每个选项后面跟 4 行续行，选项之间隔 5 行
const NARROW = `
   Select model
   Switch between Claude models. Your pick
   becomes the default for new sessions. For
   other/previous model names, specify with
   --model.

     1. Default (recommende…  Opus 5 with 1M
                              context ·
                              Best for
                              everyday,
                              complex tasks
   ❯ 2. Opus (1M context) ✔   Opus 5 with 1M
                              context ·
                              Best for
                              everyday,
                              complex tasks
     3. Fable                 Fable 5 · Most
                              capable for
                              your hardest   ↓
`

// 普通编号列表：没有游标、也没有确认类关键词，不该误判成选择框
const PLAIN_LIST = `
   Here is what I changed:
     1. renamed the helper
     2. added a test
     3. updated the docs
   Done.
`

describe('detectPrompt', () => {
  it('宽屏选择框：识别出全部选项与当前游标', () => {
    const p = detectPrompt(WIDE)
    expect(p?.kind).toBe('select')
    expect(p?.choices.map((c) => c.num)).toEqual([1, 2, 3])
    expect(p?.choices.find((c) => c.selected)?.num).toBe(2)
  })

  it('窄屏折行选择框：选项隔了 5 行也要认出来（手机回归）', () => {
    const p = detectPrompt(NARROW)
    expect(p?.kind).toBe('select')
    expect(p?.choices.map((c) => c.num)).toEqual([1, 2, 3])
    expect(p?.choices.find((c) => c.selected)?.num).toBe(2)
  })

  it('y/n 提示走兜底分支', () => {
    expect(detectPrompt('Overwrite existing file? (y/n)')?.kind).toBe('yesno')
  })

  it('普通编号列表不误判', () => {
    expect(detectPrompt(PLAIN_LIST)).toBeNull()
  })

  it('空屏返回 null', () => {
    expect(detectPrompt('')).toBeNull()
  })
})
