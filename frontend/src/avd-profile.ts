// 新建模拟器时「用途 → 机型档/镜像」的挑选规则。
//
// 从组件里抽出来是为了能测：这几条规则错了不会报错，只会安静地建出一台不是你要的机器
// —— 选「电视(4K)」拿到 1080p 那次就是这么来的，而那要等模拟器起来才看得见。
export type Purpose = 'phone' | 'tablet' | 'tv' | 'custom'

export type DeviceProfile = { id: string; name: string; oem?: string; tag?: string }
export type AvdImage = { pkg: string; api: string; variant: string; abi: string; installed: boolean }

// 变体按关键字认，不按白名单：Google 一直在加新档（google-tv、google_apis_ps16k、
// *_tablet、aosp_atd…），写死名单等于每出一个新档就漏一个。
const NON_HANDHELD = /tv|wear|automotive|desktop|xr/

export const purposeFilter = (p: Purpose) => ({
  device: (d: DeviceProfile) => {
    const tablet = /tablet|nexus (7|9|10)/i.test(d.id + ' ' + d.name)
    if (p === 'tv') return /tv/.test(d.tag || '')
    if (p === 'tablet') return !d.tag && tablet
    if (p === 'phone') return !d.tag && !tablet
    return true
  },
  image: (i: AvdImage) => {
    if (p === 'tv') return /tv/.test(i.variant)
    if (p === 'phone' || p === 'tablet') return !NON_HANDHELD.test(i.variant)
    return true
  },
})

// tvSizeOverride 只在**没选机型档**时给电视兜一个 1080p。
//
// 选了档就绝不能盖：avdmanager -d 会把那一档自己的分辨率写进 config.ini
// （tv_4k → 3840x2160@640），我们再盖一层 1920x1080@320，用户选的「电视(4K)」
// 就被按回了 1080p —— 而且看不出是谁按的。
// 没选档时 avdmanager 落到手机默认档，一台竖屏手机尺寸的「电视」，那才要兜。
export const tvSizeOverride = (purpose: Purpose, device: string) =>
  purpose === 'tv' && !device.trim() ? { width: 1920, height: 1080, density: 320 } : {}

// AVD 名只收 [A-Za-z0-9._-]：avdmanager 拒绝空格和中文，就地转掉而不是留给后端报错。
export const slugAvdName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
