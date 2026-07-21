# MVP 实现拆解：P2P 直连文件传输

> 配套 [p2p-direct-transfer.md](./p2p-direct-transfer.md)（设计）。本文讲里程碑；代码级实现见 [技术拆解](./p2p-direct-transfer-tech.md)。
> **评审结论（已采纳）**：方向正确，**批准 spike；暂缓完整 MVP**，须先落实设计文档的 10 项 `[评审修正]`。
> **顺序按评审建议**：`M0a → M0b → M1 → M2`；**通用传输抽象延后到真实数据证明 ROI 之后**。
> MVP 范围：**浏览器 + WebRTC DataChannel + 纯 STUN(+IPv6+UPnP) + 回退 frp + 单文件下载 + goodput 状态展示 + 埋点**；**每次下载一个独立 PC**（不承诺单 PC 同时承载终端/镜像/文件，见设计 §4 点6）。

## 0. 关键代码落点（现状）

| 关注点 | 现有位置 |
| --- | --- |
| 文件下载 HTTP 处理 | `backend/api/files.go:649` `FileDownload`（**校验只有 Clean+IsAbs+Stat，无 root 白名单**，见评审点4） |
| 路由注册 | `backend/server/server.go`（WS handler 先例：`/api/browser/stream`） |
| WS + 二进制帧 + 背压范式 | `backend/browser/screencast.go` |
| 配置 | `backend/config/config.go` + `config.yaml.template`，env `TTMUX_*` |
| 前端下载入口 | `frontend/src/FileBrowser.tsx:546` `downloadEntry` |
| 前端 WS 客户端范式 | `frontend/src/BrowserView.tsx` |
| i18n | [docs/development/i18n.md](../../development/i18n.md)，`zh-CN` + `en-US` 双份（评审点10） |

## 1. 里程碑

### M0a — STUN + 固定随机数据，先实测能不能连 · spike · 规模 S–M
目标：**最小闭环**验证「浏览器 ↔ pion 经 STUN 打洞能建 DataChannel」，传**固定的随机字节流**（不碰真实文件、不碰 UI）。

- [ ] 引入 `github.com/pion/webrtc/v4`（改完 `go build` 重装才生效）。
- [ ] `backend/p2p/`：`manager.go`（PC 生命周期）、`signal.go`（offer/answer/ice，带 `transferId`）。
- [ ] 鉴权 WS `/api/p2p/signal`（复用现有 WS 鉴权中间件，会话绑定；**先确认能复用**，评审去风险点4）。
- [ ] `OnDataChannel` → 发固定大小随机数据；前端拼 Blob 丢弃、只测通断与速率。
- [ ] STUN 指向 **frps 公网机**（先临时公共 STUN 亦可，M0b 换自建）。
- **验收**：本地 + **至少一次真实跨网（异地/4G）** 成功建 DataChannel 并跑满一段随机数据；记录胜出候选对类型。**连不上要先定位**：出站 UDP 被封 / 服务器对称 NAT / STUN 不可达——**这直接决定 M0b 与整体 ROI**。

### M0b — 固定 UDPMux，分别验证 IPv6 / UPnP / 手动转发 · spike · 规模 M
目标：把设计 §4.1 的三条零成本杠杆**逐条实测**，尤其证伪/证实 UPnP 端口一致性（评审点1）。

- [ ] `backend/p2p/ice.go`：`SettingEngine.SetICEUDPMux(NewICEUDPMux(..., 固定端口))` 钉死 ICE 本地端口。
- [ ] **IPv6**：监听 `::`，确认收集到 IPv6 host candidate；两端有公网 v6 时实测直连（注意防火墙入站 UDP）。
- [ ] **UPnP/NAT-PMP**（`huin/goupnp` / `jackpal/go-nat-pmp`）：申请把 **external port 映射成与固定内部端口一致**；**仅当 external==internal 时**才 `SetNAT1To1IPs(公网IP, srflx)` 宣称，否则跳过。**实测目标路由器端口一致性 + 外部可达性**。
- [ ] **手动 UDP 端口转发**：`TTMUX_P2P_UDP_PORT` 固定端口 + 路由器转发，实测。
- [ ] `SetICEMulticastDNSMode(QueryAndGather)`（同网 `.local` 附赠通道）。
- [ ] STUN 换成 **frps 上自建**（coturn 仅 STUN / pion 自建）。
- **验收**：三条路各出一份「成功/失败 + 胜出候选对」实测结论；**明确 UPnP 在目标环境到底能不能用**（能→保留，不能→文档标注并降级到 STUN/手动转发）。

### M1 — 完成 picker/取消/回退状态机后，接真实文件 · 规模 M–L
目标：文件浏览器点下载走 P2P，**状态机严谨、回退无二次下载**，仍单文件。

