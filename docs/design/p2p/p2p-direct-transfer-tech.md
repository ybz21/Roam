# 技术拆解：P2P 直连文件传输（MVP）

> 配套 [设计](./p2p-direct-transfer.md) 与 [里程碑拆解](./p2p-direct-transfer-mvp-plan.md)。
> 本文是**落到真实代码**的实现拆解：包结构、类型/签名、pion & 浏览器 WebRTC 的具体调用、信令如何挂进现有鉴权 WS、线协议、时序、以及每个改动点的 `file:line`。
> 范围同 MVP：浏览器 + DataChannel + STUN(+IPv6/UPnP) + 回退 frp + 单文件下载 + goodput/埋点；**每下载一个独立 PC**。

---

## 0. 现有代码事实（本拆解据此设计）

| 事实 | 位置 | 对我们的含义 |
| --- | --- | --- |
| 鉴权 = cookie `ttmux_session`，由 `a.Middleware()` 在 `/api` 组统一校验 | `server.go:104`、`auth.go:144-153` | **信令 WS 挂 `g` 组即自动鉴权**，handler 内不用再验；浏览器 WS/fetch 同源自动带 cookie，无需 token |
| WS 库 = `gorilla/websocket`，写非线程安全需串行 | `browser/screencast.go:31,203` | 信令 WS 复用同款 upgrader；写用 mutex 串行 |
| 二进制帧 + 信用背压范式 | `screencast.go:149,485` | 传输层背压照搬（`bufferedAmount` 版） |
| `FileDownload` 校验只有 `Clean`+`IsAbs`+`Stat` | `api/files.go:649-656` | 抽成共享 `ValidateDownloadPath`，HTTP 与 P2P **共用** |
| `serveAttachment`/`contentDisposition` | `files.go:350-364` | 回退路径与元数据复用 |
| 配置 = `Web` 结构体 + yaml tag + `applyEnv()`/`firstEnv("ROAM_..","TTMUX_..")` | `config/config.go:23-32,99-129` | 新增 `P2P*` 字段照此，env 主键 `ROAM_WEB_P2P_*`、回退 `TTMUX_WEB_P2P_*` |
| 前端 api 助手 + cookie 自动 | `frontend/src/api.ts:8-31` | 回退 fetch/信令 WS 免手动鉴权 |
| 现有下载入口 | `FileBrowser.tsx:546 downloadEntry` | 改成状态机入口 |
| 前端 WS 客户端范式 | `BrowserView.tsx:319-382` | 信令 WS 照抄 URL/onmessage 结构 |

> **env 命名校正**：设计 §5.6 用的 `TTMUX_P2P_*` 是简写；实际按 config 约定应为 `ROAM_WEB_P2P_*`（主）/ `TTMUX_WEB_P2P_*`（回退）。

---

## 1. 包/模块结构

```
backend/p2p/                       前端 frontend/src/p2p/
├── signal.go    信令 WS + 消息编解码      ├── signaling.ts   连 /api/p2p/signal
├── manager.go   PC 生命周期 + transfer 表  ├── download.ts    状态机 + 收流落盘 + 回退
├── ice.go       SettingEngine(UDPMux/STUN/  ├── stats.ts       goodput/RTT 采样
│                IPv6/mDNS/NAT1To1)          ├── types.ts       信令/控制帧类型
├── transfer.go  OnDataChannel + 分块发送     └── labels.ts      path→i18n 标签
├── stats.go     选中候选对 → path 分类
└── upnp.go      UPnP/NAT-PMP 端口映射
backend/api/files.go   抽出 ValidateDownloadPath（HTTP+P2P 共用）
backend/server/server.go  注册 g.GET("/p2p/signal", p2p.SignalHandler)
backend/config/config.go  Web 结构体加 P2P* 字段 + applyEnv
```

---

## 2. 线协议

### 2.1 信令（JSON，走 `/api/p2p/signal` WS，每消息带 `transferId`）

