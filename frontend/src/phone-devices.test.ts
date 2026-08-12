// 选设备＝换目标：serial 的形状决定 mode，只改地址不改 mode 会被后端 sanitizeAndroid
// 判成串档直接丢弃（真机档不收 host:port），于是「点了一台却连不上」。这条钉死那个映射。
import { describe, it, expect, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

const { androidTargetOf, devStateText, devKindText } = await import('./phone-devices')

describe('androidTargetOf', () => {
  it('裸 serial = 本机设备（USB 真机 / 本机模拟器）', () => {
    expect(androidTargetOf('216d6a43')).toEqual({ mode: 'device', address: '216d6a43' })
    expect(androidTargetOf('emulator-5554')).toEqual({ mode: 'device', address: 'emulator-5554' })
  })
  it('loopback host:port = 本地 redroid', () => {
    expect(androidTargetOf('localhost:5555')).toEqual({ mode: 'local', address: 'localhost:5555' })
    expect(androidTargetOf('127.0.0.1:5555')).toEqual({ mode: 'local', address: '127.0.0.1:5555' })
  })
  it('其它 host:port = 远程（另一台机器的 redroid，或开了无线调试的手机）', () => {
    expect(androidTargetOf('192.168.120.241:5555')).toEqual({ mode: 'remote', address: '192.168.120.241:5555' })
  })
  it('去空白：尾随空格会让 adb connect / adb -s 失败', () => {
    expect(androidTargetOf('  216d6a43 ')).toEqual({ mode: 'device', address: '216d6a43' })
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
    expect(devKindText(dev('emulator'), t)).toBe('phone.dev.emulator')
  })
})
