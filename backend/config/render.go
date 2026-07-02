package config

import (
	"fmt"
	"strings"
)

// renderTemplate 生成带注释的 config.yaml 内容（首次运行或从 .env 迁移时写入）。
// 注释与 config.example.yaml 保持一致，方便用户直接在生成的文件上修改；w 为要填入的值。
func renderTemplate(w Web) string {
	tls := true
	if w.TLS != nil {
		tls = *w.TLS
	}
	sanLine := "tls_san: []"
	if len(w.TLSSAN) > 0 {
		var sb strings.Builder
		sb.WriteString("tls_san:")
		for _, s := range w.TLSSAN {
			fmt.Fprintf(&sb, "\n    - %s", s)
		}
		sanLine = sb.String()
	}
	lockAfter := w.LockAfter
	if lockAfter <= 0 {
		lockAfter = defaultLockAfter
	}
	lockSecs := w.LockSecs
	if lockSecs <= 0 {
		lockSecs = defaultLockSecs
	}
	bind := w.Bind
	if bind == "" {
		bind = defaultBind
	}
	return fmt.Sprintf(`# ttmux Web 控制台配置（由后端读写；start.sh 通过 ttmux-web config 读取）
# 优先级：命令行 flag > 环境变量 > 本文件 > 默认值。改完重启生效。
web:
  # 登录口令：留空则首次启动随机生成并写回本行；填了就用你填的值。
  password: %s
  bind: %s

  # ── 自签 HTTPS：手机/公网用麦克风·剪贴板需安全上下文（详见 docs/deploy/frp.md）──
  # 默认开启；设 false 退回 http。
  tls: %t
  # 额外证书 SAN（公网 IP 或域名），经 frp/反代访问时填，否则浏览器报「域名不匹配」。
  %s

  # ── 两步验证 (TOTP / Authenticator)，默认关闭 ──
  # 留空 = 关闭，只用口令登录。在控制台「系统配置」里生成密钥、扫码开启即可，
  # 状态以 <data>/totp.json 为准；下面这行只是初始种子。
  totp_secret: %s
  # 临时关闭但保留种子：设为 off（优先级高于 totp_secret）。
  two_fa: %s

  # 登录失败锁定：连续失败 lock_after 次后锁 lock_secs 秒。
  lock_after: %d
  lock_secs: %d
`, quoteYAML(w.Password), bind, tls, sanLine, quoteYAML(w.TOTPSecret), quoteYAML(w.TwoFA), lockAfter, lockSecs)
}

// RenderShell 把解析后的配置渲染成可被 bash `eval` 的 KEY=VALUE，供 start.sh 使用。
// pwGenerated 表示本次是否新生成了口令（start.sh 据此提示用户）。
func (c *Config) RenderShell(pwGenerated bool) string {
	gen := "0"
	if pwGenerated {
		gen = "1"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "TTMUX_CFG_BIND=%s\n", shellQuote(c.Web.Bind))
	fmt.Fprintf(&b, "TTMUX_CFG_PORT=%s\n", shellQuote(c.Port()))
	fmt.Fprintf(&b, "TTMUX_CFG_SCHEME=%s\n", shellQuote(c.Scheme()))
	fmt.Fprintf(&b, "TTMUX_CFG_PASSWORD=%s\n", shellQuote(c.Web.Password))
	fmt.Fprintf(&b, "TTMUX_CFG_PW_GENERATED=%s\n", gen)
	fmt.Fprintf(&b, "TTMUX_CFG_PATH=%s\n", shellQuote(c.Path()))
	return b.String()
}

// shellQuote 用单引号安全包裹值（含空格/特殊字符也不会被 bash 拆词或求值）。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
