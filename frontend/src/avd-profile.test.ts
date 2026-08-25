import { describe, expect, it } from 'vitest'
import { purposeFilter, slugAvdName, tvSizeOverride } from './avd-profile'
import type { AvdImage, DeviceProfile } from './avd-profile'

const dev = (id: string, name: string, tag?: string): DeviceProfile => ({ id, name, tag })
const img = (variant: string): AvdImage =>
  ({ pkg: `system-images;android-36;${variant};x86_64`, api: '36', variant, abi: 'x86_64', installed: true })

describe('电视的分辨率兜底', () => {
  it('选了「电视(4K)」就不盖分辨率 —— 机型档自己写的是 3840x2160', () => {
    // 这条是回归：从前无条件盖 1920x1080，选 4K 建出来的是一台 1080p 电视，
    // 而 config.ini 里看不出是谁按下去的。
    expect(tvSizeOverride('tv', 'tv_4k')).toEqual({})
    expect(tvSizeOverride('tv', 'tv_720p')).toEqual({})
  })

  it('没选机型档才兜 1080p —— 否则 avdmanager 会落到手机默认档', () => {
    expect(tvSizeOverride('tv', '')).toEqual({ width: 1920, height: 1080, density: 320 })
    expect(tvSizeOverride('tv', '   ')).toEqual({ width: 1920, height: 1080, density: 320 })
  })

  it('手机/平板/自定义一律不插手', () => {
    for (const p of ['phone', 'tablet', 'custom'] as const) {
      expect(tvSizeOverride(p, '')).toEqual({})
      expect(tvSizeOverride(p, 'pixel_9')).toEqual({})
    }
  })
})

describe('用途筛选', () => {
  const devices = [
    dev('pixel_9', 'Pixel 9'),
    dev('pixel_tablet', 'Pixel Tablet'),
    dev('tv_4k', 'Television (4K)', 'android-tv'),
    dev('wearos_large_round', 'Wear OS Large Round', 'android-wear'),
  ]
  const pick = (p: Parameters<typeof purposeFilter>[0]) => devices.filter(purposeFilter(p).device).map((d) => d.id)

  it('电视只留 tv 档，手表/平板不混进来', () => expect(pick('tv')).toEqual(['tv_4k']))
  it('手机排除平板，也排除一切带 tag 的异形档', () => expect(pick('phone')).toEqual(['pixel_9']))
  it('平板只留平板', () => expect(pick('tablet')).toEqual(['pixel_tablet']))
  it('自定义全都给', () => expect(pick('custom')).toHaveLength(4))

  it('镜像同理：手机档不给 tv/wear/automotive/desktop/xr', () => {
    const imgs = [img('google_apis'), img('android-tv'), img('android-wear'), img('google_apis_playstore')]
    expect(imgs.filter(purposeFilter('phone').image).map((i) => i.variant))
      .toEqual(['google_apis', 'google_apis_playstore'])
    expect(imgs.filter(purposeFilter('tv').image).map((i) => i.variant)).toEqual(['android-tv'])
  })
})

describe('AVD 名', () => {
  it('空格和中文就地转掉 —— avdmanager 不收，留给后端只会换来一句报错', () => {
    expect(slugAvdName('小慧 TV 4K')).toBe('TV_4K')
    expect(slugAvdName('xh tv4k')).toBe('xh_tv4k')
    expect(slugAvdName('__a.b-c__')).toBe('a.b-c')
  })
})
