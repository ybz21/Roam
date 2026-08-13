// @vitest-environment jsdom
//
// 交换空间用满是**整机卡死的前兆**，不是「内存用得比较多」。这块面板一直在采它、
// 也一直在画它，但画成了一根固定灰色的小条：98% 和 5% 长得一模一样。
// 本机 2026-08-12 下午就是这么冻死的（ping 通、ssh 进不去，只能按电源键），
// 而之前三天 swap 一直贴着 98%——数字就在屏幕上，没人可能看出来。
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import HostMonitorPanel, { type Snapshot } from './HostMonitorPanel'

const GB = 1024 ** 3

function snapshot(swapUsed: number, swapTotal: number): Snapshot {
  return {
    time: '2026-08-13T08:00:00Z',
    host: { hostname: 'box', load1: 1, load5: 1, load15: 1 },
    cpu: { cores: 8, usagePercent: 10 },
    memory: { total: 32 * GB, used: 20 * GB, available: 12 * GB, usagePercent: 62, swapTotal, swapUsed },
    disks: null, gpus: null,
    network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
    history: null,
  }
}

// t 直接回 key：断言看的是「这句话出没出现」，不依赖任何一种语言的措辞。
const show = (used: number, total = 8 * GB) =>
  render(<HostMonitorPanel pluginId="roam.host-monitor" enabled t={(k) => k}
    fetchSnapshot={async () => snapshot(used, total)} />)

const swapBar = () => document.querySelectorAll('.ant-progress-line .ant-progress-bg')[0] as HTMLElement | undefined

afterEach(cleanup)

describe('交换空间告警', () => {
  it('快用完时变红并说明后果', async () => {
    show(7.9 * GB)
    await waitFor(() => expect(screen.getByText('plugins.monitor.swapCritical')).toBeTruthy())
    expect(swapBar()?.style.background).toContain('--danger')
  })

  it('用得不多时不喊，也不刺眼', async () => {
    show(0.8 * GB)
    await waitFor(() => expect(screen.getByText(/^Swap /)).toBeTruthy())
    expect(screen.queryByText('plugins.monitor.swapCritical')).toBeNull()
    expect(swapBar()?.style.background).toContain('--ok')
  })

  // 没有交换分区的机器（容器里常见）不该出现一根 NaN% 的条
  it('没有交换分区就整块不画', async () => {
    show(0, 0)
    await waitFor(() => expect(screen.getByText('box')).toBeTruthy())
    expect(screen.queryByText(/^Swap /)).toBeNull()
  })
})
