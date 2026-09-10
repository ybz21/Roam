# 默认 STUN 列表是怎么挑的

`p2p_ice_servers` 从「一台 Google」改成默认五台，外加设置页可多选。这篇记的是挑选依据的
实测数据——名单会过期（公共 STUN 说停就停），但下面的量法不会，重挑时照着跑一遍即可。

```bash
node scripts/dev/p2p/stun-probe.mjs            # 探内置候选表
node scripts/dev/p2p/stun-probe.mjs stun:自建:3478
```

## 1. 为什么要多台

我们等的是**第一个 srflx 候选**，不是「全部 STUN 都答完」。浏览器把 Binding Request 同时
发给列表里每一台，谁先回谁先给出候选；多一台是多一次机会，不是多一道串行的等待。

三种配置，同一台机器、同一个 Chrome 实测（`RTCPeerConnection` + `createDataChannel`，
记录首个 `typ srflx` 的时刻与 `iceGatheringState==='complete'` 的时刻）：

| 配置 | 候选数 | 首个 srflx | gathering=complete |
|---|---|---|---|
| 只有 `stun.l.google.com` | 2 | **197ms** | 39890ms |
| 默认五台 | 2 | **11ms** | 39886ms |
| 默认五台 + 一台死的（`stun.qq.com`） | 2 | **15ms** | 39885ms |

三行都要读：

- **首个 srflx 从 197ms 降到 11ms**——快的那台（小米）就在国内，Google 要绕出去。
- **候选数没变**：几台 STUN 报的是同一个公网地址，浏览器自己去重。多台不会撑大 SDP。
- **掺一台死的没有代价**：`complete` 一样落在 ~39.9s，那是 Chrome 自己的收集上限，与列表
  长度无关。死的那台只是没贡献候选，它不会拖住别人。

最后一行值得单说，因为它推翻了「宁缺毋滥」的直觉。真正的代价在别处：我们是非 trickle，
要等 `iceGatheringState==='complete'` 才发 offer，所以那 ~30s（受 `p2pGatherTimeoutSec`
截断）是**当前建链慢的全部原因**，跟配几台 STUN 无关。等「拿到 srflx 后宽限 500ms 就发
offer」落地，上表第二列就直接变成建链时间——那时候多台才真正兑现成快。

## 2. 实测：谁通、多快

`ROUNDS=3` 每台三次，取平均；三个观测点分别是家里的开发机、jetson（同一出口）、
阿里云中心（`47.94.183.77`）。2026-09-10。

| STUN | 本机 | jetson | 阿里云 | 收进默认 |
|---|---|---|---|---|
| `stun:stun.miwifi.com:3478` | 9ms | 10ms | 3ms | ✅ |
| `stun:stun.chat.bilibili.com:3478` | 25ms | 34ms | 27ms | ✅ |
| `stun:stun.l.google.com:19302` | 159ms | 149ms | 100ms | ✅ |
| `stun:stun1.l.google.com:19302` | 133ms | 140ms | 102ms | ✅ |
| `stun:global.stun.twilio.com:3478` | 57ms | 65ms | 101ms | ✅ |
| `stun:stun.cloudflare.com:3478` | 188ms | 195ms | **超时** | 设置页可选 |
| `stun:stun.relay.metered.ca:80` | 83ms | 82ms | 300ms | 设置页可选 |
| `stun:stun.nextcloud.com:3478` | 157ms | 149ms | 152ms | 设置页可选 |
| `stun:stun.hot-chilli.net:3478` | 139ms | 146ms | 139ms | 设置页可选 |
| `stun:stun.qq.com:3478` | 超时 | 超时 | 超时 | ❌ |
| `stun:stun.syncthing.net:3478` | DNS 被解析到 `192.0.2.42` | | | ❌ |
| `stun:stun.sipgate.net:3478` / `stun.ekiga.net:3478` | 超时 | | | ❌ |
| `stun:stun.stunprotocol.org:3478` / `stun.services.mozilla.com:3478` | 域名已不解析 | | | ❌ |

几点：

- **`stun.qq.com` 没了**：域名还在解析（且每次给不同 IP），端口不回。写进默认会让人以为
  「配了腾讯的」，实际是一台哑巴。
- **`stun.syncthing.net` 被解析到 `192.0.2.42`**——那是 RFC 5737 的文档保留地址，不是真
  主机。这类污染 DNS 层看不出问题，只有真发一次 Binding Request 才暴露。
- **Cloudflare 从阿里云出不去**：同一台公共服务在不同网络下结论不同，所以默认列表要的是
  「三个观测点都通」，个别环境再自己加。

## 3. 默认名单与配置

默认（`config.DefaultICEServers`，`p2p_ice_servers` 留空时生效）：

```yaml
web:
  p2p_ice_servers:            # 留空 = 用下面这份默认；写了就完全以配置为准
    - stun:stun.miwifi.com:3478
    - stun:stun.chat.bilibili.com:3478
    - stun:stun.l.google.com:19302
    - stun:stun1.l.google.com:19302
    - stun:global.stun.twilio.com:3478
```

三条约定：

- **国内两台排前面纯粹因为快**，不是偏好谁；顺序不影响正确性（并行查询）。
- **漏掉 `stun:` 前缀会自动补**（`normalizeICEServers`）。浏览器和 pion 都会把没有 scheme
  的整条丢掉——一台配了却从不生效的 STUN，比没配更难查。
- **一台一条 `ICEServer`**，不把多个 URL 挤进同一条：同一条里的 URL 共享凭据，将来混进
  TURN 会连坐，一条校验失败拖垮整条里的 STUN。后端 `rtcConfiguration` 与前端
  `toIceServers` 同构。

环境变量（容器/部署脚本）：`ROAM_WEB_P2P_ICE_SERVERS="stun:a:3478,stun:b:3478"`。

浏览器侧还可以在**设置 › P2P** 里覆盖（偏好 `p2pStunServers`，只影响本浏览器打洞，不改
服务端）。下拉里列的是上表「设置页可选」那几台，也能直接粘贴自建地址。

## 4. 都是公共服务，这有没有问题

STUN 只做一件事：告诉你「我从外面看到你的地址是什么」。**不承载任何数据字节**，也看不到
数据。它能知道的是「某个 IP 在某时刻问过一次」——和你访问任何一个网站暴露的一样多。

自建同样一行配置的事：frps 那台公网机上 `coturn --stun-only`，或 pion/turn 只开 STUN，
把地址写进 `p2p_ice_servers` 即可（见 [p2p-direct-transfer.md](p2p-direct-transfer.md) §3）。
自建的好处不是隐私，是**不受别人停服影响**——上表里已经有四台是这么没的。
