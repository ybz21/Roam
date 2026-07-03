// 与后端 /api 通信的薄封装；401 时触发回调（跳登录）

let onUnauth: () => void = () => {}
export function setUnauthorizedHandler(f: () => void) {
  onUnauth = f
}

export async function api(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // 移动端(Safari/WebView)会对无 Cache-Control 的 GET 做启发式缓存，导致文件实时重载
    // 轮询的 /file/stat 一直拿到旧 mtime → 不刷新。强制不走缓存，每次真打网络。
    cache: 'no-store',
  })
  if (r.status === 401) {
    onUnauth()
    throw new Error('UNAUTHORIZED')
  }
  const ct = r.headers.get('content-type') || ''
  const data = ct.includes('json') ? await r.json() : await r.text()
  if (!r.ok) {
    const errObj = data?.error || {}
    const msg = errObj.message || errObj.code || 'HTTP ' + r.status
    const err = new Error(msg) as Error & { apiError?: Record<string, any> }
    err.apiError = errObj
    throw err
  }
  return data
}

// 上传文件到指定目录（multipart）。返回 { dir, saved: 绝对路径[] }。
export async function upload(dir: string, files: FileList | File[]): Promise<{ dir: string; saved: string[] }> {
  const form = new FormData()
  form.append('dir', dir)
  // Go 的 multipart 会用 filepath.Base 抹掉上传文件名里的路径，所以文件夹层级要靠
  // 独立的 paths 字段平行传：第 i 个 file 对应第 i 个 path(相对路径，普通文件为空)。
  Array.from(files).forEach((f) => {
    form.append('files', f)
    form.append('paths', (f as any).webkitRelativePath || '')
  })
  const r = await fetch('/api/upload', { method: 'POST', body: form })
  if (r.status === 401) { onUnauth(); throw new Error('UNAUTHORIZED') }
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error?.message || data?.error?.code || 'HTTP ' + r.status)
  return data.data
}

// 从剪贴板 Blob 创建带时间戳文件名的 File，用于粘贴图片后上传。
export function makeClipboardImageFile(blob: Blob, mime: string, index: number): File {
  const sub = mime.split('/')[1] || 'png'
  const ext = sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const suffix = index > 0 ? `-${index + 1}` : ''
  return new File([blob], `clipboard-${ts}${suffix}.${ext}`, { type: mime })
}

// 上传录音(WAV)做语音识别，返回识别出的文本。服务商与密钥由后端配置。
export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData()
  form.append('audio', audio, 'audio.wav')
  const r = await fetch('/api/speech/transcribe', { method: 'POST', body: form })
  if (r.status === 401) { onUnauth(); throw new Error('UNAUTHORIZED') }
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error?.message || data?.error?.code || 'HTTP ' + r.status)
  return data?.data?.text || ''
}