见设计 §5.1。类型集中在 `types.ts` / `signal.go`：

```go
type SignalMsg struct {
    Type       string           `json:"type"`       // offer|answer|ice|connected|fallback|cancel
    TransferID string           `json:"transferId"`
    SDP        string           `json:"sdp,omitempty"`
    Candidate  *json.RawMessage `json:"candidate,omitempty"`
    Transfer   *TransferReq     `json:"transfer,omitempty"`  // 仅 offer
    Path       string           `json:"path,omitempty"`      // connected: ipv6-direct|upnp|stun|lan
    Local      *CandInfo        `json:"local,omitempty"`
    Remote     *CandInfo        `json:"remote,omitempty"`
    RTTMs      int              `json:"rttMs,omitempty"`
    Reason     string           `json:"reason,omitempty"`    // fallback|cancel
}
type TransferReq struct{ Path, Op string }         // {path:/abs, op:"download"}
type CandInfo   struct{ Type, Family, Addr string } // srflx|host|prflx, ipv4|ipv6
```

### 2.2 传输（DataChannel 之上，**保留消息边界**）

```
控制帧 = text message（JSON）：
  {"t":"meta","transferId":"t1","name":"a.bin","size":1234567,"mtime":169..,"chunk":16384}
  {"t":"eof"}
  {"t":"error","msg":"..."}
数据帧 = binary message（一条 message 一帧）：
  [seq:u32 LE][payload ≤ 16384B]
```

---

## 3. 后端实现

### 3.1 路由 + 信令 WS（`server.go` / `signal.go`）

```go
// server.go —— 挂到已鉴权的 g 组，cookie 自动校验
g.GET("/p2p/signal", p2p.NewHub(cfg, api).SignalHandler)

// signal.go
func (h *Hub) SignalHandler(c *gin.Context) {
    ws, err := upgrader.Upgrade(c.Writer, c.Request, nil) // 复用 screencast 同款 upgrader
    if err != nil { return }
    defer ws.Close()
    var wmu sync.Mutex // gorilla 写串行
    send := func(m SignalMsg) error {
        wmu.Lock(); defer wmu.Unlock()
        return ws.WriteJSON(m)
    }
    sess := h.newSession(send)          // 一条 WS 可服务多个 transferId
    defer sess.closeAll()
    for {
        var m SignalMsg
        if err := ws.ReadJSON(&m); err != nil { return }
        if len(m.Type) == 0 { continue }
        sess.onSignal(m)                // 见 manager.go
    }
}
```

### 3.2 PC 生命周期 + transfer 表（`manager.go`）

```go
type transfer struct {
    id     string
    pc     *webrtc.PeerConnection
    cancel context.CancelFunc  // 取消文件读取 goroutine
    done   int32               // 原子终结标志，回退/取消后忽略后续
}

func (s *session) onSignal(m SignalMsg) {
    switch m.Type {
    case "offer":
        t := s.startTransfer(m)         // 建 PC、设远端 SDP、回 answer
    case "ice":
        s.get(m.TransferID)?.pc.AddICECandidate(parse(m.Candidate))
    case "cancel":
        s.finish(m.TransferID)          // atomic done=1；cancel()；pc.Close()
    }
}

func (s *session) startTransfer(m SignalMsg) {
    api := s.hub.webrtcAPI            // 见 ice.go，全局复用 SettingEngine
    pc, _ := api.NewPeerConnection(s.hub.rtcConfig)
    ctx, cancel := context.WithCancel(context.Background())
    t := &transfer{id: m.TransferID, pc: pc, cancel: cancel}
    s.put(t)

    pc.OnICECandidate(func(c *webrtc.ICECandidate) {
        if c != nil { s.send(iceMsg(t.id, c.ToJSON())) }
    })
    pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
        switch st {
        case webrtc.PeerConnectionStateConnected:
            s.send(connectedMsg(t, classifyPath(pc))) // stats.go
        case webrtc.PeerConnectionStateFailed,
             webrtc.PeerConnectionStateClosed:
            s.finish(t.id)
        }
    })
    pc.OnDataChannel(func(dc *webrtc.DataChannel) {
        serveFile(ctx, dc, t, m.Transfer.Path)       // transfer.go
    })
    pc.SetRemoteDescription(webrtc.SessionDescription{Type: Offer, SDP: m.SDP})
    ans, _ := pc.CreateAnswer(nil)
    pc.SetLocalDescription(ans)
    s.send(answerMsg(t.id, ans.SDP))
    // 空闲超时：建 PC 后 N 秒无 DataChannel/无数据 → s.finish(t.id)
}
```

