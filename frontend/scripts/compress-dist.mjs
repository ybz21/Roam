// 构建后预压缩 dist 静态产物（nginx gzip_static/brotli_static 模式）：
// 为可压缩文件生成 .br + .gz 旁路文件，后端按 Accept-Encoding 择优直接下发
// （br 比 gzip 再小 15~20%，浏览器仅在 HTTPS 下声明支持；gzip 兜底），
// 免去每次请求现压的 CPU 开销。跳过压缩收益差的格式（woff2/png/webp 本身已压缩）。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

const gzip = promisify(zlib.gzip)
const brotli = promisify(zlib.brotliCompress)
const DIST = path.resolve(process.cwd(), 'dist')
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt|ttf)$/

async function* walk(dir) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else yield p
  }
}

let count = 0
let savedGz = 0
let savedBr = 0
for await (const file of walk(DIST)) {
  if (!COMPRESSIBLE.test(file)) continue
  const raw = await fs.readFile(file)
  if (raw.length < 1024) continue // 太小不值得，省往返头开销有限
  const gz = await gzip(raw, { level: 9 })
  if (gz.length >= raw.length * 0.9) continue // 压不动的不生成
  const br = await brotli(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  })
  await fs.writeFile(file + '.gz', gz)
  await fs.writeFile(file + '.br', br)
  count++
  savedGz += raw.length - gz.length
  savedBr += raw.length - br.length
}
const mb = (n) => (n / 1024 / 1024).toFixed(1)
console.log(`compress-dist: ${count} 个文件生成 .br/.gz，较原文件省 ${mb(savedBr)}/${mb(savedGz)} MB 传输量`)
