// 路径的两个纯字符串操作。走字符串而不是 URL/path 库：这里的路径是**服务器上的**
// POSIX 路径，浏览器端不该拿本地平台的分隔符去解释它。

export function pathDirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function pathBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || 'file'
}