### 3.3 SettingEngine（`ice.go` + `upnp.go`）——**评审点1 的核心**

```go
func (h *Hub) buildAPI() *webrtc.API {
    se := webrtc.SettingEngine{}

    // 固定 UDP 端口 + UDPMux（前提：UPnP 端口一致才成立）
    port := h.cfg.Web.P2PUDPPort               // 0=随机
    if port > 0 {
        udpConn, _ := net.ListenUDP("udp", &net.UDPAddr{Port: port})
        se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, udpConn))
    }
    // IPv6：默认即收集；确保未被过滤
    se.SetNetworkTypes([]webrtc.NetworkType{
        webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6,
    })
    // 同网附赠：解析浏览器 .local mDNS candidate
    se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryAndGather)

    // UPnP：仅当 external==internal 才注入（否则端口错，不宣称）
    if h.cfg.Web.P2PUPnP && port > 0 {
        if extIP, ok := mapUPnP(port); ok {         // upnp.go：external port 必须==port
            se.SetNAT1To1IPs([]string{extIP}, webrtc.ICECandidateTypeSrflx)
        }
    }
    return webrtc.NewAPI(webrtc.WithSettingEngine(se))
}

// upnp.go：huin/goupnp（IGD）或 jackpal/go-nat-pmp
// 返回 (公网IP, true) 仅当把 external port 成功映射成 == 内部 port；否则 (_, false)
func mapUPnP(port int) (string, bool) { /* AddPortMapping(external=port, internal=port, "UDP") */ }
```

`rtcConfig`：

```go
h.rtcConfig = webrtc.Configuration{ICEServers: []webrtc.ICEServer{
    {URLs: h.cfg.Web.P2PICEServers}, // stun:<frps>:3478[,stun:google...]
}}
```

### 3.4 分块发送 + 背压 + 取消（`transfer.go`）

```go
func serveFile(ctx context.Context, dc *webrtc.DataChannel, t *transfer, rawPath string) {
    path, err := api.ValidateDownloadPath(rawPath) // ← 抽自 files.go，与 HTTP 同一函数
    if err != nil { dc.SendText(errFrame(err)); return }
    info, _ := os.Stat(path)
    if info.IsDir() { dc.SendText(errFrame("dir-not-supported")); return } // 目录二期

    const chunk = 16 * 1024
    const hiWater = 8 * 1024 * 1024
    dc.SetBufferedAmountLowThreshold(hiWater / 2)
    resume := make(chan struct{}, 1)
    dc.OnBufferedAmountLow(func() { select { case resume <- struct{}{}: default: } })

    dc.OnOpen(func() {
        f, _ := os.Open(path); defer f.Close()
        dc.SendText(metaFrame(t.id, info)) // name/size/mtime/chunk
        buf := make([]byte, chunk)
        var seq uint32
        for {
            if atomic.LoadInt32(&t.done) == 1 { return } // 回退/取消后停发
            select { case <-ctx.Done(): return; default: }
            n, e := f.Read(buf)
            if n > 0 {
                frame := make([]byte, 4+n)
                binary.LittleEndian.PutUint32(frame, seq); copy(frame[4:], buf[:n])
                if err := dc.Send(frame); err != nil { return }
                seq++
                for dc.BufferedAmount() > hiWater {   // 背压
                    select { case <-resume: case <-ctx.Done(): return }
                }
            }
            if e == io.EOF { dc.SendText(`{"t":"eof"}`); return }
            if e != nil { dc.SendText(errFrame(e)); return } // 源文件读错→前端回退
        }
    })
}
```

