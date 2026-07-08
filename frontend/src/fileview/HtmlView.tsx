// HTML 展示：不在前端拼 DOM，直接 iframe 后端服务代理(/api/file/raw 以 text/html
// 直出)，脚本/样式按原样运行。key 绑 mtime → 文件被外部(cc/codex)改动时 iframe 自动重载。
export function HtmlView({ rawUrl, name, mtime, height }: {
  rawUrl: string
  name: string
  mtime?: number
  height: string
}) {
  return (
    <iframe key={mtime} title={name} src={rawUrl} style={{ display: 'block', width: '100%', height, border: 0, background: '#fff' }} />
  )
}