- 后端
  - [ ] 路径校验与 HTTP **保持一致**（评审点4）：抽 `files` 包公共函数，HTTP 与 P2P 共用（沿用现状权限，或同步加相同 root policy，二选一但两处一致）。
  - [ ] `backend/p2p/transfer.go`：DC 收 `meta` → 校验路径 → `os.Open` → 16 KiB/条（保留消息边界，评审点7）循环 `Send` + 背压（`BufferedAmount`>高水位暂停 / `OnBufferedAmountLow` 恢复）；`eof` 收尾。
  - [ ] **取消/资源限额**（评审点8）：`p2p/cancel` 或 DC/PC 关闭 → `context` 取消读文件 goroutine；强制单会话并发上限、PC 空闲超时、控制帧大小上限、**每次下载独立 PC 用完即拆**（点6）。
  - [ ] **源文件变更语义**（评审点8）：`meta` 带 `size`+`mtime`；读到 EOF 完成，`Read` 出错/大小不符 → 发 `error` 让前端回退。
- 前端（评审点2/点3 状态机）
  - [ ] `idle→picking→negotiating→(p2p | fallback)→http` 状态机。
  - [ ] **picking**：点击后**在用户激活窗口内先 `showSaveFilePicker()`** 拿 `WritableStream`，**再**开始协商。
  - [ ] **negotiating/p2p**：建 PC+DC，交换带 `transferId` 的 SDP/ICE；收帧写入 handle、校验 `size`。
  - [ ] **回退**：**超时 8–12 s（灰度期，非 5 s）**或 `failed`/`fallback` → 拆 `dc/pc`、发 `p2p/cancel`、**置终结标志忽略迟到 `connected`/数据**；HTTP 回退流**写入同一个 handle**，**不触发 `a[download]`/二次 picker**。
  - [ ] `FileBrowser.tsx:downloadEntry` 接入该状态机。
- **验收**：正常网络直连、断网/超时**无感回退且无二次下载**、迟到 connected 不触发双传、取消能立即停后端读；两条路字节校验一致。

### M2 — goodput 展示 + 指标 + 资源限额 + 灰度 · 规模 M
目标：界面显示走哪条路 + **有效速度(goodput)**；同源上报指标；打磨限额与灰度开关。

- 后端
  - [ ] `backend/p2p/stats.go`：`OnSelectedCandidatePairChange` → 判 `path`（`ipv6-direct`/`upnp`/`stun`/`lan`；UPnP 与 STUN 靠比对胜出 local 地址==注入映射地址区分）→ 发 `p2p/connected`。
  - [ ] 配置项落地：`TTMUX_P2P_ENABLE`/`_STUN`/`_ENABLE_IPV6`/`_UPNP`/`_UDP_PORT`（**无 TURN**）；总开关支持灰度。
- 前端
  - [ ] **速率 = goodput**（评审点5）：用「成功落盘字节增量」算用户可见速率；`getStats` 的 `bytesReceived`/RTT **只进详情浮层作诊断**，不当速率。
  - [ ] `P2PTransferStatus.tsx`：三态角标 + 详情浮层 + 进度条；**所有文案走 i18n（zh-CN/en-US，评审点10）**。
  - [ ] 完成上报埋点：`{path, avgGoodputBps, sizeBytes, fellBack, serverNat?}`。
- 文档
  - [ ] `docs/deploy/frp.md` 补：frps 上开 STUN、（可选）路由器手动转发 UDP 端口步骤。
- **验收**：三路径正确显示标签 + goodput；回退显琥珀「中转」；后台可按 `path`/是否回退分桶看指标；灰度开关可控。

## 2. ROI 判定后才做（明确不在本 MVP）

- **通用传输抽象 / 单 PC 多路复用**（DuplexTransport、terminal/screencast/phone 迁移）——**必须先用 M2 埋点证明文件下载 ROI**，并**专门压测 SCTP association 共享拥塞、大文件对实时流的影响**（设计 §4 点6）后再启动。
- 目录（P2P 传 zip 流）、断点续传（`meta.offset`+`io.Seek`）、SHA-256 端到端校验、并发多文件、SCTP 缓冲/EOR 调优、桌面回退 `fetch` 流式统一 UI。

## 3. 需要早点验证的未知数（去风险，M0 就做）

1. **真实跨网打洞成功率**——M0a 用异地/4G 实测，是整个方案 ROI 命门。
2. **UPnP 端口一致性 + 可达性**——M0b 实测，直接决定 §4.1-2 这条杠杆成不成立。
3. **信令 WS 鉴权可否直接复用**现有中间件（会话绑定/生命周期）。
4. **File System Access 流式落盘**在多 GB 下的内存/表现（M1）。

## 4. 交付顺序

`M0a(能不能连) → M0b(三条杠杆逐条实测) → M1(picker/取消/回退状态机 + 真实文件) → M2(goodput/指标/限额/灰度)`。
M2 出数据 → 判 ROI → 决定是否启动「通用传输抽象」。
