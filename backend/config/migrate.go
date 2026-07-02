package config

import (
	"os"
	"path/filepath"
	"strings"
)

// migrateDotEnv 在 config.yaml 缺失、而同目录存在旧的 .env 时，把 .env 里的
// TTMUX_WEB_* / TTMUX_BIN / TTMUX_DATA 值导入并写出一份带注释的 config.yaml。
// 仅在首次迁移触发一次；写出后旧 .env 保留不动（用户可自行删除）。
func migrateDotEnv(cfgPath string) error {
	envPath := filepath.Join(filepath.Dir(cfgPath), ".env")
	if envPath == ".env" || filepath.Dir(cfgPath) == "" {
		envPath = ".env"
	}
	b, err := os.ReadFile(envPath)
	if err != nil {
		return err // 没有 .env（或读不了）→ 不迁移
	}
	kv := parseDotEnv(string(b))
	if len(kv) == 0 {
		return nil
	}
	var w Web
	w.Password = kv["TTMUX_WEB_PASSWORD"]
	w.Bind = kv["TTMUX_WEB_BIND"]
	w.TOTPSecret = kv["TTMUX_WEB_TOTP_SECRET"]
	w.TwoFA = kv["TTMUX_WEB_2FA"]
	if v, ok := kv["TTMUX_WEB_TLS"]; ok && strings.TrimSpace(v) != "" {
		on := isTruthy(v)
		w.TLS = &on
	}
	if v := kv["TTMUX_WEB_TLS_SAN"]; v != "" {
		w.TLSSAN = splitCSV(v)
	}
	w.TLSCert = kv["TTMUX_WEB_TLS_CERT"]
	w.TLSKey = kv["TTMUX_WEB_TLS_KEY"]
	if n, ok := atoiPos(kv["TTMUX_WEB_LOCK_AFTER"]); ok {
		w.LockAfter = n
	}
	if n, ok := atoiPos(kv["TTMUX_WEB_LOCK_SECS"]); ok {
		w.LockSecs = n
	}
	w.Frontend = kv["TTMUX_WEB_FRONTEND"]

	return writeFileAtomic(cfgPath, []byte(renderTemplate(w)), 0o600)
}

// parseDotEnv 解析简单的 KEY=VALUE（忽略空行/注释；不处理引号转义，够旧 .env 用）。
func parseDotEnv(s string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.IndexByte(line, '=')
		if i <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(line[i+1:])
		val = strings.Trim(val, `"'`)
		out[key] = val
	}
	return out
}
