# 设计：P2P 直连传输——Roam 的通用底层信道（绕过 frp 中转带宽）

> 状态：设计稿（调研 + 方案），未实现。
> **评审结论（已采纳）**：方向正确，**批准 spike；暂缓按本文档直接实施完整 MVP**，须先落实下述 10 项修正（见各节 `[评审修正]` 标注）。通用传输抽象**延后到真实数据证明 ROI 之后**再做；MVP 阶段**每次下载一个独立 PC**，不承诺单 PC 同时承载终端/镜像/文件。
> 定位：目标形态是终端/镜像/手机/文件/控制**共享的一条直连传输**；frp 退居信令 + 兜底。但这是**远期**；**文件下载是唯一的 MVP 落地消费者（proving ground）**。
> 关联：[docs/deploy/frp.md](../../deploy/frp.md)、[MVP 拆解](./p2p-direct-transfer-mvp-plan.md)、[技术拆解](./p2p-direct-transfer-tech.md)、后端 `backend/api/files.go`、前端 `frontend/src/FileBrowser.tsx`。

## 1. 问题

Roam 部署在**内网/无公网 IP** 的机器上，靠 frp（`frpc → 公网 frps → 本机 127.0.0.1:13579`）暴露到公网。所有流量都经公网 frps 中转。

浏览器下载文件走 `GET /api/file/download?path=...`（`backend/api/files.go:649` 起，单文件直传、目录打 zip 流），整条链路是：

```
浏览器  ──HTTPS──▶  公网 frps（云服务器，带宽受限）  ──TCP──▶  本机 Roam 后端
```

瓶颈就是**云服务器那段带宽**。文件再大，也被 frps 的上行/中转带宽卡死，与浏览器和本机各自的真实网速无关。很多时候浏览器和本机其实在**同一局域网**或都在带宽很好的网络里，只是因为「没有公网 IP」才被迫绕云。

目标：双方已经通过 frp 建立了信令通道（现有的 WebSocket），在此之上协商出一条**不经过 frps 的直连数据信道**来传文件；直连不通时优雅回退到现有 frp 下载。

## 2. 结论（先给答案）

> **目标场景锁定：跨网（双方不在同一 LAN）。** 同网直连是自然附赠的子集，但不是本设计的重点。

**已定的取舍**（本次评审拍板）：

- **客户端 = 浏览器**，沿用现有网页文件浏览器 → P2P 传输**只能是 WebRTC DataChannel**（浏览器不能开裸 UDP / 自定义 QUIC）。
- **零带宽成本 = 纯 STUN 打洞，不建 TURN**。数据面全程直连、不经任何中转；打不通就**回退现有 `/api/file/download`**（慢速 frp）。因此 P2P 是纯优化项，不引入「传不了」的新风险。

技术栈：

