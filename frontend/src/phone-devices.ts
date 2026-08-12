// 手机目标设备：列出 adb/idb 看得见的设备，并把「选中某台」翻译成一份 phone-config 补丁。
// 设置页与镜像页共用这一份规则——两处各写一遍必然走散，改了一处另一处继续串档。
import { api } from './api'

export interface PhoneDevice {
  id: string
  name: string
  /** android: emulator | network | usb；ios: simulator | device */
  kind: string
  /** device=就绪；offline / unauthorized 也会列出来，好让人看见「少的那台在哪」 */
  state?: string
  current?: boolean
}

export const listPhoneDevices = (platform: 'android' | 'ios'): Promise<PhoneDevice[]> =>
  api('GET', `/phone/devices?platform=${platform}`)
    .then((r) => (Array.isArray(r?.data) ? (r.data as PhoneDevice[]) : []))
    .catch(() => [])

// 设备类型 / 状态 → i18n key。表里没有的原样显示：idb 的 type/state 是自由文本，
// 用 t() 直接翻会把 'phone.dev.xxx' 这种 key 原样印到界面上。
const KIND_KEY: Record<string, string> = {
  emulator: 'phone.dev.emulator', network: 'phone.dev.network', usb: 'phone.dev.usb',
  simulator: 'phone.dev.simulator', device: 'phone.dev.real',
}
const STATE_KEY: Record<string, string> = {
  offline: 'phone.devState.offline', unauthorized: 'phone.devState.unauthorized',
}

export const devKindText = (d: PhoneDevice, t: (k: string) => string) => (KIND_KEY[d.kind] ? t(KIND_KEY[d.kind]) : d.kind || '')

/** 设备未就绪的原因；就绪(device/Booted)返回空——「一切正常」不必占一行字。 */
export const devStateText = (d: PhoneDevice, t: (k: string) => string) => {
  const s = (d.state || '').toLowerCase()
  if (!s || s === 'device' || s === 'booted') return ''
  return STATE_KEY[s] ? t(STATE_KEY[s]) : d.state || ''
}

// serial 的形状就决定了怎么连，所以换设备必须连来源(mode)一起换：
// loopback host:port=本地 redroid、其它 host:port=远程 redroid、裸 serial=本机设备(USB 真机/模拟器)。
// 只改地址不改 mode 会被后端 sanitizeAndroid 判成串档——真机模式下 host:port 直接丢弃。
export function androidTargetOf(id: string): { mode: string; address: string } {
  const s = (id || '').trim()
  if (!s.includes(':')) return { mode: 'device', address: s }
  const host = s.split(':')[0]
  return { mode: host === 'localhost' || host === '127.0.0.1' ? 'local' : 'remote', address: s }
}

/** 换设备：读当前配置 → 打补丁 → 存回 → 连一次（网络目标要 adb connect 才就绪）。 */
export async function selectPhoneDevice(platform: 'android' | 'ios', id: string) {
  const r = await api('GET', '/phone/config')
  const cfg = r?.data || {}
  const next = platform === 'android'
    ? { ...cfg, active: 'android', android: { ...(cfg.android || {}), ...androidTargetOf(id) } }
    : { ...cfg, active: 'ios', ios: { ...(cfg.ios || {}), address: id } }
  await api('PUT', '/phone/config', next)
  await api('POST', '/phone/connect', {})
}