### 3.5 选中候选对分类（`stats.go`）——**评审点1 区分 UPnP/STUN**

```go
func classifyPath(pc *webrtc.PeerConnection) PathInfo {
    pair, _ := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
    l, r := pair.Local, pair.Remote
    switch {
    case l.Typ == host && isV6(l.Address): return PathInfo{"ipv6-direct", l, r}
    case l.Typ == host:                    return PathInfo{"lan", l, r}
    case l.Address == injectedUPnPIP:      return PathInfo{"upnp", l, r} // 比对注入映射地址
    case l.Typ == srflx:                   return PathInfo{"stun", l, r}
    }
    // rttMs 从 GetStats() 的 candidate-pair.currentRoundTripTime 取（仅诊断）
}
```

### 3.6 配置（`config.go`）

```go
// Web 结构体新增：
P2PEnabled    bool     `yaml:"p2p_enabled"`
P2PICEServers []string `yaml:"p2p_ice_servers"`
P2PIPv6       bool     `yaml:"p2p_ipv6"`
P2PUPnP       bool     `yaml:"p2p_upnp"`
P2PUDPPort    int      `yaml:"p2p_udp_port"`

// applyEnv 内（照 firstEnv/truthy/splitCSV 范式）：
if v := firstEnv("ROAM_WEB_P2P_ENABLE", "TTMUX_WEB_P2P_ENABLE"); v != "" { c.Web.P2PEnabled = truthy(v) }
if v := firstEnv("ROAM_WEB_P2P_ICE_SERVERS", "TTMUX_WEB_P2P_ICE_SERVERS"); v != "" { c.Web.P2PICEServers = splitCSV(v) }
if v := firstEnv("ROAM_WEB_P2P_IPV6", "TTMUX_WEB_P2P_IPV6"); v != "" { c.Web.P2PIPv6 = truthy(v) }
if v := firstEnv("ROAM_WEB_P2P_UPNP", "TTMUX_WEB_P2P_UPNP"); v != "" { c.Web.P2PUPnP = truthy(v) }
if v := firstEnv("ROAM_WEB_P2P_UDP_PORT", "TTMUX_WEB_P2P_UDP_PORT"); v != "" { c.Web.P2PUDPPort = atoiSafe(v) }
```

### 3.7 抽公共校验（`files.go`）

```go
// 抽出，FileDownload 与 P2P 都调（评审点4：两处权限完全一致）
func ValidateDownloadPath(raw string) (string, error) {
    p := filepath.Clean(raw)
    if p == "" || !filepath.IsAbs(p) { return "", ErrBadPath }
    if _, err := os.Stat(p); err != nil { return "", err }
    return p, nil
}
```

---

## 4. 前端实现

### 4.1 类型（`types.ts`）

```ts
type P2PState = 'idle'|'picking'|'negotiating'|'p2p'|'fallback'|'http'
interface Meta { t:'meta'; transferId:string; name:string; size:number; mtime:number; chunk:number }
```

### 4.2 信令（`signaling.ts`）——照 `BrowserView.tsx` 范式，cookie 自动带

