// 手机目标设备：列出 adb/idb 看得见的设备，并把「选中某台」翻译成一份 phone-config 补丁。
// 设置页与镜像页共用这一份规则——两处各写一遍必然走散，改了一处另一处继续串档。
import { api } from './api'

export interface PhoneDevice {
  id: string
  name: string
  /** android: avd | network | usb；ios: simulator | device */
  kind: string
  /** device=就绪；offline / unauthorized / stopped 也会列出来，好让人看见「少的那台在哪」 */
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
  avd: 'phone.dev.avd', network: 'phone.dev.network', usb: 'phone.dev.usb',
  simulator: 'phone.dev.simulator', device: 'phone.dev.real',
}
const STATE_KEY: Record<string, string> = {
  offline: 'phone.devState.offline', unauthorized: 'phone.devState.unauthorized',
  stopped: 'phone.devState.stopped',
}

export const devKindText = (d: PhoneDevice, t: (k: string) => string) => (KIND_KEY[d.kind] ? t(KIND_KEY[d.kind]) : d.kind || '')

/** 设备未就绪的原因；就绪(device/Booted)返回空——「一切正常」不必占一行字。 */
export const devStateText = (d: PhoneDevice, t: (k: string) => string) => {
  const s = (d.state || '').toLowerCase()
  if (!s || s === 'device' || s === 'booted') return ''
  return STATE_KEY[s] ? t(STATE_KEY[s]) : d.state || ''
}

// serial 的形状就决定了怎么连，所以换设备必须连来源(mode)一起换：
// avd:<名>=还没起的本机模拟器、emulator-xxxx=在跑的本机模拟器、host:port=远程设备(无线调试/别的机器)、
// 其余裸 serial=本机真机。只改地址不改 mode 会被后端 sanitizeAndroid 判成串档直接丢弃。
//
// avdName 是运行中模拟器的 AVD 名（设备列表里 name 那一栏）：一并存下来，停掉之后
// 配置还指得动它，不然一停机「当前用的是哪台」就从界面上消失了。
export function androidTargetOf(id: string, avdName?: string): { mode: string; address: string; avd: string } {
  const s = (id || '').trim()
  if (s.startsWith('avd:')) return { mode: 'avd', address: '', avd: s.slice(4) }
  if (s.startsWith('emulator-')) return { mode: 'avd', address: s, avd: (avdName || '').trim() }
  if (s.includes(':')) return { mode: 'network', address: s, avd: '' }
  return { mode: 'device', address: s, avd: '' }
}

/** 换设备：读当前配置 → 打补丁 → 存回 → 连一次（网络目标要 adb connect 才就绪）。 */
export async function selectPhoneDevice(platform: 'android' | 'ios', id: string, avdName?: string) {
  const r = await api('GET', '/phone/config')
  const cfg = r?.data || {}
  const next = platform === 'android'
    ? { ...cfg, active: 'android', android: { ...(cfg.android || {}), ...androidTargetOf(id, avdName) } }
    : { ...cfg, active: 'ios', ios: { ...(cfg.ios || {}), address: id } }
  await api('PUT', '/phone/config', next)
  await api('POST', '/phone/connect', {})
}
