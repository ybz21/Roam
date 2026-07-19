// Package config 负责 Roam 后端的配置：从 ~/.roam/config.yaml 读取（首次缺失则由
// 内嵌模板生成），并按「命令行 flag > 环境变量 > 配置文件 > 默认值」的优先级解析。
//
// flag 覆盖在 backend/cmd 里叠加（flag 定义在 main）；本包负责 env + 文件 + 默认值，
// 以及登录口令的落盘（SavePassword，供首次设置/改密使用，明文写回，保留注释）。
package config

import (
	_ "embed"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed config.yaml.template
var templateBytes []byte

// Web 对应 config.yaml 里的 web: 段。
type Web struct {
	Password   string   `yaml:"password"`
	Bind       string   `yaml:"bind"`
	TLS        bool     `yaml:"tls"`
	TLSSAN     []string `yaml:"tls_san"`
	TOTPSecret string   `yaml:"totp_secret"`
	TwoFA      string   `yaml:"two_fa"`
	LockAfter  int      `yaml:"lock_after"`
	LockSecs   int      `yaml:"lock_secs"`

	// P2P 直连（浏览器 ↔ pion 经 WebRTC DataChannel）。M0a spike：STUN-only。
	// P2PEnabled 为灰度总开关；P2PICEServers 为 STUN/TURN 服务列表。
	P2PEnabled    bool     `yaml:"p2p_enabled"`
	P2PICEServers []string `yaml:"p2p_ice_servers"`

	// M0b 跨网穿透杠杆（默认关时行为与 M0a 逐字节一致）：
	// P2PUDPPort>0 → 固定 UDP 端口 + UDPMux（便于手动端口转发/UPnP 端口一致）；0=随机。
	// P2PUPnP → 仅当 P2PUDPPort>0 时尝试 UPnP 端口映射，external==internal 才注入 srflx。
	// P2PMDNS → pion 解析浏览器 .local mDNS 候选；默认 true（对 localhost/LAN 无害有益）。
	P2PUDPPort int  `yaml:"p2p_udp_port"`
	P2PUPnP    bool `yaml:"p2p_upnp"`
	P2PMDNS    bool `yaml:"p2p_mdns"`
}

// Config 是解析后的配置（env 覆盖已叠加，默认值已填充）。
type Config struct {
	Web  Web
	Path string // 实际配置文件路径（供 SavePassword 落盘）
}

// Home 返回 Roam 主目录（数据/配置根）。优先 ROAM_HOME，兼容旧 TTMUX_HOME。
func Home() string {
	if d := firstEnv("ROAM_HOME", "TTMUX_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".roam")
}

// ResolvePath 解析配置文件路径：ROAM_CONFIG > <home>/config.yaml。
func ResolvePath() string {
	if p := os.Getenv("ROAM_CONFIG"); p != "" {
		return p
	}
	return filepath.Join(Home(), "config.yaml")
}

// Load 读取并解析配置。若文件缺失，先用内嵌模板生成再读。
// 解析顺序：文件 → 默认值兜底 → 环境变量覆盖。flag 覆盖由调用方(main)叠加。
func Load(path string) (*Config, error) {
	if path == "" {
		path = ResolvePath()
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, templateBytes, 0o600); err != nil {
			return nil, err
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file struct {
		Web Web `yaml:"web"`
	}
	if err := yaml.Unmarshal(b, &file); err != nil {
		return nil, err
	}
	// p2p_mdns 缺省为 true：用 *bool 探测「文件里是否显式写了该键」，
	// 未写则默认开（对 localhost/LAN 无害且有益），显式 false 才关。
	var mdnsProbe struct {
		Web struct {
			P2PMDNS *bool `yaml:"p2p_mdns"`
		} `yaml:"web"`
	}
	_ = yaml.Unmarshal(b, &mdnsProbe)
	if mdnsProbe.Web.P2PMDNS == nil {
		file.Web.P2PMDNS = true
	}
	c := &Config{Web: file.Web, Path: path}
	c.applyDefaults()
	c.applyEnv()
	return c, nil
}

func (c *Config) applyDefaults() {
	if c.Web.Bind == "" {
		c.Web.Bind = "0.0.0.0:13579"
	}
	if c.Web.LockAfter <= 0 {
		c.Web.LockAfter = 10
	}
	if c.Web.LockSecs <= 0 {
		c.Web.LockSecs = 30
	}
	if len(c.Web.P2PICEServers) == 0 {
		// 默认公共 STUN 仅供开发/自测；生产应改为 frps 自建 STUN（见 docs/design/p2p）。
		c.Web.P2PICEServers = []string{"stun:stun.l.google.com:19302"}
	}
}

// applyEnv 让环境变量覆盖文件值。主键为 ROAM_*，兼容旧 TTMUX_*。
func (c *Config) applyEnv() {
	if v := firstEnv("ROAM_WEB_PASSWORD", "TTMUX_WEB_PASSWORD"); v != "" {
		c.Web.Password = v
	}
	if v := firstEnv("ROAM_WEB_BIND", "TTMUX_WEB_BIND"); v != "" {
		c.Web.Bind = v
	}
	if v := firstEnv("ROAM_WEB_TLS", "TTMUX_WEB_TLS"); v != "" {
		c.Web.TLS = truthy(v)
	}
	if v := firstEnv("ROAM_WEB_TLS_SAN", "TTMUX_WEB_TLS_SAN"); v != "" {
		c.Web.TLSSAN = splitCSV(v)
	}
	if v := firstEnv("ROAM_WEB_TOTP_SECRET", "TTMUX_WEB_TOTP_SECRET"); v != "" {
		c.Web.TOTPSecret = v
	}
	if v := firstEnv("ROAM_WEB_2FA", "TTMUX_WEB_2FA"); v != "" {
		c.Web.TwoFA = v
	}
	if v := firstEnv("ROAM_WEB_LOCK_AFTER", "TTMUX_WEB_LOCK_AFTER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Web.LockAfter = n
		}
	}
	if v := firstEnv("ROAM_WEB_LOCK_SECS", "TTMUX_WEB_LOCK_SECS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Web.LockSecs = n
		}
	}
	if v := firstEnv("ROAM_WEB_P2P_ENABLE", "TTMUX_WEB_P2P_ENABLE"); v != "" {
		c.Web.P2PEnabled = truthy(v)
	}
	if v := firstEnv("ROAM_WEB_P2P_ICE_SERVERS", "TTMUX_WEB_P2P_ICE_SERVERS"); v != "" {
		c.Web.P2PICEServers = splitCSV(v)
	}
	if v := firstEnv("ROAM_WEB_P2P_UDP_PORT", "TTMUX_WEB_P2P_UDP_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Web.P2PUDPPort = n
		}
	}
	if v := firstEnv("ROAM_WEB_P2P_UPNP", "TTMUX_WEB_P2P_UPNP"); v != "" {
		c.Web.P2PUPnP = truthy(v)
	}
	if v := firstEnv("ROAM_WEB_P2P_MDNS", "TTMUX_WEB_P2P_MDNS"); v != "" {
		c.Web.P2PMDNS = truthy(v)
	}
}

