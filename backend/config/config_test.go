package config

import (
	"os"
	"path/filepath"
	"testing"
)

// clearEnv 清掉所有会影响 config 的环境变量，保证用例不受运行环境污染。
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"TTMUX_CONFIG", "TTMUX_BIN", "TTMUX_DATA",
		"TTMUX_WEB_PASSWORD", "TTMUX_WEB_BIND", "TTMUX_WEB_TOTP_SECRET",
		"TTMUX_WEB_2FA", "TTMUX_WEB_TLS", "TTMUX_WEB_TLS_SAN",
		"TTMUX_WEB_TLS_CERT", "TTMUX_WEB_TLS_KEY",
		"TTMUX_WEB_LOCK_AFTER", "TTMUX_WEB_LOCK_SECS", "TTMUX_WEB_FRONTEND",
	} {
		t.Setenv(k, "") // t.Setenv 会在用例结束后自动还原
		os.Unsetenv(k)
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	c, err := Load(filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Web.Bind != defaultBind {
		t.Errorf("bind = %q, want %q", c.Web.Bind, defaultBind)
	}
	if !c.TLSOn() || c.Scheme() != "https" {
		t.Errorf("tls default should be on/https, got on=%v scheme=%q", c.TLSOn(), c.Scheme())
	}
	if c.Web.LockAfter != defaultLockAfter || c.Web.LockSecs != defaultLockSecs {
		t.Errorf("lock defaults = %d/%d", c.Web.LockAfter, c.Web.LockSecs)
	}
	if c.Web.Password != "" {
		t.Errorf("password should be empty by default, got %q", c.Web.Password)
	}
}

func TestFileThenEnvOverride(t *testing.T) {
	clearEnv(t)
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte("web:\n  bind: 0.0.0.0:6000\n  tls: false\n  password: fromfile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 环境变量应覆盖文件
	t.Setenv("TTMUX_WEB_BIND", "1.2.3.4:9999")
	t.Setenv("TTMUX_WEB_TLS", "1")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Web.Bind != "1.2.3.4:9999" {
		t.Errorf("env should override bind, got %q", c.Web.Bind)
	}
	if c.Port() != "9999" {
		t.Errorf("port = %q", c.Port())
	}
	if !c.TLSOn() {
		t.Error("env TTMUX_WEB_TLS=1 should turn tls on over file false")
	}
	if c.Web.Password != "fromfile" {
		t.Errorf("password should come from file, got %q", c.Web.Password)
	}
}

func TestTwoFAOff(t *testing.T) {
	clearEnv(t)
	p := filepath.Join(t.TempDir(), "config.yaml")
	os.WriteFile(p, []byte("web:\n  totp_secret: SEED\n  two_fa: off\n"), 0o600)
	c, _ := Load(p)
	if got := c.EffectiveTOTPSecret(); got != "" {
		t.Errorf("two_fa=off should disable seed, got %q", got)
	}
}

func TestEnsurePasswordPersists(t *testing.T) {
	clearEnv(t)
	p := filepath.Join(t.TempDir(), "config.yaml")
	c, _ := Load(p)
	gen, err := c.EnsurePassword()
	if err != nil || !gen {
		t.Fatalf("expected generation, gen=%v err=%v", gen, err)
	}
	pw := c.Web.Password
	if pw == "" {
		t.Fatal("password not set")
	}
	// 重新加载应读到同一口令，且不再生成
	c2, _ := Load(p)
	if c2.Web.Password != pw {
		t.Errorf("password not persisted: %q vs %q", c2.Web.Password, pw)
	}
	if gen2, _ := c2.EnsurePassword(); gen2 {
		t.Error("should not regenerate existing password")
	}
}

func TestMigrateDotEnv(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	env := "TTMUX_WEB_PASSWORD=secret!!\nTTMUX_WEB_TLS_SAN=1.1.1.1,ex.com\nTTMUX_WEB_TLS=0\n# comment\nTTMUX_BROWSER_DEBUG=1\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "config.yaml")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Web.Password != "secret!!" {
		t.Errorf("migrated password = %q", c.Web.Password)
	}
	if c.TLSOn() {
		t.Error("migrated tls should be off")
	}
	if len(c.Web.TLSSAN) != 2 || c.Web.TLSSAN[0] != "1.1.1.1" {
		t.Errorf("migrated san = %v", c.Web.TLSSAN)
	}
	if !fileExists(p) {
		t.Error("config.yaml should have been written by migration")
	}
}
