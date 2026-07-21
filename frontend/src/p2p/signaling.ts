// 信令 WS：连 /api/p2p/signal，照 BrowserView.tsx 的客户端范式。
// 同源 WS 自动带 cookie（ttmux_session），后端在 /api 组统一鉴权，无需手动带 token。

export function openSignal(): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/p2p/signal`)
  ws.binaryType = 'arraybuffer'
  return ws
}