- 浏览器端原生 WebRTC；Go 后端用 [pion/webrtc](https://github.com/pion/webrtc)（纯 Go、零 CGO、跨平台，与现有二进制发布方式兼容）。
- **信令**复用现有 WebSocket-over-frp 通道，只传 SDP offer/answer 和 ICE candidate（几 KB），中转带宽压力可忽略。
- **数据面**走 UDP/DTLS-SCTP，ICE 协商直连，**完全不经过 frps**。

**跨网成败的核心变量 = 服务器那端的 NAT**（它蹲在用户内网/机房，最不可控）。为在零带宽成本下把跨网成功率拉满，采用四条**都不花带宽钱**的杠杆，详见 [§4.1 跨网穿透 playbook](#41-跨网穿透-playbook零成本)：

1. **IPv6 直连优先**——两端都有公网 IPv6 时无需 NAT 打洞，**显著提高**成功率，专治 IPv4 侧的 CGNAT/对称 NAT（注意：IPv6 防火墙仍可能拦截入站 UDP，不是必成）。
2. **服务器侧 UPnP/NAT-PMP 自动端口映射**——把 NAT 后服务器变成较稳定端点，是服务器端能主动控制的最大免费加成（受限于 §4.1-2 的端口一致性前提）。
3. **STUN 架在 frps 公网机上**——现成公网 IP、流量≈0，免依赖 Google。
4. **可选手动 UDP 端口转发**（文档指引）——能转发时**显著提高**跨网成功率，零成本（若上游防火墙/CGNAT 仍拦截则无效）。

诚实下限：服务器只在**纯 CGNAT-IPv4 且无 IPv6**时，无 TURN 打洞大概率失败 → 回退 frp。这是拓扑硬约束、零成本无解，不是设计缺陷。

为什么这条路成立：frp 之所以存在，正是因为本机在 NAT 后、无公网 IP。而「浏览器 ↔ NAT 后服务器」的直连，正是 WebRTC/ICE 被设计来解决的场景。信令我们已经有了（frp WS），缺的只是数据面的打洞。

## 3. 备选方案对比

| 方案 | 覆盖场景 | 复杂度 | 结论 |
| --- | --- | --- | --- |
| **A. WebRTC DataChannel + STUN（采用）** | 跨网打洞为主，同网附赠 | 中（引 pion，做信令+分块协议） | ✅ 采用；浏览器端唯一可行的 P2P 传输 |
| B. 仅局域网直连 HTTP | 只覆盖同网 | 低 | ❌ 不解决跨网这个核心目标；且有自签证书/混合内容坑 |
| C. TURN 中转 | 全场景 | 中 | ❌ 已否决：零带宽成本约束下不建 TURN（同机无意义、异机付带宽费） |
| D. 自定义 UDP 打洞 | 同 A | 高 | ❌ 浏览器不能开裸 UDP，客户端形态锁死浏览器时不可行 |

**方案 B 为什么不做**：本设计核心目标就是跨网，局域网直连解决不了它；且 HTTPS 页面 `fetch` LAN IP 有混合内容/自签证书坑。WebRTC 的 host candidate 已把同网直连作为附赠子集覆盖，数据走 DTLS、不受同源/混合内容策略约束。

### 关于业界穿透成功率（调研）

- 近年 Chrome UMA 实测：开放消费网络下直连（host+srflx）约 75–90%，其余 10–25% 需 relay。全锥/端口受限锥 NAT 打洞稳定成功；**双方同时对称 NAT 时打洞失败**。
- **注意**：上述是「消费级双端」统计，**不能直接套到我们头上**——我们一端是蹲机房/内网的服务器，其 NAT 往往比家宽更 hostile（对称/CGNAT 更常见），跨网直连率可能明显偏低。这正是 §4.1 用 IPv6 + UPnP 两条杠杆去补的原因。
- 缓冲垫：**失败可无损回退 frp**，所以不追求 100% 直连率，量到多少赚多少。

来源：[pion/webrtc](https://github.com/pion/webrtc)、[pion/datachannel](https://github.com/pion/datachannel)、[WebRTC NAT 穿透原理](https://www.eleshine-tech.com/webrtc-nat-traversal-stun-turn-hole-punching-guide.html)、[GetStream STUN/TURN](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/)。

## 4. 架构

> **定位升级（远期）**：P2P 目标是 Roam 的**通用底层传输**——终端、浏览器镜像、手机镜像、文件、控制类流量共享同一条直连，frp 退居「信令 + 兜底」。下图是**远期形态**。
>
> **[评审修正 · 点6]** MVP **不实现共享 PC**：**每次文件下载建一个独立的 PeerConnection**，用完即拆。原因——多流共享一个 SCTP association = **共享拥塞控制**，大文件传输可能拖垮实时的终端/镜像流（association 级队头阻塞 + 争抢窗口）。**是否共享 PC、以及大文件对实时流的影响，必须在 ROI 证明后专门压测再决定**。下面的通道表/DuplexTransport 抽象是远期蓝图，不在 MVP 范围。

```
        客户端(浏览器 / 手机 WebView)              服务器(Roam 后端, 在 NAT 后)
┌─ 消费者层(现有功能, 改动最小) ─────────┐   ┌─ 同一批 handler(改动最小) ────────┐
│ 终端 · 浏览器镜像 · 手机镜像           │   │ 终端 · 镜像 · 手机 · 文件 · API   │
│ 文件 · REST控制 · 语音/剪贴板         │   │                                   │
└──────────────┬────────────────────────┘   └──────────────┬────────────────────┘
      connect(service) 只认一个抽象               dispatch(label) 分派回原 handler
┌──────────────▼────────────────────────┐   ┌──────────────▼────────────────────┐
│ 传输抽象 DuplexTransport               │   │ 传输抽象(对称)                     │
│ (send/onmessage/close ≈ 一个 WebSocket)│   │                                    │
│ 工厂: PC 已连→P2P; 否则/失败→frp       │   │                                    │
└───────┬────────────────────┬───────────┘   └──────┬───────────────────┬─────────┘
   主路径│                兜底│                  主路径│               兜底│
┌────────▼─────────┐  ┌───────▼────────┐   ┌─────────▼────────┐  ┌──────▼────────┐
│ P2P 多路复用      │  │ frp wss/https  │   │ pion 多路复用     │  │ frp wss/https │
│ 1×RTCPeerConn     │  │ (现状不变)     │   │ 1×PeerConnection  │  │ (现状不变)    │
│ 多条 DataChannel  │  └───────┬────────┘   │ OnDataChannel     │  └──────┬────────┘
└────────┬─────────┘          │            └─────────┬────────┘         │
         │                    │                      │                  │
         │  ══════ WebRTC 直连数据面 (不经 frps) ══════                  │
         │                    │                      │                  │
         │              ┌─────▼──────────────────────▼─────┐            │
         │              │      公网 frps (云服务器, 瓶颈)   │◀──信令─────┤
         │              │  · 信令 SDP/ICE (几 KB)           │  SDP/ICE   │
         │              │  · 兜底流量中转                   │            │
         │              └───────────────────────────────────┘            │
         └────────── NAT 穿透候选喂给唯一的 PC ───────────────────────────┘
            IPv6 host(专治CGNAT) / UPnP srflx / STUN@frps / LAN host
```

**多路复用通道表**（一个 PeerConnection 上开多条 DataChannel，每条按流量特性配可靠性——这是相比现状「全走 frp 有序 TCP」的额外增益）：

| DataChannel (label) | 可靠性 | 承载 | 相比现状增益 |
| --- | --- | --- | --- |
| `term:<id>` | 可靠·有序 | 终端 I/O | 直连低延迟 |
| `screencast` | **不可靠·无序**（`ordered:false, maxRetransmits:0`） | 浏览器镜像帧 | 丢帧而非队头阻塞，实时性↑ |
| `phone` | **不可靠·无序** | 手机镜像帧 | 同上 |
| `file:<id>` | 可靠·有序 + 背压 | 文件传输 | 绕开 frps 带宽 |
| `api/ctrl` | 可靠·有序 | REST/控制/剪贴板 | 可选，轻量也可留 frp |

**三个架构要点**

1. **一个 PeerConnection、多条 DataChannel**：NAT 穿透（§4.1）只做一次，所有功能共享；每条通道独立配可靠性/有序性。
2. **DuplexTransport 抽象（伪 WebSocket）**：功能层几乎不改——现有 `new WebSocket(...)` 换成 `connect(service)`，工厂决定走 P2P 还是 frp；服务端 `OnDataChannel` 按 label 把流分派回**原有 handler**（handler 只面对一个 `send/recv/close` 接口，不感知底层是 P2P 还是 frp）。
3. **按服务独立兜底**：某条通道挂了只有那条回退 frp，不影响其他；整个 PC 建不起来就全体走 frp，行为等同现状——**P2P 始终是纯增益、零新增风险**。

信令与穿透（不变）：信令走现有 frp WS（可新增 `/api/p2p/signal` 或复用会话 WS），只传 SDP/ICE 几 KB；数据面 SCTP-over-DTLS-over-UDP 点对点、不经 frps；穿透候选见 §4.1。

### 4.1 跨网穿透 playbook（零成本）

不建 TURN、不花带宽钱的前提下，按下列顺序把跨网直连率拉满。ICE 会把这些 candidate 一起收集、并行连通性检测、择优胜出：

1. **IPv6 host candidate（最优先，专治 CGNAT）**
   - 两端只要都有公网 IPv6，就**没有 NAT**，直连天然成立、零成本、无需打洞。这恰好救掉 IPv4 侧最难的运营商 CGNAT / 对称 NAT。
   - pion 默认收集 IPv6 host candidate；确保服务器监听 `::`、且 `TTMUX_P2P_ENABLE_IPV6=1`。浏览器原生收集 v6，无需额外工作。
   - 运维前置：服务器所在网络需有可路由的全局 IPv6（`ip -6 addr` 能看到非 `fe80`/非 ULA 地址）。

2. **服务器侧 UPnP / NAT-PMP / PCP 端口映射（服务器端最大免费加成）**
   - **[评审修正 · 点1] 端口必须一致，否则不能宣称 candidate 可达**：pion `SetNAT1To1IPs` **只替换 candidate 里的 IP，不改端口**——它无法表达「外部端口 ≠ ICE 本地端口」。UPnP/NAT-PMP 映射出的 external port 常常和内部端口不同。若直接用 `SetNAT1To1IPs(公网IP, srflx)`，广播出去的 `公网IP:本地端口` 是**错的、打不通**。
   - **正确做法**：先用**固定 UDP 端口 + UDPMux**（`SettingEngine.SetICEUDPMux(webrtc.NewICEUDPMux(..., 固定端口))`）把 ICE 本地端口钉死；再向网关申请把**同一个 external port 映射到这个内部端口**（`huin/goupnp` / `jackpal/go-nat-pmp`）。**只有 external==internal 时**才用 `SetNAT1To1IPs(公网IP, srflx)` 宣称该 candidate；**端口不一致就不要宣称**（映射不可用，跳过这条路）。
   - **M0 必须实测验证**：确认目标路由器能把 external 映射成与内部一致的端口，且外部真能打进来。家用路由器大量默认开 UPnP，但一致性/可达性因设备而异；失败则静默跳过，不影响其他路径。

3. **STUN srflx candidate（经典 IPv4 打洞）**
   - **STUN 服务架在 frps 那台公网机上**（`coturn` 只开 STUN，或 pion 自带 STUN），流量≈0、现成公网 IP、免依赖 Google（国内可用性差）。对全锥/端口受限锥 NAT 有效。

4. **手动 UDP 端口转发（文档指引的可靠逃生口）**
   - 若用户能在服务器路由器上转发一个固定 UDP 端口到本机，跨网成功率≈100% 且零带宽成本。文档给出配置步骤 + `TTMUX_P2P_UDP_PORT` 固定端口，方便转发。

**收敛不了的情况**：服务器只在纯 CGNAT-IPv4、无 IPv6、又无法端口转发 → 打洞失败 → 回退 frp。零成本下这是拓扑硬约束，无解。

## 5. 详细设计

### 5.1 信令协议（走现有 frp WS）

新增一类 JSON 信令消息（示意）：

**[评审修正 · 点8]** 每次传输带 `transferId`（幂等 + 关联 + 取消用）；并定义显式取消。

```jsonc
// 浏览器 → 后端：请求建立 P2P 会话（transferId 全程贯穿）
{ "type": "p2p/offer", "transferId": "t-abc", "sessionId": "u1", "sdp": "...",
  "transfer": { "path": "/abs/file", "op": "download" } }
// 后端 → 浏览器
{ "type": "p2p/answer", "transferId": "t-abc", "sdp": "..." }
// 双向：trickle ICE
{ "type": "p2p/ice", "transferId": "t-abc", "candidate": { ... } }
// 后端 → 浏览器：已连通，权威告知走了哪条路（喂给状态展示 + 埋点）
{ "type": "p2p/connected", "transferId": "t-abc",
  "path": "ipv6-direct",   // ipv6-direct | upnp | stun | lan | ...
  "local": { "type": "srflx", "family": "ipv4", "addr": "1.2.3.4:41234" },
  "remote": { "type": "srflx", "family": "ipv4" },
  "rttMs": 38 }
// 后端 → 浏览器：协商/连接失败，指示回退
{ "type": "p2p/fallback", "transferId": "t-abc", "reason": "ice-failed" }
// 双向：取消（前端回退/关页面，或后端出错/超时）→ 立即拆 PC/DC、停后端读文件
{ "type": "p2p/cancel", "transferId": "t-abc", "reason": "fell-back" }
```

**幂等与迟到消息**：前端按 `transferId` 关联；**一旦本次 transfer 进入 `fallback/http` 或 `cancel` 态，之后收到任何该 `transferId` 的 `p2p/connected`/数据一律忽略**（防迟到 connected 触发二次传输，见 §5.5 状态机）。

- **谁发起**：由浏览器发 offer、后端(pion)回 answer。DataChannel 由发起方（浏览器）`createDataChannel("file")` 创建。
- **鉴权与路径校验**：信令跑在已鉴权的 WS 会话上。**[评审修正 · 点4]** `FileDownload` 现有校验**只有** `filepath.Clean` + `filepath.IsAbs` + `os.Stat`，**并无「允许根目录」白名单**（此前文档描述不准确）。P2P 路径校验须与 HTTP **保持完全一致**：二选一——(a) 明确沿用现状权限（Clean+IsAbs+Stat，不多不少），或 (b) **同时**给 HTTP 与 P2P 增加相同的 root policy（抽成 `files` 包公共函数，两处共用），**不能只给 P2P 加**造成两条路权限不一致。
- **ICE 配置**：`iceServers` 默认给一组自建（frps 上）+ 公共 STUN 后备；`iceTransportPolicy: "all"`。**无 TURN**（§3）。

### 5.2 传输协议（DataChannel 之上）

**[评审修正 · 点7]** DataChannel **不是字节流，而是保留消息边界的可靠有序消息通道**——每次 `send()` 收端就是一条完整 message，**不会**像 TCP 那样粘包/拆包。所以协议按「一条 message = 一个数据帧」设计，无需自己切帧边界；`[seq]` 仅用于校验顺序/计数。

**帧格式**（借鉴现有 screencast 的二进制风格 `backend/browser/screencast.go`）：

```
控制帧（JSON，text message）：
  {"t":"meta","transferId":"t-abc","name":"a.bin","size":1234567,"mtime":..,"chunk":16384}
  {"t":"eof"}
  {"t":"error","msg":"..."}
数据帧（binary message，一条 message 即一帧）：
  [seq:u32 LE][payload bytes]   // 每帧 payload ≤ chunkSize（保守基线 16 KiB）
```

- **分块大小**：**保守基线 16 KiB**（跨浏览器安全；浏览器至今未上 SCTP `ndata` 扩展，单条大 message 会独占 SCTP 关联造成队头阻塞）。仅在确认两端都支持 EOR 时才可上调到 64–256 KiB。
- **背压**：发送端监控 `DataChannel.bufferedAmount`，超过高水位（如 8 MiB）暂停，`bufferedAmountLow` 事件恢复。pion 侧同理用 `BufferedAmount()` + `SetBufferedAmountLowThreshold`。避免把内存打爆。
- **落盘（[评审修正 · 点2] picker 必须先于协商）**：
  - `showSaveFilePicker()` **必须在点击的用户激活窗口内同步调用**——不能等 ICE 成功后才弹，否则「无用户激活」被浏览器拒绝。**正确顺序：点击 → 先 `showSaveFilePicker()` 拿到 `handle`/`WritableStream` → 再开始 P2P 协商**。
  - **回退必须写进同一个 handle**：P2P 失败后，HTTP 回退的字节要**写入已拿到的同一个 `WritableStream`**（把 `fetch` 的流 pipe 进去），**不能**再触发 `a[download]` 或二次 `showSaveFilePicker`，否则用户看到两次下载/两个文件。
  - 不支持 File System Access（Safari/移动端）→ 走 §5.7「桌面/手机差异」的降级策略（手机大文件直接 frp 系统下载，不进 P2P）。
- **[评审修正 · 点8] 源文件传输中变化的语义**：`meta` 带 `size`+`mtime`；后端 `os.Open` 后基于打开时的 fd 读，**传输期间源文件被改/删的行为需明确**：约定「以打开瞬间的快照为准，读到 EOF 即完；若中途 `Read` 出错或大小与 `meta.size` 不符 → 发 `{"t":"error"}` 并让前端回退」。前端按 `size` 校验，不足即判失败。
- **完整性**：`meta.size` 校验总字节数，可选 `sha256` 端到端校验（大文件默认关，按需开）。
- **加密**：DataChannel 本身 DTLS 加密，链路默认保密。

### 5.3 断点续传（可选，二期）

meta 增加 `offset`，前端记录已落盘字节；重连后从 `offset` 续传。后端 `io.Seek` 到偏移继续读。属增强项，一期可先不做。

### 5.4 后端（pion）职责

- 新增 `backend/p2p`（或 `backend/api/p2p.go`）：
  - 管理 `webrtc.PeerConnection` 生命周期（与 WS 会话绑定，会话断则关连接）。
  - 收到 offer → 建 PC、设远端 SDP、回 answer；trickle ICE 转发到 WS。
  - `OnSelectedCandidatePairChange` → 判定 `path`（ipv6-direct/upnp/stun/lan）并发 `p2p/connected` 给前端（§5.7 的权威数据源）。
  - `OnDataChannel`：读控制帧 `meta`，路径校验（§5.1 点4，与 HTTP 一致）后 `os.Open(path)`，按 chunk 循环 `channel.Send`（带背压）。
  - **[评审修正 · 点8] 取消与资源限额**：收到 `p2p/cancel` 或 DC/PC 关闭 → **用 `context` 取消文件读取的 goroutine**，别让它继续读满/占内存；定义并强制：**单会话并发 transfer 上限**、**PC 空闲超时**（建 PC 后 N 秒无数据即拆）、**控制帧 message 大小上限**（防超大 JSON）、**每次下载独立 PC 用完即拆**（点6）。
  - 复用 `files.go` 的路径校验与目录 zip 逻辑（目录同样可先打 zip 到临时流再分块发，或前端只允许对单文件走 P2P、目录走 frp）。
- 依赖：`github.com/pion/webrtc/v4`（纯 Go，`go build` 直接进现有二进制，不破坏发布流程）。

### 5.5 前端职责（[评审修正 · 点2/点3] 状态机 + picker 先行）

`FileBrowser.tsx` 下载入口改造成**显式状态机**，杜绝「迟到 connected 导致 P2P+HTTP 双传竞态」：

```
idle ──click──▶ picking ──picker成功──▶ negotiating ──┬─ connected ─▶ p2p ──done/error──▶ idle
                   │(picker取消)              │(超时/failed)  └────────────────┐
                   ▼                          ▼                                │
                 idle                      fallback ──▶ http ──done/error──▶ idle
```

1. **picking**：点击后**先在用户激活窗口内** `showSaveFilePicker()` 拿 `WritableStream`（§5.2）；用户取消 picker → 回 `idle`。
2. **negotiating**：拿到 handle 后才建 `RTCPeerConnection` + DataChannel，经 WS 交换 SDP/ICE（带 `transferId`）。
3. **p2p**：收到 `p2p/connected` 且 DC open → 收流写入 handle、跑进度条与角标。
4. **fallback**：**超时（灰度期建议 8–12 s，不是 5 s）**或 `failed`/`p2p/fallback` → 迁 `fallback`：
   - **立即拆干净**：`dc.close()` + `pc.close()`；发 `p2p/cancel{transferId}` 让**后端停读文件、拆 PC**；清 getStats 轮询。
   - **置「已终结」标志**：此后任何该 `transferId` 的 `p2p/connected`/数据帧**一律忽略**（防迟到 connected 又开一路）。
5. **http**：把 HTTP 回退流**写入同一个 handle**（§5.2），**不触发 `a[download]`/二次 picker**。
6. 全程每 ~1s `pc.getStats()` 采 RTT 等**诊断**信息；用户可见速率用 goodput（§5.7）。

- UI：进度条 + 连接方式/速率状态角标，详见 [§5.7](#57-连接状态与速率展示ui)。所有状态/错误/按钮文案走 i18n（§5.8）。

### 5.6 配置项

> **env 命名**：以下为**实际生效命名**——主键 `ROAM_WEB_P2P_*`、回退别名 `TTMUX_WEB_P2P_*`，与 `config/config.go` 的 `firstEnv("ROAM_..","TTMUX_..")` 约定一致（本文早期草稿曾用 `TTMUX_P2P_*` 简写，已校正；见[技术拆解 §0](./p2p-direct-transfer-tech.md)）。下表左列为主键，同名去掉 `ROAM_` 换 `TTMUX_` 即回退别名。

```dotenv
ROAM_WEB_P2P_ENABLE=1                 # 总开关，默认可先灰度开
ROAM_WEB_P2P_ICE_SERVERS=stun:<frps 公网 IP>:3478   # STUN 列表；首选架在 frps 上，可再补 Google 作后备
ROAM_WEB_P2P_UDP_PORT=                # 固定 UDP 端口，便于手动端口转发/UPnP；留空则随机
ROAM_WEB_P2P_UPNP=1                   # 启动时尝试 UPnP/NAT-PMP 端口映射，失败静默跳过
ROAM_WEB_P2P_MDNS=1                   # 解析浏览器 *.local mDNS 候选（同 LAN 快速通道）
# 回退别名：上述每个键把 ROAM_ 换成 TTMUX_ 即可（如 TTMUX_WEB_P2P_ENABLE）
# 注意：无 TURN 配置项——零带宽成本约束下不建 TURN（见 §3、§4.1）
```

- **`ROAM_WEB_P2P_ICE_SERVERS` 的 STUN 架在 frps 那台公网机上**：只做地址反射、流量≈0，零成本且免依赖 Google（国内可用性差）。不要只配 Google STUN。IPv6 直连无需专门 env——只要服务器有全局 IPv6、防火墙放行入站 UDP，pion 与浏览器都会自动收集 IPv6 candidate（§4.1-1，专治 CGNAT）。
- **`ROAM_WEB_P2P_UPNP`**：服务器端自动端口映射（§4.1-2）。**前提是固定 UDP 端口 + UDPMux，且 external port 能映射成与内部一致的端口**，否则 `SetNAT1To1IPs` 广播的端口是错的、不可宣称。`ROAM_WEB_P2P_UDP_PORT` 建议与 UPnP 联动使用。
- **`ROAM_WEB_P2P_MDNS`**：开启后 pion 解析浏览器默认藏成 `xxxx.local` 的私网候选，同 LAN 附赠的快速直连通道才成立（对应 `SetICEMulticastDNSMode`，见下）。
- **pion 侧开 mDNS 解析**（`SettingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryAndGather)`）：浏览器默认把私网 IP 藏成 `xxxx.local`，pion 需能解析，同 LAN 附赠快速通道才成立。

### 5.7 连接状态与速率展示（UI）

用户要求界面能看到「当前走哪条路 + 速度」。这份数据同时喂给 §7 埋点，一份来源两处用。

**展示什么**

- **常驻状态角标**（贴在下载进度旁），三态：
  - `… 正在建立直连` （协商中）
  - `⚡ 直连 · IPv6 · 8.4 MB/s` / `⚡ 直连 · UPnP` / `⚡ 直连 · 打洞` / `⚡ 直连 · 局域网`（P2P 成功，绿色）
  - `↻ 中转(frp) · 1.2 MB/s`（回退，琥珀色）
- **点开详情浮层**：传输方式（人话标签）、候选对（local/remote 的 `type` + 地址族 IPv4/IPv6）、RTT、实时速率 + 平均速率、已传/总量、ETA、本次是否回退及原因。
- **传输进度条**：百分比 + 实时速率 + ETA。

**数据从哪来**

- **走哪条路**：以**后端 `p2p/connected` 消息为权威**——pion 侧 `OnSelectedCandidatePairChange` / `GetStats` 拿到胜出候选对，判定 `path`（`ipv6-direct` / `upnp` / `stun` / `lan`；UPnP 与 STUN 都是 srflx，靠比对胜出 local 候选地址是否等于我们 `SetNAT1To1IPs` 注入的映射地址来区分）。前端不必自己反推。
- **[评审修正 · 点5] 用户可见速率 = goodput（成功落盘字节增量）**：以「已成功写入 `WritableStream` 的字节数」每秒增量为准——这才是用户真正拿到的有效速度。
  - **candidate-pair 的 `bytesReceived`/`currentRoundTripTime` 只作诊断**（详情浮层可显示 RTT），**不当用户速率**：`bytesReceived` 含重传，`availableOutgoingBitrate` 是发送方向估计、对「下载到浏览器」方向根本不对。
- **回退态**：收到 `p2p/fallback` 即切琥珀角标；HTTP 回退期的 goodput 用写入同一 handle 的字节增量。

**桌面 / 手机差异**

- **桌面**：回退 frp 时也可用 `fetch()` + `response.body.getReader()` 流式下载来测速、跟直连共用同一套进度 UI。
- **手机**：回退保持原生 `a[download]`（交给系统下载器、不吃内存），此时**只显示「中转」标签、不显示实时速率**（拿不到流），避免为了测速牺牲系统下载器。

**与埋点同源**：`path` + 平均速率 + 文件大小 + 是否回退 + 服务器 NAT 分桶 → 既渲染角标，又上报指标（§7、§10）。

### 5.8 国际化（[评审修正 · 点10] 强制）

按 [CLAUDE.md](../../../CLAUDE.md) / [i18n 标准](../../development/i18n.md)，**所有新增的连接状态、错误提示、按钮文案必须走全局 i18n，且同时提供 `zh-CN` 与 `en-US`**——不得硬编码中文/英文。覆盖：角标三态（建立中/直连·各路径/中转）、详情浮层字段名、回退原因、取消/失败/成功提示、picker 相关按钮。路径标签（IPv6/UPnP/打洞/局域网）等枚举也各配两语言 key。

## 6. 网络与运维要点

- **frp 只承载信令**，不需要为 P2P 开新端口/新代理。
- **本机需能出站 UDP**（到 STUN、到对端）——绝大多数家庭/办公 NAT 允许出站 UDP。若本机在只放行特定端口的严格防火墙后，打洞会失败 → 回退 frp（不影响可用性）。
- **数据不过云**：不建 TURN，云机带宽零新增负担；STUN 只在 frps 上做地址反射，流量≈0。
- **跨网优先级**：先争取 IPv6 直连和 UPnP 端口映射（§4.1），STUN 打洞兜底，都不行才回退 frp。

## 7. 分期落地

> 详细可执行拆解见 [p2p-direct-transfer-mvp-plan.md](./p2p-direct-transfer-mvp-plan.md)。


- **一期（MVP）**：单文件、STUN-only + IPv6 + UPnP、失败回退 frp、直连/中转角标 + **埋点**。核心是**量出真实跨网直连率与加速比**。
- **二期**：目录（P2P 传 zip 流）、SHA-256 校验、断点续传、并发多文件、SCTP 缓冲调优。
- **验收指标**：**跨网直连成功率**（按服务器 NAT 类型/是否有 IPv6/是否 UPnP 分桶）、跨网下载速度 vs frp 的倍数、回退是否无感。

## 8. 重新审视：跨网这条路到底成不成

方案**没有根本性障碍、且永远安全**（打不通回退 frp，不会让现状变差）。聚焦跨网后，成败几乎全押在**服务器那端的 NAT**上。诚实分档：

| 服务器端网络（跨网场景） | P2P 效果 |
| --- | --- |
| 有公网 IPv6（两端都有，且防火墙放行入站 UDP） | ✅ **最优**：无 NAT 打洞，显著提高成功率 |
| IPv4 + UPnP（端口一致可映射）/ 可手动端口转发 | ✅ 较稳定端点，成功率显著提高（非必成） |
| IPv4 + 全锥/端口受限锥 NAT | ✅ STUN 打洞多数成功，明显加速 |
| IPv4 纯 CGNAT / 双对称 NAT、且无 IPv6、不能转发 | ❌ 打洞必挂 → 回退 frp，**零收益**（零成本无解） |

以及两个跨设备/传输层的边界：

1. **手机端大文件受限**：File System Access API 仅桌面 Chromium 支持（iOS Safari 永不、Android Chrome 无），手机大文件走 P2P 只能塞 Blob 吃内存，反而丢掉「系统下载器」优势。故**手机端保守**：默认走 frp 系统下载，仅小/中文件试 P2P。
2. **DataChannel 吞吐有天花板**：SCTP 队头阻塞 + 默认缓冲小 + 无 `ndata`，高 RTT 跨网链路吞吐会下降；但对比被卡死的 frp 中转带宽，通常仍是净赢——别指望跑满物理带宽。

### 8.1 真机实测结论（2026-07，一台典型部署）

在一台家用/办公 LAN 后的服务器（锥形 NAT、无全局 IPv6）上实测：

- ✅ **同网直连成立**：同一 LAN 的浏览器 `path=lan`，镜像/下载走内网直连，稳定。
- ✅ **服务器侧 STUN + NAT 友好**：`bare pion` 3s 出 host+srflx；同一内部端口对多 STUN 外部端口一致 = 锥形（非对称），服务器这端具备打洞条件。
- ❌ **手机蜂窝（4G/CGNAT）跨网 = 打不通，回退中转**。用官方 trickle-ice 实测手机侧候选：
  - **IPv4 无 srflx**：蜂窝 CGNAT 连反射地址都拿不到 → IPv4 打洞根本不可能（`10.87.x` 私网 host，srflx 缺失）。
  - **IPv6 有 srflx 且 == host（无 NAT）**：手机有公网 IPv6（电信 `2408:`），本可直连——但**服务器所在宽带/路由器不下发 IPv6**（enp3s0 `accept_ra=1` 仍无全局 v6；wlo1 打开 RA 也拿不到），两边 IPv6 配不上。
- **定论**：远端 CGNAT + 服务器无 IPv6 = **零成本无解**（就是上表最后一行）。不是 bug，是拓扑物理限制。

**踩过的坑（供后人）**：
- **非 trickle 的 gather 上限别设太短**：手机蜂窝 srflx 收集慢，4s 太短会在 srflx 出来前就发 SDP → srflx 丢 → 误判"对称/无 srflx"。已改为可配（`p2pGatherTimeoutSec`，默认 30s）。
- **服务器 UDP4-only 会忽略对端 IPv6 候选**：`hasGlobalIPv6()` 为假时只 `SetNetworkTypes([UDP4])`，连手机送来的 IPv6 候选都不配对——一旦服务器有了全局 v6 需重启后端重新收集。
- 公共 STUN 里 `stun.qq.com` 已失效（超时），别放进列表；`cloudflare/google/miwifi` 可用。

**让蜂窝也直连的出路（均非零成本直连）**：给服务器搞 IPv6（宽带商开 / 免费 HE 隧道 tunnelbroker.net）是最理想；否则 TURN（大带宽 VPS，换个更粗的中转）或接受中转。

## 9. 其他风险与取舍

- **pion 维护成本**：引入一个较重依赖；但纯 Go、零 CGO、社区活跃，与现有二进制发布零摩擦。
- **UPnP 兼容性**：部分路由器关闭/不支持 UPnP，或映射不稳定；失败静默跳过，不影响其他路径。
- **实现复杂度**：信令 + 分块 + 背压 + 回退是主要工作量，但每块都有成熟范式（screencast 的二进制帧 + 背压已是同类经验）。

## 10. 决策建议

**值得做，但先用数据说话**：MVP 的第一目标不是「传得快」，而是**埋点量出真实跨网直连率与加速比**（按服务器 NAT 类型 / 有无 IPv6 / 有无 UPnP 分桶），拿数据再决定投不投二期。定位为**尽力而为的跨网加速器**，而非保证性方案；服务器建议开 IPv6 + UPnP 以吃满零成本红利，手机端默认走 frp。

---

参考：[pion/webrtc](https://github.com/pion/webrtc) · [pion/datachannel](https://github.com/pion/datachannel) · [WebRTC NAT 穿透原理](https://www.eleshine-tech.com/webrtc-nat-traversal-stun-turn-hole-punching-guide.html) · [STUN/TURN 说明](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/)