```ts
export function openSignal(): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/p2p/signal`) // 同源带 cookie
  ws.binaryType = 'arraybuffer'
  return ws
}
```

### 4.3 状态机下载（`download.ts`）——**评审点2/3**

```ts
export async function download(target: FileTarget) {
  let state: P2PState = 'idle'
  const done = { flag: false }                     // 终结标志：忽略迟到 connected/数据

  // 1) picking —— 必须在点击的用户激活窗口内先弹（不能等 ICE）
  state = 'picking'
  let writable: FileSystemWritableFileStream
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: target.name })
    writable = await handle.createWritable()
  } catch { return }                               // 用户取消 → 结束

  const transferId = crypto.randomUUID()
  let written = 0                                   // goodput 基准（成功落盘字节）
  const finish = async () => { done.flag = true; await writable.close() }

  // 2) negotiating
  state = 'negotiating'
  const ws = openSignal()
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() })
  const dc = pc.createDataChannel('file', { ordered: true })
  dc.binaryType = 'arraybuffer'

  const fallbackTimer = setTimeout(() => toFallback('timeout'), 10_000) // 8–12s 灰度

  pc.onicecandidate = e => e.candidate && wsSend(ws, {type:'ice', transferId, candidate:e.candidate})
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toFallback('ice-failed')
  }
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.transferId !== transferId || done.flag) return   // 忽略迟到/串扰
    if (m.type === 'answer') pc.setRemoteDescription(m)
    if (m.type === 'ice') pc.addIceCandidate(m.candidate)
    if (m.type === 'connected') { state='p2p'; clearTimeout(fallbackTimer); ui.setPath(m.path) }
    if (m.type === 'fallback') toFallback(m.reason)
  }

  let expect = 0
  dc.onmessage = async ev => {
    if (done.flag) return
    if (typeof ev.data === 'string') {              // 控制帧
      const m = JSON.parse(ev.data)
      if (m.t === 'eof')  { clearTimeout(fallbackTimer); await finish(); ui.setDone() }
      if (m.t === 'error') toFallback('src-error')
      return
    }
    const view = new DataView(ev.data)              // [seq][payload]
    // seq 校验略；写盘算 goodput
    const payload = new Uint8Array(ev.data, 4)
    await writable.write(payload); written += payload.byteLength
    ui.setGoodput(written)                          // 每秒 delta 由 stats.ts 取
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  wsSend(ws, { type:'offer', transferId, sdp: offer.sdp, transfer:{ path: target.path, op:'download' }})

  // 3) 回退 —— 拆干净 + 通知后端 + 写入同一 handle，不二次下载
  async function toFallback(reason: string) {
    if (done.flag || state==='http') return
    clearTimeout(fallbackTimer)
    wsSend(ws, { type:'cancel', transferId, reason })
    dc.close(); pc.close(); ws.close(); done.flag = true   // 之后迟到消息全忽略
    state = 'http'
    const res = await fetch(`/api/file/download?path=${encodeURIComponent(target.path)}`) // cookie 自动
    await res.body!.pipeTo(writable)                       // ← 写入同一 writable
    ui.setPath('frp'); ui.setDone()
  }
}
```

### 4.4 goodput/RTT 采样（`stats.ts`）——**评审点5**

```ts
// 用户可见速率 = 落盘字节增量；candidate-pair 仅诊断
setInterval(() => {
  const now = written
  ui.setRate(now - lastWritten)          // goodput bytes/s
  lastWritten = now
  pc.getStats().then(rs => rs.forEach(r => {
    if (r.type==='candidate-pair' && r.nominated) ui.diag({ rttMs: r.currentRoundTripTime*1000 })
  }))
}, 1000)
```

### 4.5 接入 `FileBrowser.tsx`

```ts
const downloadEntry = (target: FileTarget) => {
  // 手机护栏（评审点/M4）：无 showSaveFilePicker 且大文件 → 直接系统下载
  if (!('showSaveFilePicker' in window) || (isMobile() && target.size > 50*1024*1024)) {
    return legacyAnchorDownload(target)   // 现有 a[download]，走 frp
  }
  return p2p.download(target)             // 状态机
}
```

---

## 5. 时序（下载）

```
浏览器                         frps(WS)                        pion 后端
  │ click                                                         │
  │ showSaveFilePicker() ✔（用户激活窗口内）                        │
  │ createPC + createDataChannel('file')                          │
  │ ── offer{transferId,sdp,path} ──▶│──────────────────────────▶ │ NewPeerConnection
  │ ◀───────── answer{sdp} ──────────│◀─────────────────────────  │ CreateAnswer
  │ ◀───▶ trickle ice ◀───▶          │        ◀───▶               │
  │           …… ICE 打洞(STUN/IPv6/UPnP)，直连建立，不经 frps ……   │
  │ ◀──── connected{path,rtt} ───────│◀─────────────────────────  │ OnConnected→classifyPath
  │ ◀════ meta / [seq]payload… ══════ DataChannel 直连 ═══════════ │ OnDataChannel→serveFile
  │ ◀════ eof ═══                                                  │
  │ writable.close(); UI=done                                      │
  └─（任一步失败/超时 8–12s）─▶ cancel → 拆PC → fetch 同 URL → pipeTo(同 writable)
