// Package config 是 ttmux-web 的唯一配置所有者。
//
// 配置来源与优先级（高 → 低）：命令行 flag > 环境变量 > 配置文件(config.yaml) > 内置默认值。
// 历史上这些值放在仓库根的 .env（bash 键值文件）里，由 start.sh source 后 export 成环境变量，
// 后端再 os.Getenv 读取。现改为 YAML 配置文件，后端读写；环境变量保留为「覆盖」通道（CI/临时调试用）。
//
// bash 启动器（start.sh）不再自己解析配置，而是调用 `ttmux-web config show|ensure`
// 让本二进制吐出解析后的值，保证「配置解析」只有一处实现。
package config

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Web 是 Web 控制台的运行时配置。字段与旧的 TTMUX_WEB_* 环境变量一一对应。
type Web struct {
	Password   string   `yaml:"password"`    // 登录口令；留空则首次启动随机生成并回写
	Bind       string   `yaml:"bind"`        // 监听地址，如 0.0.0.0:13579
	TOTPSecret string   `yaml:"totp_secret"` // 两步验证初始种子(base32)；状态最终以 totp.json 为准
	TwoFA      string   `yaml:"two_fa"`      // 置为 off/0/false/no 可让上面的种子失效
	TLS        *bool    `yaml:"tls"`         // 自签 HTTPS 开关；缺省视为开启(指针以区分「未设置」)
	TLSSAN     []string `yaml:"tls_san"`     // 额外证书 SAN（公网 IP/域名），经 frp/反代访问时填
	TLSCert    string   `yaml:"tls_cert"`    // 证书路径，缺省 <data>/tls/cert.pem
	TLSKey     string   `yaml:"tls_key"`     // 私钥路径，缺省 <data>/tls/key.pem
	LockAfter  int      `yaml:"lock_after"`  // 连续失败多少次后锁定
	LockSecs   int      `yaml:"lock_secs"`   // 锁定时长(秒)
	Frontend   string   `yaml:"frontend"`    // 前端构建产物目录，缺省自动探测
}

// Config 是完整配置树。
type Config struct {
	Bin     string `yaml:"bin"`      // ttmux CLI 可执行文件名/路径（旧 TTMUX_BIN）
	DataDir string `yaml:"data_dir"` // 数据目录（旧 TTMUX_DATA），缺省 ~/.local/share/ttmux
	Web     Web    `yaml:"web"`

	path string `yaml:"-"` // 本配置从哪个文件加载/回写（不序列化）
}

// 默认值。
const (
	defaultBind      = "0.0.0.0:13579"
	defaultLockAfter = 10
	defaultLockSecs  = 30
	defaultBin       = "ttmux"
)

// Path 返回配置文件路径（用于回写、日志）。
func (c *Config) Path() string { return c.path }

// Load 按优先级组装配置：读文件 → 环境变量覆盖 → 填默认值。
// path 为空时按 ResolvePath 规则探测。文件不存在不是错误（视为全默认）。
func Load(path string) (*Config, error) {
	if path == "" {
		path = ResolvePath("")
	}
	// 一次性迁移：config.yaml 不存在但旧的 .env 还在 → 把 .env 的值导入生成 config.yaml，
	// 避免用户现网的口令/TOTP/SAN 被静默丢弃。失败不致命（后面照常按默认/环境变量走）。
	if !fileExists(path) {
		_ = migrateDotEnv(path)
	}
	c := &Config{path: path}
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, c); err != nil {
			return nil, err
		}
		c.path = path // Unmarshal 不会碰未导出字段，这里补回
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	c.applyEnv()
	c.applyDefaults()
	return c, nil
}

// ResolvePath 决定配置文件路径：flag > TTMUX_CONFIG > 已存在的 ./config.yaml > 已存在的 <data>/config.yaml
// 都没有则回退到 ./config.yaml（首次运行的回写目标，与旧 .env 同在仓库根，便于用户查看）。
func ResolvePath(flagPath string) string {
	if flagPath != "" {
		return flagPath
	}
	if v := strings.TrimSpace(os.Getenv("TTMUX_CONFIG")); v != "" {
		return v
	}
	if fileExists("config.yaml") {
		return "config.yaml"
	}
	if p := filepath.Join(dataDirEnvOrDefault(), "config.yaml"); fileExists(p) {
		return p
	}
	return "config.yaml"
}

// applyEnv 用环境变量覆盖已从文件读到的值（环境变量优先于文件）。
func (c *Config) applyEnv() {
	if v := os.Getenv("TTMUX_BIN"); v != "" {
		c.Bin = v
	}
	if v := os.Getenv("TTMUX_DATA"); v != "" {
		c.DataDir = v
	}
	if v := os.Getenv("TTMUX_WEB_PASSWORD"); v != "" {
		c.Web.Password = v
	}
	if v := os.Getenv("TTMUX_WEB_BIND"); v != "" {
		c.Web.Bind = v
	}
	if v := os.Getenv("TTMUX_WEB_TOTP_SECRET"); v != "" {
		c.Web.TOTPSecret = v
	}
	if v := os.Getenv("TTMUX_WEB_2FA"); v != "" {
		c.Web.TwoFA = v
	}
	if v, ok := os.LookupEnv("TTMUX_WEB_TLS"); ok && strings.TrimSpace(v) != "" {
		b := isTruthy(v)
		c.Web.TLS = &b
	}
	if v := os.Getenv("TTMUX_WEB_TLS_SAN"); v != "" {
		c.Web.TLSSAN = splitCSV(v)
	}
	if v := os.Getenv("TTMUX_WEB_TLS_CERT"); v != "" {
		c.Web.TLSCert = v
	}
	if v := os.Getenv("TTMUX_WEB_TLS_KEY"); v != "" {
		c.Web.TLSKey = v
	}
	if n, ok := atoiPos(os.Getenv("TTMUX_WEB_LOCK_AFTER")); ok {
		c.Web.LockAfter = n
	}
	if n, ok := atoiPos(os.Getenv("TTMUX_WEB_LOCK_SECS")); ok {
		c.Web.LockSecs = n
	}
	if v := os.Getenv("TTMUX_WEB_FRONTEND"); v != "" {
		c.Web.Frontend = v
	}
}

