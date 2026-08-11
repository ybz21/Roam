// 懒加载 chunk 的重试外壳。
//
// 为什么需要：自签 HTTPS 下，Chrome 的「继续前往」只对**已经建立的那条连接**放行。
// 懒加载会为并行取 chunk 开新的 TLS 连接，新连接照样验证证书、照样被拒——于是
// 同一秒里能看到六次 `remote error: tls: unknown certificate`（中心日志实测），
// 而页面上就是那句「组件加载失败」。命中连接复用时一切正常，开新连接就翻车，
// 所以它表现为**时好时坏**，点一下「重试」又往往就好了。
//
// 根治办法是信任那张 CA（控制台 设置 → 安全 → 下载证书，或直接取 /cert.crt）。
// 但「一条连接被拒 = 整页功能打不开」本身就太脆：这里退避重试两次，把偶发的握手失败
// 变成一次看不见的停顿。真正的失败（chunk 被删、断网）仍会抛出去给 ErrorBoundary。
//
// 不缓存失败的 Promise：React.lazy 会记住 rejected 的那次，重试必须发生在它里面。
import { lazy, type ComponentType } from 'react'

const DELAYS = [250, 900] // 两次退避：够跨过一次握手抖动，又不至于让用户干等

export function lazyRetry<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    let last: unknown
    for (let i = 0; i <= DELAYS.length; i++) {
      try {
        return await load()
      } catch (e) {
        last = e
        if (i < DELAYS.length) await new Promise((r) => setTimeout(r, DELAYS[i]))
      }
    }
    throw last
  })
}
