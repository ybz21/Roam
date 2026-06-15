# 03 · 认证与安全

← 返回 [README](./README.md)

Web 后端等于把 **shell 执行能力**搬上网，认证是不可妥协的第一道防线。
目标：**单用户、手机上少输入、防爆破/注入/CSRF、可离线自托管**（不依赖外部 OAuth）。

## 1. 认证机制

### 1.1 凭据存储
- 口令**不明文存盘**，只存 **argon2id 哈希**。
- 来源优先级：环境变量 `TTMUX_WEB_PASSWORD_HASH` > 配置文件 `~/.config/ttmux/web.toml` > 首次启动交互设置。
- `ttmux-web passwd` 子命令读口令 → 输出哈希并写入配置。
- 签名密钥 `secret` 随机生成持久化；轮换即可使所有会话失效。

### 1.2 登录流程
```
 浏览器                          ttmux-web (Gin)
  │ POST /api/login {password}    │
  │ ────────────────────────────▶ │ argon2.Verify(password, hash)
  │                               │  失败 → 计数+1 → 401 (+锁定判断)
  │                               │  成功 → 签发 token
  │ Set-Cookie: ttmux_session     │
  │  (HttpOnly,Secure,            │
  │   SameSite=Strict, 7d)        │
  │ ◀──────────────────────────── │
  │ 后续请求自动带 Cookie          │ auth 中间件：校验签名+过期+吊销表
  │ ────────────────────────────▶ │
```
- **Token**：签名 token（HMAC-SHA256 或 JWT），载荷含 `iat / exp / nonce`。
- **载体**：**HttpOnly + Secure + SameSite=Strict Cookie**（JS 读不到，防 XSS 窃取）。
- **有效期**：默认 7 天滑动续期（手机不想频繁登录）；可配 `session_ttl`。
- **登出**：清 Cookie + 维护吊销表；"登出所有设备" = 轮换 secret。

### 1.3 Gin auth 中间件
```go
r.Use(func(c *gin.Context) {
    if isPublic(c.FullPath()) { c.Next(); return }   // /api/login 放行
    tok, err := c.Cookie("ttmux_session")
    if err != nil || !auth.Verify(tok) {
        c.AbortWithStatusJSON(401, gin.H{"error": gin.H{"code":"UNAUTHORIZED"}})
        return
    }
    c.Next()
})
```

### 1.4 WS / SSE 鉴权
- WS/SSE 在 **Upgrade 握手阶段**校验同一 Cookie + 校验 `Origin` 必须匹配本站；
  不通过直接拒绝升级，**不**建立连接。这是终端/日志这个最危险通道的守门。

### 1.5 防爆破
- 失败计数 + **指数退避**（1s→2s→4s…）+ N 次后**锁定** M 分钟 + 登录接口独立速率限制中间件。

### 1.6 防 CSRF
- `SameSite=Strict` 挡掉大部分跨站请求；写操作（POST/PUT/DELETE）额外校验 `Origin`/`Referer`，
  或采用 double-submit CSRF token。

### 1.7 可选增强（v2）
- **TOTP 两步验证**（Authenticator 兼容）— 公网暴露强烈建议开启。
- **Passkey / WebAuthn** — 手机指纹/Face ID 登录，体验最佳（需 HTTPS）。
- **受信任设备** — 记住设备减少重复登录，保留撤销能力。

## 2. 其他安全（纵深防御）

1. **不开放公网端口（推荐）**：默认 `--bind 127.0.0.1`，远程访问走 **Tailscale** 或
   **Cloudflare Tunnel**；需直连时**必须** HTTPS（否则 `Secure` Cookie 失效、口令明文过网）。
2. **限制执行面**：API 只调用**白名单 ttmux 子命令**，所有用户输入作为 `exec.Command` 的
   独立参数传入（**绝不拼 shell 字符串**），杜绝命令注入。
3. **审计日志**：所有写操作（spawn/kill/send/env）+ 登录成功/失败，记录时间、来源 IP、动作、参数。
4. **最小权限运行**：服务以普通用户跑，不要 root。

## 3. 登录页（移动端）
```
┌──────────────────┐
│      ttmux       │
│   ───────────    │
│  🔒 ┌──────────┐ │
│     │ ••••••   │ │
│     └──────────┘ │
│  □ 记住此设备     │
│  ┌────────────┐  │
│  │   登 录    │  │
│  └────────────┘  │
│ (失败: 剩余 N 次) │
└──────────────────┘
```
三端一致居中卡片；锁定时显示倒计时；回车提交；（v2）Face ID / Passkey。