```

---

## 6. 改动点清单（file:line）

| 文件 | 改动 |
| --- | --- |
| `backend/server/server.go:~261` | `g.GET("/p2p/signal", hub.SignalHandler)` |
| `backend/p2p/*.go` | 新增 6 文件（§1） |
| `backend/api/files.go:649` | 抽 `ValidateDownloadPath`，`FileDownload` 改调它 |
| `backend/config/config.go:23-32,99-129` | `Web` 加 5 字段 + `applyEnv` 5 行 |
| `backend/config/config.yaml.template` | 加 `p2p_*` 注释项 |
| `frontend/src/p2p/*.ts` | 新增 5 文件（§1） |
| `frontend/src/FileBrowser.tsx:546` | `downloadEntry` 改为状态机入口 + 手机护栏 |
| `frontend/src/i18n/*` | 新增文案 key（zh-CN/en-US，评审点10） |
| `docs/deploy/frp.md` | frps 开 STUN + 手动端口转发步骤 |
| `go.mod` | `github.com/pion/webrtc/v4`、UPnP 库 |

---

## 7. 逐里程碑的技术验证点

- **M0a**：`server.go` 挂信令 WS + `manager/ice` 最小版（STUN-only、随机数据 DC）；验 `PeerConnectionStateConnected` + `classifyPath` 打印。真实跨网跑通即过。
- **M0b**：`ice.go` UDPMux 固定端口 + `upnp.go`；**重点验 `mapUPnP` 的 external==internal**、`SetNAT1To1IPs` 后对端 `getStats` 里出现该 srflx 且被选中。IPv6 单独验 `NetworkTypeUDP6` 候选可达。
- **M1**：`ValidateDownloadPath` 抽取 + `transfer.go` 背压/取消 + 前端状态机；验超时回退**只有一次下载**、迟到 `connected` 被 `done.flag` 拦截、`cancel` 后端 `ctx` 停读。
- **M2**：`stats.go` 分类 + goodput UI + 埋点；验三路径标签正确、速率=落盘增量、灰度开关 `P2PEnabled` 生效。

---

## 8. 依赖与未决

- `github.com/pion/webrtc/v4`（连带 `pion/ice/v4`，`ice.MulticastDNSMode*`、UDPMux 均来自它）。
- UPnP 库二选一：`huin/goupnp`（IGD）/ `jackpal/go-nat-pmp`；**M0b 实测决定保留哪个或都留（先探测协议）**。
- **待 spike 确认**：`pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()` 在目标 pion 版本的可用性（若无则改用 `pc.GetStats()` 遍历 nominated candidate-pair）。
- STUN 服务：frps 上跑 `coturn --stun-only` 或 pion `turn` 库仅开 STUN（M0b 切换）。

---

## 9. 现成轮子（能复用就别自己糊）

**原则**：核心大件全部复用成熟库/官方示例；我们只写「胶水」（信令挂进现有 WS、分块状态机、回退写同一 handle、path 分类、i18n）——这部分是 app 专属且很小，没有现成轮子能直接套。

### 9.1 复用清单

| 关注点 | Go 后端 | TS 前端 | MVP 取舍 |
| --- | --- | --- | --- |
| WebRTC 核心 | **`github.com/pion/webrtc/v4`** | **原生 `RTCPeerConnection`** | ✅ 直接用 |
| 背压/flow-control | **pion 官方示例 `examples/data-channels-flow-control`**（就是 `SetBufferedAmountLowThreshold` 那套） | 原生 `bufferedAmountLow` 事件 | ✅ **照抄示例**，别自研背压 |
| NAT 端口映射（UPnP/NAT-PMP/PCP） | **`github.com/libp2p/go-nat`**（统一三协议自动发现，轻量）；退路 `huin/goupnp` + `jackpal/go-nat-pmp` | — | ✅ 用 go-nat，省掉手写协议探测（仍须校验 external==internal，评审点1） |
| STUN 服务（frps 上） | **coturn `--stun-only`**（运维成熟）或 **`pion/turn/v4`** 仅开 STUN（单 Go 二进制） | — | ✅ 复用，二选一 |
| STUN/ICE 客户端 | pion/ice（随 webrtc 带） | 浏览器内置 | ✅ 零额外 |
| 落盘（大文件流式） | — | 原生 **File System Access** + **`native-file-system-adapter`**（use-strict 的 FSA ponyfill，自动降级 StreamSaver/Blob）；或 **StreamSaver.js** | ✅ 用 ponyfill 一套 API 覆盖桌面/降级 |
| DataChannel 封装成流 | pion `DataChannel` 直接够用 | **`simple-peer`**（把 PC+DC 包成 Node 流；mature 但维护少，社区有 fork） | ⚠️ **可选**：MVP 原生就够；做「通用 DuplexTransport」时再考虑 |
| transferId / UUID | `crypto/rand` | 原生 **`crypto.randomUUID()`** | ✅ 零额外 |
| 信令通道 | 复用现有 gorilla WS + `a.Middleware()` | 复用 `api.ts` / 原生 WS | ✅ 不需要任何信令库（不用 PeerJS 自带信令服） |

### 9.2 「最大化复用」的另一条路：libp2p（远期评估，非 MVP）

如果将来真做**通用多路复用传输**（终端/镜像/文件共享一条连接），有个现成的重型轮子直接覆盖 NAT 穿透 + 多路复用 + 浏览器↔服务器 WebRTC：**`@libp2p/webrtc`（js-libp2p）+ `go-libp2p`**。它原生解决「浏览器连无 TLS 信任的服务器」、ICE 穿透、流多路复用。

- **诱人**：省掉我们自研的 DuplexTransport/多路复用/连接加密。
- **代价（诚实）**：前端 bundle 重、概念开销大（multiaddr / peerID / 连接加密）、服务端要跑 libp2p 节点、仍需 STUN + 信令/relay。**对 MVP 单文件下载是杀鸡用牛刀**。
- **结论**：**MVP 不碰**；仅当 §4 通用传输被 ROI 证明后，作为「自研 DuplexTransport vs 直接上 libp2p」的二选一再评估。

### 9.3 我们仍必须自己写的胶水（无现成轮子）

1. 信令消息编解码 + 挂进现有鉴权 WS（§3.1）。
2. 下载状态机 `idle→picking→negotiating→p2p/fallback→http`（§4.3，评审点2/3）——**这是 app 逻辑，任何库都不会替你做「picker 先行 + 回退写同一 handle + 忽略迟到 connected」**。
3. 控制帧/数据帧协议（§2.2）——若用 simple-peer/libp2p 的流则可省，MVP 原生下自写（很薄）。
4. path 分类 + goodput + i18n（§3.5/§4.4/评审点5/10）。

来源：[pion data-channels-flow-control 示例](https://github.com/pion/webrtc/tree/master/examples/data-channels-flow-control) · [libp2p/go-nat](https://github.com/libp2p/go-nat) · [go-libp2p NAT 子包](https://github.com/libp2p/go-libp2p) · [feross/simple-peer](https://github.com/feross/simple-peer) · [@libp2p/webrtc](https://github.com/libp2p/js-libp2p-webrtc) · [File System Access ponyfill](https://github.com/use-strict/file-system-access)