// applyDefaults 为仍为空的字段填入默认值。
func (c *Config) applyDefaults() {
	if c.Bin == "" {
		c.Bin = defaultBin
	}
	if c.Web.Bind == "" {
		c.Web.Bind = defaultBind
	}
	if c.Web.LockAfter <= 0 {
		c.Web.LockAfter = defaultLockAfter
	}
	if c.Web.LockSecs <= 0 {
		c.Web.LockSecs = defaultLockSecs
	}
	if c.Web.TLS == nil {
		on := true // 默认开自签 HTTPS：手机经局域网用麦克风/剪贴板需安全上下文
		c.Web.TLS = &on
	}
}

// ── 派生值（消费方通过这些方法拿「有效值」，避免各处重复判断）───────────

// DataDirResolved 返回有效数据目录。
func (c *Config) DataDirResolved() string {
	if c.DataDir != "" {
		return c.DataDir
	}
	return defaultDataDir()
}

// TLSOn 返回自签 HTTPS 是否开启。
func (c *Config) TLSOn() bool { return c.Web.TLS != nil && *c.Web.TLS }

// Scheme 返回访问协议 http/https。
func (c *Config) Scheme() string {
	if c.TLSOn() {
		return "https"
	}
	return "http"
}

// Port 从 Bind 里取端口，取不到回退 13579。
func (c *Config) Port() string {
	if _, p, err := net.SplitHostPort(c.Web.Bind); err == nil && p != "" {
		return p
	}
	return "13579"
}

// EffectiveTOTPSecret 处理 two_fa=off 关闭语义后返回生效的初始种子。
func (c *Config) EffectiveTOTPSecret() string {
	switch strings.ToLower(strings.TrimSpace(c.Web.TwoFA)) {
	case "off", "0", "false", "no":
		return ""
	}
	return c.Web.TOTPSecret
}

// CertPath / KeyPath 返回证书/私钥的有效路径（缺省落在 <data>/tls 下）。
func (c *Config) CertPath() string {
	if c.Web.TLSCert != "" {
		return c.Web.TLSCert
	}
	return filepath.Join(c.DataDirResolved(), "tls", "cert.pem")
}

func (c *Config) KeyPath() string {
	if c.Web.TLSKey != "" {
		return c.Web.TLSKey
	}
	return filepath.Join(c.DataDirResolved(), "tls", "key.pem")
}

// EnsurePassword 在口令为空时随机生成一个并回写配置文件；返回是否新生成。
func (c *Config) EnsurePassword() (bool, error) {
	if c.Web.Password != "" {
		return false, nil
	}
	c.Web.Password = randHex(6)
	if err := c.savePassword(); err != nil {
		return true, err
	}
	return true, nil
}

// savePassword 只回写口令一行，尽量保留用户在配置文件里的注释与其它字段。
// 文件不存在则用带注释的模板新建；存在则正则替换 web.password 那一行；
// 找不到该行（比如用户删了）则退回整体 marshal（会丢注释，但极少发生）。
func (c *Config) savePassword() error {
	dir := filepath.Dir(c.path)
	if dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0o755)
	}
	b, err := os.ReadFile(c.path)
	if os.IsNotExist(err) {
		return writeFileAtomic(c.path, []byte(renderTemplate(c.Web)), 0o600)
	}
	if err != nil {
		return err
	}
	re := regexp.MustCompile(`(?m)^(\s*password:).*$`)
	if re.Match(b) {
		out := re.ReplaceAll(b, []byte(`${1} `+quoteYAML(c.Web.Password)))
		return writeFileAtomic(c.path, out, 0o600)
	}
	return c.save()
}

// save 整体序列化回写（原子写，0600 因含口令）。
func (c *Config) save() error {
	b, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return writeFileAtomic(c.path, b, 0o600)
}

// ── 内部小工具 ─────────────────────────────────────────────────

func writeFileAtomic(path string, b []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func isTruthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "0", "off", "false", "no":
		return false
	}
	return true
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func atoiPos(s string) (int, bool) {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
		return n, true
	}
	return 0, false
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dataDirEnvOrDefault() string {
	if v := strings.TrimSpace(os.Getenv("TTMUX_DATA")); v != "" {
		return v
	}
	return defaultDataDir()
}

func defaultDataDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "ttmux")
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "ttmux"
	}
	return hex.EncodeToString(b)
}

// quoteYAML 给可能含特殊字符的口令加双引号，避免 YAML 解析歧义（如以 ! # 开头或含 :）。
func quoteYAML(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
