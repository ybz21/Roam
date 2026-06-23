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
  })
  if (r.status === 401) {
    onUnauth()
    throw new Error('UNAUTHORIZED')
  }
  const ct = r.headers.get('content-type') || ''
  const data = ct.includes('json') ? await r.json() : await r.text()
  if (!r.ok) {
    const msg = data?.error?.message || data?.error?.code || 'HTTP ' + r.status
    throw new Error(msg)
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