// ResolvedTOTPSecret 返回生效的两步验证初始种子：two_fa 为 off/0/false/no 时置空。
func (c *Config) ResolvedTOTPSecret() string {
	switch strings.ToLower(strings.TrimSpace(c.Web.TwoFA)) {
	case "off", "0", "false", "no":
		return ""
	}
	return c.Web.TOTPSecret
}

var passwordLineRE = regexp.MustCompile(`(?m)^(\s*password:\s*).*$`)

// SavePassword 把登录口令明文写回 config.yaml，只改 password: 那一行，保留其余注释/字段。
// 用于首次设置口令与设置页改密。
func SavePassword(path, plaintext string) error {
	if path == "" {
		path = ResolvePath()
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	quoted := yamlQuote(plaintext)
	var out []byte
	if passwordLineRE.Match(b) {
		out = passwordLineRE.ReplaceAll(b, []byte("${1}"+quoted))
	} else {
		// 兜底：没有 password 行时追加到 web: 段（极少发生，模板总带该行）。
		out = append(b, []byte("\nweb:\n  password: "+quoted+"\n")...)
	}
	return os.WriteFile(path, out, 0o600)
}

// yamlQuote 生成 YAML 双引号字符串字面量（转义反斜杠与双引号）。
func yamlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "0", "off", "false", "no":
		return false
	}
	return true
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
