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
    throw new Error('未登录')
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
  Array.from(files).forEach((f) => form.append('files', f))
  const r = await fetch('/api/upload', { method: 'POST', body: form })
  if (r.status === 401) { onUnauth(); throw new Error('未登录') }
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error?.message || data?.error?.code || 'HTTP ' + r.status)
  return data.data
}
