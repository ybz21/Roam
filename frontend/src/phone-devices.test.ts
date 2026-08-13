// 选设备＝换目标：serial 的形状决定 mode，只改地址不改 mode 会被后端 sanitizeAndroid
// 判成串档直接丢弃（真机档不收 host:port），于是「点了一台却连不上」。这条钉死那个映射。
import { describe, it, expect, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

const { androidTargetOf, devStateText, devKindText } = await import('./phone-devices')

describe('androidTargetOf', () => {
  it('裸 serial = 本机真机', () => {
    expect(androidTargetOf('216d6a43')).toEqual({ mode: 'device', address: '216d6a43', avd: '' })
  })
  it('emulator-xxxx = 在跑的本机模拟器，顺带记下 AVD 名', () => {
    expect(androidTargetOf('emulator-5554', 'xh_tv1080p'))
      .toEqual({ mode: 'avd', address: 'emulator-5554', avd: 'xh_tv1080p' })
  })
  it('avd:<名> = 还没起的模拟器：只有名字指得动它', () => {
    expect(androidTargetOf('avd:Pixel_7_API_36')).toEqual({ mode: 'avd', address: '', avd: 'Pixel_7_API_36' })
  })
  it('host:port = 远程设备（无线调试的手机，或另一台机器上的安卓）', () => {
    expect(androidTargetOf('192.168.120.241:5555')).toEqual({ mode: 'network', address: '192.168.120.241:5555', avd: '' })
    expect(androidTargetOf('localhost:5555')).toEqual({ mode: 'network', address: 'localhost:5555', avd: '' })
  })
  it('去空白：尾随空格会让 adb connect / adb -s 失败', () => {
    expect(androidTargetOf('  216d6a43 ')).toEqual({ mode: 'device', address: '216d6a43', avd: '' })
  })
})

describe('设备状态文案', () => {
  const t = (k: string) => k
  const dev = (kind: string, state?: string) => ({ id: 'a', name: 'A', kind, state })
  it('就绪不占一行字', () => {
    expect(devStateText(dev('usb', 'device'), t)).toBe('')
    expect(devStateText(dev('simulator', 'Booted'), t)).toBe('')
  })
  it('没就绪要说清是为什么', () => {
    expect(devStateText(dev('usb', 'unauthorized'), t)).toBe('phone.devState.unauthorized')
    expect(devStateText(dev('network', 'offline'), t)).toBe('phone.devState.offline')
  })
  it('表里没有的原样显示：idb 的 type/state 是自由文本，硬翻会把 key 印到界面上', () => {
    expect(devStateText(dev('usb', 'booting(53%)'), t)).toBe('booting(53%)')
    expect(devKindText(dev('macOS'), t)).toBe('macOS')
    expect(devKindText(dev('avd'), t)).toBe('phone.dev.avd')
  })
})
