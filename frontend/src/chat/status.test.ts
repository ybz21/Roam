import { describe, it, expect } from 'vitest'
import { toAgentStatus, fmtTokens, modeKey } from './status'
import type { TaskIndex } from './tasks'

describe('toAgentStatus', () => {
  it('Claude：算出上下文百分比', () => {
    // 真实转录样本：2 + 2634 + 269173 = 271809，窗口 1M
    const st = toAgentStatus({ used: 271809, window: 1_000_000, model: 'claude-opus-5', effort: 'high' })
    expect(st.context).toMatchObject({ used: 271809, window: 1_000_000 })
    expect(st.context!.percent).toBeCloseTo(27.18, 1)
    expect(st.model).toBe('claude-opus-5')
  })

  it('Codex：额度是它独有的，Claude 侧该缺席', () => {
    const codex = toAgentStatus({ used: 16543, window: 258400, quota: 44 })
    expect(codex.quota).toBe(44)
    expect(codex.context!.percent).toBeCloseTo(6.4, 1)
    // Claude 没有 quota → 渲染层据此不画那个环（不靠判断是不是 Codex）
    expect(toAgentStatus({ used: 1, window: 10 }).quota).toBeUndefined()
  })

  it('模式带上色调：计划蓝 / 接受编辑绿 / 越权黄 / 其余中性', () => {
    expect(toAgentStatus({ mode: 'plan' }).mode).toEqual({ id: 'plan', tone: 'accent' })
    expect(toAgentStatus({ mode: 'acceptEdits' }).mode!.tone).toBe('ok')
    expect(toAgentStatus({ mode: 'bypassPermissions' }).mode!.tone).toBe('warn')
    expect(toAgentStatus({ mode: 'danger-full-access' }).mode!.tone).toBe('warn')
    expect(toAgentStatus({ mode: 'default' }).mode!.tone).toBe('neutral')
  })

  it('没见过的模式也认，只是中性色——新模式先出现在 CLI 里是常态', () => {
    expect(toAgentStatus({ mode: 'brand-new-mode' }).mode).toEqual({ id: 'brand-new-mode', tone: 'neutral' })
    expect(modeKey('brand-new-mode')).toBe('chat.mode.brand-new-mode')
  })

  it('缺 used 或 window 就不给 context，不画半个环', () => {
    expect(toAgentStatus({ used: 100 }).context).toBeUndefined()
    expect(toAgentStatus({ window: 200000 }).context).toBeUndefined()
  })

  it('百分比封顶 100：压缩前一瞬可能超窗口，不该画出满溢的环', () => {
    expect(toAgentStatus({ used: 300000, window: 200000 }).context!.percent).toBe(100)
  })

  it('任务进度取自转录归拢出的清单，含「正在做哪件」', () => {
    const tasks: TaskIndex = {
      '1': { id: '1', subject: 'a', status: 'completed' },
      '2': { id: '2', subject: '做状态条', status: 'in_progress' },
      '3': { id: '3', subject: 'c', status: 'pending' },
      '4': { id: '4', subject: 'd', status: 'deleted' },
    }
    expect(toAgentStatus({}, tasks).tasks).toEqual({ done: 1, total: 3, doing: '做状态条' })
  })

  it('没有任务就不出这一项', () => {
    expect(toAgentStatus({}, {}).tasks).toBeUndefined()
    expect(toAgentStatus({}).tasks).toBeUndefined()
  })
})

describe('fmtTokens', () => {
  it('位数固定，数字不会一跳一跳', () => {
    expect(fmtTokens(271809)).toBe('271.8k')
    expect(fmtTokens(1_000_000)).toBe('1.0M')
    expect(fmtTokens(999)).toBe('999')
  })
})
