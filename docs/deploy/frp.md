# Exposing Roam through frp (with HTTPS)

> [中文版见下方](#通过-frp-暴露-roam带-https) · English first.

Roam's Web console must reach the browser over **HTTPS** for two features to work
on phones / remote devices:

- **Voice input** (`getUserMedia` / microphone)
- **One-tap paste** (`navigator.clipboard`)

Browsers only enable these APIs in a **secure context** (HTTPS, or `localhost`).
Over plain `http://` on a LAN IP or a public IP they are silently disabled. So
when you put Roam behind frp, the URL that finally reaches the browser **must be
`https://`**.

There are two ways to get there. Pick by whether you have a real domain + cert.

---

## Backend TLS knobs

Roam's backend can serve HTTPS itself with an auto-generated self-signed cert.
Relevant settings (env vars, also accepted as flags):

| Env | Flag | Meaning |
| --- | --- | --- |
| `TTMUX_WEB_TLS=1` | `-tls` | Serve HTTPS; generate a self-signed cert if missing |
| `TTMUX_WEB_TLS_SAN=host1,host2` | — | Extra SAN entries (IPs or domains) baked into the cert |
| `TTMUX_WEB_TLS_CERT` / `_KEY` | `-tls-cert` / `-tls-key` | Use your own cert/key instead of self-signed |

- The self-signed cert is written to `<data>/tls/{cert,key}.pem`
  (`<data>` = `$TTMUX_DATA` or `~/.local/share/ttmux`). Delete it to regenerate.
- Its SAN auto-includes `localhost`, `127.0.0.1`, `::1`, and every non-loopback
  local IP. **Add the public IP / domain you reach it by via `TTMUX_WEB_TLS_SAN`**,
  otherwise the browser shows an extra "name mismatch" warning.
- `start.sh` reads these from `.env` and turns TLS on by default.

`.env` example:

```dotenv
TTMUX_WEB_BIND=0.0.0.0:13579
TTMUX_WEB_TLS=1
TTMUX_WEB_TLS_SAN=47.94.183.77,roam.example.com
```

---

## Option A — TCP passthrough (self-signed, no domain needed)

frp just pipes raw TCP; the backend's TLS goes **end-to-end** to the browser,
which sees the self-signed cert. Simplest, works with only a public IP.

1. Keep the backend on HTTPS: `TTMUX_WEB_TLS=1`, and put your frp public IP in
   `TTMUX_WEB_TLS_SAN`.
2. Configure a TCP proxy in frp:

**frpc.toml** (frp ≥ 0.52):

```toml
[[proxies]]
name = "roam"
type = "tcp"
localIP = "127.0.0.1"
localPort = 13579     # the port TTMUX_WEB_BIND listens on
remotePort = 13579    # public port on the frps host
```

**frpc.ini** (older frp):

```ini
[roam]
type = tcp
local_ip = 127.0.0.1
local_port = 13579
remote_port = 13579
```

Access `https://<frps-public-ip>:13579`. The cert is self-signed, so each device
clicks "Advanced → Proceed" once; afterwards it is a secure context and voice /
clipboard work. WebSocket (`wss`) tunnels transparently over TCP.

> **Using [frp-panel](https://github.com/VaalaCat/frp-panel)?** The proxy is
> managed centrally, not in a local file: in the panel add a **TCP** proxy for
> your client — local `127.0.0.1:13579` → remote `13579`. The client pulls the
> config within ~30s. (Make sure the panel's frps exposes that remote port.)

---

## Option B — Real certificate, terminated at frp (no warnings)

If you have a domain and a real cert (e.g. Let's Encrypt), let frp terminate TLS
and turn the backend back to plain HTTP — no browser warnings at all.

1. Backend to HTTP: set `TTMUX_WEB_TLS=0` (frp now provides TLS).
2. **frps.toml**: enable the HTTPS vhost port.

   ```toml
   vhostHTTPSPort = 443
   ```

3. **frpc.toml**: use the `https2http` plugin to terminate HTTPS locally with your
   real cert and forward plain HTTP to the backend.

   ```toml
   [[proxies]]
   name = "roam"
   type = "https"
   customDomains = ["roam.example.com"]

   [proxies.plugin]
   type = "https2http"
   localAddr = "127.0.0.1:13579"
   crtPath = "/etc/ssl/roam/fullchain.pem"
   keyPath = "/etc/ssl/roam/privkey.pem"
   hostHeaderRewrite = "127.0.0.1"
   ```

Access `https://roam.example.com` — real cert, zero warnings, secure context.

> If your real cert is instead terminated by an nginx/Caddy in front of frps, use
> frp `type = http` + `vhostHTTPPort`, keep the backend on `TTMUX_WEB_TLS=0`, and
> let nginx/Caddy do TLS. Same principle: **whoever serves the real cert, the
> backend hands plain HTTP to.**

---

## Two things not to get wrong

1. **Do not** point frp `type = http` at the HTTPS backend — frp tries to parse
   plaintext HTTP and hits a TLS handshake instead (502 / handshake error). Use
   Option A (tcp passthrough, keep HTTPS) or Option B (backend → HTTP, frp serves
   TLS).
2. Whatever the path, the **final URL in the browser must be `https://`** — that
   is the precondition for mobile voice / clipboard.

## Verify

```bash
# locally on the Roam host
curl -sk -o /dev/null -w "%{http_code}\n" https://127.0.0.1:13579/      # 200
# through frp
curl -sk -o /dev/null -w "%{http_code}\n" https://<public-host>:13579/  # 200
```

`-k` skips cert validation. With Option A the cert stays self-signed (expected
warning); with Option B it validates cleanly.

---

## P2P direct transfer (optional, cross-network acceleration)

By default every byte of a download flows through the public frps host, so the
cloud server's bandwidth is the ceiling — no matter how fast the browser and the
Roam host really are. Roam can instead negotiate a **WebRTC DataChannel that
goes peer-to-peer and does not pass through frps**, using frp only for signaling
(SDP/ICE, a few KB). When the hole punch succeeds, downloads run at the two
endpoints' real speed; when it fails they transparently fall back to the normal
frp download. It is a pure optimization — nothing new can break.

> **The client stays a plain browser** pointed at your public `https://` frp URL.
> Everything below is one-time **server-side** setup on the frps / public host.
> No per-user or per-browser configuration is needed.

There is **no TURN** — zero relay, zero extra cloud bandwidth. STUN traffic is
address reflection only (≈0 bytes). Cross-network success hinges on the Roam
host's NAT; the knobs below all cost nothing and raise the odds.

### Stand up STUN on the frps host

Run a STUN-only responder on the public frps machine (it already has a public
IP). With `coturn`:

```bash
# coturn, STUN only — no relay, no auth, ≈0 traffic
turnserver --stun-only --no-cli --no-tls --no-dtls \
  --listening-port=3478 --listening-ip=0.0.0.0
```

Or a minimal `turnserver.conf`:

```ini
listening-port=3478
no-tls
no-dtls
stun-only          # respond to STUN Binding only; never allocate relays
no-cli
```

A tiny [pion/turn](https://github.com/pion/turn) STUN-only server works equally
well if you prefer no coturn dependency. Open **UDP 3478** on the frps host's
firewall/security group, then point Roam at it:

```dotenv
ROAM_WEB_P2P_ENABLE=1
ROAM_WEB_P2P_ICE_SERVERS=stun:<frps-public-ip>:3478
```

Do **not** stand up TURN — on the same box it is pointless, and on another box it
costs relay bandwidth, which is exactly what this feature exists to avoid.

### Optional: fixed UDP port + manual router forwarding

Pin the ICE UDP port and forward it on the Roam host's router to give ICE a
stable, reachable endpoint — this **markedly raises** cross-network success:

```dotenv
ROAM_WEB_P2P_UDP_PORT=41234
```

Then in the Roam **host's** router, forward `UDP 41234` (external) → the Roam
host's LAN IP, **same port**. Caveat: if the host sits behind CGNAT or an
upstream firewall you don't control, forwarding on your own router still can't
open the path — it may fail anyway, and Roam falls back to frp.

### Optional: UPnP automatic port mapping

Let the Roam host ask its gateway to map the port automatically:

```dotenv
ROAM_WEB_P2P_UPNP=1
ROAM_WEB_P2P_UDP_PORT=41234   # required — UPnP needs a fixed local port to map
```

UPnP only helps when the router maps the **external port to the same internal
port** (Roam advertises `public-ip:local-port`; a mismatched external port is
unreachable and is silently skipped). Many home routers enable UPnP by default,
but consistency varies by device — treat it as a free bonus, not a guarantee.

### IPv6 (the CGNAT cure)

If **both ends have public IPv6**, there is no NAT to punch and direct connection
is natural — this is the most reliable path and the answer to carrier CGNAT /
symmetric NAT on the IPv4 side. Requirements on the server: a globally routable
IPv6 address (`ip -6 addr` shows a non-`fe80`, non-ULA address) and a firewall
that **allows inbound UDP** over IPv6. Browsers gather IPv6 natively; no client
work is needed.

### New environment variables

All accept a primary `ROAM_WEB_P2P_*` name and a legacy `TTMUX_WEB_P2P_*` fallback.

| Env (primary) | Fallback | Meaning |
| --- | --- | --- |
| `ROAM_WEB_P2P_ENABLE` | `TTMUX_WEB_P2P_ENABLE` | Master switch (gradual rollout); off = always frp |
| `ROAM_WEB_P2P_ICE_SERVERS` | `TTMUX_WEB_P2P_ICE_SERVERS` | Comma-separated STUN URLs; point at your frps STUN |
| `ROAM_WEB_P2P_UDP_PORT` | `TTMUX_WEB_P2P_UDP_PORT` | Fixed ICE UDP port for manual forwarding / UPnP; empty = random |
| `ROAM_WEB_P2P_UPNP` | `TTMUX_WEB_P2P_UPNP` | Try UPnP/NAT-PMP port mapping on start; needs a fixed UDP port |
| `ROAM_WEB_P2P_MDNS` | `TTMUX_WEB_P2P_MDNS` | Resolve browser `*.local` mDNS candidates (same-LAN fast path) |

Priority order tried by ICE: IPv6 direct → UPnP-mapped srflx → STUN srflx →
LAN host. If none connect, the download quietly uses the normal frp path.

---
---

# 通过 frp 暴露 Roam（带 HTTPS）

Roam 的 Web 控制台必须以 **HTTPS** 到达浏览器，手机/远程设备上这两个功能才可用：

- **语音输入**（`getUserMedia` / 麦克风）
- **一键粘贴**（`navigator.clipboard`）

浏览器只在**安全上下文**（HTTPS 或 `localhost`）下开放这些 API。走局域网 IP 或公网
IP 的纯 `http://` 时它们会被静默禁用。所以把 Roam 放到 frp 后面时，**最终到达浏览器
的地址必须是 `https://`**。

有两条路，按你是否有真实域名+证书来选。

---

## 后端 TLS 开关

Roam 后端可自带 HTTPS，证书缺失时自动生成自签证书。相关配置（环境变量，也支持同名 flag）：

| 环境变量 | flag | 含义 |
| --- | --- | --- |
| `TTMUX_WEB_TLS=1` | `-tls` | 启用 HTTPS；证书缺失则生成自签证书 |
| `TTMUX_WEB_TLS_SAN=host1,host2` | — | 额外写入证书 SAN 的 IP 或域名 |
| `TTMUX_WEB_TLS_CERT` / `_KEY` | `-tls-cert` / `-tls-key` | 用你自己的证书/私钥，替代自签 |

- 自签证书写到 `<data>/tls/{cert,key}.pem`（`<data>` = `$TTMUX_DATA` 或
  `~/.local/share/ttmux`）。删掉即可重新生成。
- SAN 自动包含 `localhost`、`127.0.0.1`、`::1` 与本机所有非回环 IP。**务必把你实际访问
  用的公网 IP / 域名加进 `TTMUX_WEB_TLS_SAN`**，否则浏览器会多报一条「域名不匹配」。
- `start.sh`从 `.env` 读取这些，并默认开启 TLS。

`.env` 示例：

```dotenv
TTMUX_WEB_BIND=0.0.0.0:13579
TTMUX_WEB_TLS=1
TTMUX_WEB_TLS_SAN=47.94.183.77,roam.example.com
```

---

## 方案 A —— TCP 透传（自签，免域名）

frp 只当水管转字节，后端的 TLS **端到端**直达浏览器，浏览器拿到的是那张自签证书。最简单，
只有公网 IP 也能用。

1. 后端保持 HTTPS：`TTMUX_WEB_TLS=1`，并把 frp 公网 IP 填进 `TTMUX_WEB_TLS_SAN`。
2. 在 frp 里配一个 TCP 代理：

**frpc.toml**（frp ≥ 0.52）：

```toml
[[proxies]]
name = "roam"
type = "tcp"
localIP = "127.0.0.1"
localPort = 13579     # TTMUX_WEB_BIND 监听的端口
remotePort = 13579    # frps 主机上的公网端口
```

**frpc.ini**（老版本）：

```ini
[roam]
type = tcp
local_ip = 127.0.0.1
local_port = 13579
remote_port = 13579
```

访问 `https://<frps公网IP>:13579`。证书是自签，所以每台设备首次点一下「高级 → 继续前往」，
之后即为安全上下文，语音/剪贴板可用。WebSocket（`wss`）随 TCP 透明转发，无需额外配置。

> **用的是 [frp-panel](https://github.com/VaalaCat/frp-panel)？** 代理是集中管理、不在本地
> 文件里：在面板里给你的客户端加一个 **TCP** 代理——本地 `127.0.0.1:13579` → 远程 `13579`，
> 客户端约 30 秒内拉到新配置。（确认面板的 frps 已放行该远程端口。）

---

## 方案 B —— 真证书，由 frp 终止 TLS（零告警）

有域名 + 真证书（如 Let's Encrypt）时，让 frp 终止 TLS、后端退回明文 HTTP——浏览器零告警。

1. 后端转 HTTP：设 `TTMUX_WEB_TLS=0`（TLS 交给 frp）。
2. **frps.toml**：开启 HTTPS 虚拟主机端口。

   ```toml
   vhostHTTPSPort = 443
   ```

3. **frpc.toml**：用 `https2http` 插件在本地用真证书终止 HTTPS，再以明文 http 转给后端。

   ```toml
   [[proxies]]
   name = "roam"
   type = "https"
   customDomains = ["roam.example.com"]

   [proxies.plugin]
   type = "https2http"
   localAddr = "127.0.0.1:13579"
   crtPath = "/etc/ssl/roam/fullchain.pem"
   keyPath = "/etc/ssl/roam/privkey.pem"
   hostHeaderRewrite = "127.0.0.1"
   ```

访问 `https://roam.example.com`——真证书、零告警、安全上下文。

> 如果真证书是放在 frps 前面的 nginx/Caddy 上终止，那就 frp 用 `type = http` +
> `vhostHTTPPort`，后端同样 `TTMUX_WEB_TLS=0`，由 nginx/Caddy 出 TLS。本质相同：**谁出真
> 证书，后端就把明文 HTTP 交给谁。**

---

## 两个别踩的坑

1. **不要**用 frp `type = http` 直连 HTTPS 后端——frp 会按明文 HTTP 解析却撞上 TLS 握手
   （502 / 握手错误）。要么方案 A（tcp 透传、保 HTTPS），要么方案 B（后端转 HTTP、frp 出 TLS）。
2. 无论哪条路，**最终浏览器里的地址必须是 `https://`**——这是手机语音/剪贴板能用的前提。

## 验证

```bash
# 在 Roam 所在机器本地
curl -sk -o /dev/null -w "%{http_code}\n" https://127.0.0.1:13579/      # 200
# 经 frp
curl -sk -o /dev/null -w "%{http_code}\n" https://<公网地址>:13579/      # 200
```

`-k` 跳过证书校验。方案 A 证书仍是自签（告警属预期）；方案 B 可正常校验通过。

---

## P2P 直连传输（可选，跨网加速）

默认下载的每个字节都过公网 frps 中转，所以云服务器那段带宽就是天花板——无论浏览器和
Roam 本机实际网速多快都卡在这。Roam 可以改为协商一条**走点对点、不经过 frps 的 WebRTC
DataChannel**，frp 只用来传信令（SDP/ICE，几 KB）。打洞成功时，下载按两端真实网速跑；打
不通就透明回退到普通 frp 下载。这是纯优化项——不会引入「传不了」的新风险。

> **客户端仍只是一个浏览器**，打开你的公网 `https://` frp 地址即可。下面全是一次性的
> **服务端**配置，做在 frps / 公网机上，**无需**任何按用户或按浏览器的设置。

**不建 TURN**——零中转、零额外云带宽。STUN 只做地址反射（流量≈0）。跨网成败取决于 Roam
本机的 NAT；下列开关都零成本，只为把成功率拉满。

### 在 frps 公网机上架 STUN

在公网 frps 机器上（它本就有公网 IP）跑一个只做 STUN 的响应器。用 `coturn`：

```bash
# coturn，仅 STUN——不中转、不鉴权、流量≈0
turnserver --stun-only --no-cli --no-tls --no-dtls \
  --listening-port=3478 --listening-ip=0.0.0.0
```

或用最小 `turnserver.conf`：

```ini
listening-port=3478
no-tls
no-dtls
stun-only          # 只回 STUN Binding，绝不分配 relay
no-cli
```

不想装 coturn，也可以用极小的 [pion/turn](https://github.com/pion/turn) 仅开 STUN，一样
好使。在 frps 主机的防火墙/安全组放行 **UDP 3478**，然后让 Roam 指向它：

```dotenv
ROAM_WEB_P2P_ENABLE=1
ROAM_WEB_P2P_ICE_SERVERS=stun:<frps公网IP>:3478
```

**不要**架 TURN——同机上毫无意义，异机上要付中转带宽费，而这正是本功能要避开的东西。

### 可选：固定 UDP 端口 + 路由器手动转发

钉死 ICE 的 UDP 端口，并在 Roam 本机所在路由器上把它转发进来，给 ICE 一个稳定、可达的端
点——这能**显著提高**跨网成功率：

```dotenv
ROAM_WEB_P2P_UDP_PORT=41234
```

然后在 Roam **本机**的路由器上，把 `UDP 41234`（external）转发到 Roam 本机的局域网 IP，
**用同一个端口**。注意：如果本机在 CGNAT 或你管不到的上游防火墙后面，自家路由器转发也打不
通——仍可能失败，此时 Roam 回退 frp。

### 可选：UPnP 自动端口映射

让 Roam 本机向网关申请自动映射端口：

```dotenv
ROAM_WEB_P2P_UPNP=1
ROAM_WEB_P2P_UDP_PORT=41234   # 必填——UPnP 需要一个固定本地端口来映射
```

UPnP 仅在路由器能把 **external 端口映射成与内部一致的端口**时才有效（Roam 广播的是
`公网IP:本地端口`，端口对不上就不可达、会被静默跳过）。很多家用路由器默认开 UPnP，但一致
性因设备而异——当作免费加成，别当保证。

### IPv6（专治 CGNAT）

若**两端都有公网 IPv6**，就没有 NAT 要打洞，直连天然成立——这是最可靠的一条路，也是 IPv4
侧运营商 CGNAT / 对称 NAT 的解药。服务器前置条件：有可路由的全局 IPv6 地址（`ip -6 addr`
能看到非 `fe80`、非 ULA 的地址），且防火墙**放行 IPv6 入站 UDP**。浏览器原生收集 IPv6，客
户端无需额外工作。

### 新增环境变量

均支持主键 `ROAM_WEB_P2P_*` 与旧别名回退 `TTMUX_WEB_P2P_*`。

| 环境变量（主键） | 回退别名 | 含义 |
| --- | --- | --- |
| `ROAM_WEB_P2P_ENABLE` | `TTMUX_WEB_P2P_ENABLE` | 总开关（灰度用）；关=永远走 frp |
| `ROAM_WEB_P2P_ICE_SERVERS` | `TTMUX_WEB_P2P_ICE_SERVERS` | 逗号分隔的 STUN URL；指向你 frps 上的 STUN |
| `ROAM_WEB_P2P_UDP_PORT` | `TTMUX_WEB_P2P_UDP_PORT` | 固定 ICE UDP 端口，便于手动转发/UPnP；留空则随机 |
| `ROAM_WEB_P2P_UPNP` | `TTMUX_WEB_P2P_UPNP` | 启动时尝试 UPnP/NAT-PMP 端口映射；需配合固定 UDP 端口 |
| `ROAM_WEB_P2P_MDNS` | `TTMUX_WEB_P2P_MDNS` | 解析浏览器 `*.local` mDNS 候选（同 LAN 快速通道） |

ICE 的尝试优先级：IPv6 直连 → UPnP 映射 srflx → STUN srflx → 局域网 host。全都连不上，下
载就静默改走普通 frp 路径。
