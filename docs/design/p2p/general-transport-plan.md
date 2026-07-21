# 通用传输实施计划：让所有通信走 P2P + 左边栏全局状态

> 配套 [设计 §4](./p2p-direct-transfer.md) 与 [技术拆解](./p2p-direct-transfer-tech.md)。
> 目标（用户拍板 Option A）：终端 / 浏览器镜像 / 手机镜像 / 文件**全部**跑在 P2P 直连上，frp 退居信令 + 兜底；**左边栏一个全局状态**展示当前直连/中转 + 路径 + 速率。分阶段迁移，每个消费者独立回退。

## 1. 关键决策：拥塞隔离用「按流量类分多条 PeerConnection」，不是一条共享 PC

设计 §4 原图画的是「一条 PC 多路复用」，但评审点6 的风险是真的：**一条 PC = 一个 SCTP association = 共享拥塞控制**，大文件传输会拖垮终端/镜像的实时性（拥塞窗口争抢 + association 级队头阻塞）。

**定案：按流量类分 3 类 PeerConnection，各自独立 SCTP association、独立拥塞控制、独立回退：**

| PC 类 | 承载 | 通道可靠性 | 生命周期 | 为什么单独 |
| --- | --- | --- | --- | --- |
| **control** | 终端 I/O、REST/控制、剪贴板 | 可靠·有序 | 会话级常驻 | 低带宽、延迟敏感，绝不能被大文件/视频挤 |
| **media** | 浏览器镜像、手机镜像 | **不可靠·无序**(`maxRetransmits:0`) | 按需常驻 | 高带宽、丢帧优于阻塞；与 control 隔离 |
| **file** | 文件下载/上传 | 可靠·有序+背压 | 每传输一个、用完即拆 | 突发大流量，绝不能碰 control/media（已是现状） |

- NAT 穿透代价：多条 PC 各做 ICE，但候选相同、可共享 STUN/UPnP 结果，开销可接受；换来的是**干净的拥塞隔离**，不必赌单 association 的表现。
- 仍保留 [§4.1 穿透 playbook](./p2p-direct-transfer.md#41-跨网穿透-playbook零成本)（IPv6/UPnP/STUN@frps）——三类 PC 共用同一套 SettingEngine。

## 2. DuplexTransport 抽象（伪-WebSocket，功能层几乎不改）

两端对称接口，让现有功能从 `new WebSocket(...)` 平滑切到 `connect(service)`：

```ts
// 前端
interface DuplexTransport {           // ≈ 一个 WebSocket
  send(data: string | ArrayBuffer): void
  onmessage: (d: string | ArrayBuffer) => void
  onclose: () => void
  readonly kind: 'p2p' | 'frp'        // 当前实际走哪条
}
connect(service: 'term'|'screencast'|'phone'|'file', opts): DuplexTransport
// 工厂：对应类 PC 已连 → 开一条 DataChannel(label=service#id)；否则/失败 → 现有 frp WS
```

- 后端对称：`OnDataChannel` 按 label 前缀分派回**原有 handler**（handler 只见 `send/recv/close`，不感知底层）。
- **按服务独立回退**：某条通道/某类 PC 挂了，只有该服务回退 frp，其他不受影响；整体建不起来就全体走 frp = 现状。

## 3. 左边栏全局状态

- 一个常驻指示器（左边栏底部/顶部），反映**会话主连接(control PC)**状态：
  - `⚡ 直连 · <path>`（control PC P2P，绿）/ `↻ 中转`（回退 frp，琥珀）/ `… 连接中`。
  - 点开：三类 PC 各自状态（control/media/file）、path、聚合速率、RTT 诊断。
- 数据源：各 PC 的 `OnSelectedCandidatePairChange` → 后端发 `p2p/link{class,path,...}`；前端聚合。复用 M2 的 `classifyPath`/goodput/i18n。

## 4. 分阶段落地（每阶段可验、可回退）

- **Phase 1a — 地基 + 左边栏状态（先做）**：会话级 signaling 扩展；后端 control PC 管理 + DuplexTransport 分派骨架；前端共享 PC 客户端 + `connect()` 工厂 + **左边栏全局状态组件**。**先不迁真实消费者**，用一条 echo/ping 服务证明 DuplexTransport 通 + 状态正确显示直连/中转。
- **Phase 1b — 迁浏览器镜像**：`screencast` 走 media PC 的不可靠通道，保留 frp 回退。镜像是最大带宽赢面、且非关键，先验「媒体走 P2P」。
- **Phase 2 — 迁终端**：`term` 走 control PC，**seamless 回退**是重点（终端最关键，P2P 抖动必须无感切回 frp WS）。
- **Phase 3 — 迁手机镜像**：`phone` 走 media PC。
- **Phase 4 — 迁其余控制/剪贴板/REST**（可选，低带宽，收益小）。
- **压测门（Phase 1b/2 之间）**：并发大文件下载 + 终端/镜像，量 control/media 延迟不被 file 影响（验证第 1 节的隔离决策）。

## 5. 回退与安全

- 每类 PC 建链失败/超时 → 该类服务全部走 frp；运行时通道断 → 该服务重连或回退。
- 终端回退必须**不丢字节**：迁移时保留 frp WS 作影子/快速切回；Phase 2 专门处理序列连续性。
- 复用现有鉴权（cookie + `a.Middleware()`），信令走已鉴权 WS，路径/资源限额沿用 MVP。
- dev 钩子、灰度开关（`ROAM_WEB_P2P_ENABLE` + 用户偏好 `p2pDownloadEnabled`，后者语义扩为「P2P 传输总开关」）。
