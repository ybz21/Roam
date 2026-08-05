import { describe, it, expect } from 'vitest'
import { toAgentStatus, fmtTokens, modeKey, fitWindow } from './status'
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

  it('用量超过后端给的窗口 → 自动升档，而不是钉在 100%', () => {
    const st = toAgentStatus({ used: 652_321, window: 200_000 })
    expect(st.context!.window).toBe(1_000_000)
    expect(st.context!.percent).toBeCloseTo(65.2, 1)
  })

  it('任务进度取自转录归拢出的清单，含「正在做哪件」', () => {
    const tasks: TaskIndex = {
      '1': { id: '1', subject: 'a', status: 'completed' },
      '2': { id: '2', subject: '做状态条', status: 'in_progress' },
      '3': { id: '3', subject: 'c', status: 'pending' },
      '4': { id: '4', subject: 'd', status: 'deleted' },
    }
    const got = toAgentStatus({}, tasks).tasks!
    expect(got.done).toBe(1)
    expect(got.total).toBe(3)
    expect(got.doing).toBe('做状态条')
    // list 供点开逐条看进度；已删除的不在里面
    expect(got.list.map((x) => x.id)).toEqual(['1', '2', '3'])
  })

  it('没有任务就不出这一项', () => {
    expect(toAgentStatus({}, {}).tasks).toBeUndefined()
    expect(toAgentStatus({}).tasks).toBeUndefined()
  })
})

describe('fitWindow（后端窗口偏小时兜底升档）', () => {
  it('用量没超窗口就原样', () => {
    expect(fitWindow(120_000, 200_000)).toBe(200_000)
  })

  it('实测踩过的那个坑：1M 会话被当成 200k，只会画出 100% 却还在涨', () => {
    // 转录里 message.model 恒为 "claude-opus-5"（[1m] 标记被剥掉），
    // 本机 12 个会话里 11 个用量超 200k，最高 999,263
    expect(fitWindow(652_321, 200_000)).toBe(1_000_000)
    expect(fitWindow(999_263, 200_000)).toBe(1_000_000)
  })

  it('超过已知最大档就用实际用量当分母，也就是恰好 100%，不会溢出', () => {
    expect(fitWindow(3_000_000, 200_000)).toBe(3_000_000)
  })

  it('窗口为 0（后端没给）时不硬凑', () => {
    expect(fitWindow(100, 0)).toBe(0)
  })
})

describe('fmtTokens', () => {
  it('位数固定，数字不会一跳一跳', () => {
    expect(fmtTokens(271809)).toBe('271.8k')
    expect(fmtTokens(1_000_000)).toBe('1.0M')
    expect(fmtTokens(999)).toBe('999')
  })
})
