// 从直连那条路取「某个文件的某一段」。后端在 backend/p2p/bytes.go。
//
// 为什么要有这一层：图片、视频、PDF、Office 预览全都是 `<img src>` / `<video src>` /
// iframe 直接打 /api/file/raw，那是经中心/frp 转发的普通 HTTP（实测 0.3–0.4 MB/s）。
// 这里把「一段字节」做成可以被 Service Worker 当作 fetch 响应体的东西，那些标签
// 一行都不用改（见 file-bytes-sw.ts）。
import { connect, holdMediaFor, whenMediaReady } from './transport'
import { parseDataFrame, SeqValidator } from './download-proto'

export interface BytesMeta {
  name: string
  /** 整个文件多大——206 的 Content-Range 要用，少了它浏览器不让拖进度条 */
  size: number
  offset: number
  /** 这一段有多少字节 */
  length: number
  mtime: number
  contentType: string
}

export interface BytesRange {
  offset?: number
  /** 0/缺省 = 从 offset 一直到文件末尾 */
  length?: number
  signal?: AbortSignal
  /** 直连还没建起来时最多等多久（毫秒）。0=不等，直接判不可用让调用方走 HTTP */
  waitMs?: number
}

/** meta 迟迟不来就认栽走 HTTP：卡在这儿等于让一张图永远转圈 */
const META_TIMEOUT_MS = 4000
/** 一次字节请求之后，链路再留这么久（翻下一张图就不用重新打洞了） */
const HOLD_LINK_MS = 60_000

/**
 * 取一段字节。返回 meta 和一条可读流；任何一步不成就 reject，调用方去走 HTTP。
 *
 * 流没有反压：DataChannel 收到就 enqueue，消费慢了只会堆在流的内部队列里。
 * 对「一段 Range」（几 MB）是合适的；真要整份大文件还是走下载那条路（download.ts）。
 */
export async function readFileRange(path: string, opts: BytesRange = {}): Promise<{ meta: BytesMeta; stream: ReadableStream<Uint8Array> }> {
  holdMediaFor(HOLD_LINK_MS)
  if (opts.waitMs) await whenMediaReady(opts.waitMs)
  return new Promise((resolve, reject) => {
    const tp = connect('bytes')
    if (tp.kind !== 'p2p') { tp.close(); reject(new Error('p2p-unavailable')); return }

    let settled = false
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    const seq = new SeqValidator()
    let got = 0
    let meta: BytesMeta | null = null

    const fail = (why: string) => {
      if (!settled) { settled = true; reject(new Error(why)) }
      try { ctrl?.error(new Error(why)) } catch { /* 已经关了 */ }
      ctrl = null
      cleanup()
    }
    const timer = setTimeout(() => fail('meta-timeout'), META_TIMEOUT_MS)
    const onAbort = () => fail('aborted')
    const cleanup = () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try { tp.close() } catch { /* 已经关了 */ }
    }
    opts.signal?.addEventListener('abort', onAbort)

    tp.onopen = () => {
      tp.send(JSON.stringify({ path, offset: opts.offset ?? 0, length: opts.length ?? 0 }))
    }
    tp.onclose = () => {
      // eof 之前断了 = 半截数据。宁可让调用方回退去走 HTTP，也不能把半个文件当成功交出去。
      if (!settled) fail('closed-before-meta')
      else if (ctrl) fail('closed-before-eof')
    }
    tp.onmessage = (d) => {
      if (typeof d === 'string') {
        let m: { t?: string; msg?: string } & Partial<BytesMeta>
        try { m = JSON.parse(d) } catch { fail('bad-frame'); return }
        if (m.t === 'error') { fail(m.msg || 'server-error'); return }
        if (m.t === 'meta') {
          clearTimeout(timer)
          meta = {
            name: m.name || '', size: m.size ?? 0, offset: m.offset ?? 0,
            length: m.length ?? 0, mtime: m.mtime ?? 0, contentType: m.contentType || 'application/octet-stream',
          }
          settled = true
          resolve({
            meta,
            stream: new ReadableStream<Uint8Array>({
              start(c) { ctrl = c },
              cancel() { cleanup() }, // 浏览器不要了（拖进度条/关页面）→ 关通道，让后端停发
            }),
          })
          return
        }
        if (m.t === 'eof') {
          if (meta && got !== meta.length) { fail('size-mismatch'); return }
          try { ctrl?.close() } catch { /* 已经关了 */ }
          ctrl = null
          cleanup()
        }
        return
      }
      // 数据帧：[seq:u32 LE][payload]，seq 必须从 0 连续递增，缺号/乱序一律判失败
      let frame
      try { frame = parseDataFrame(d) } catch { fail('bad-data-frame'); return }
      const bad = seq.check(frame.seq)
      if (bad) { fail(bad); return }
      got += frame.payload.byteLength
      try { ctrl?.enqueue(frame.payload) } catch { fail('enqueue-failed') }
    }
  })
}
