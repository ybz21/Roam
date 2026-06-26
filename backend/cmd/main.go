// ttmux-web — ttmux 的 Web 控制台后端入口。
// 解析环境变量 → 组装 server.Config → 启动 Gin。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"ttmux-web/browser"
	"ttmux-web/server"
)

func main() {
	addrFlag := flag.String("addr", "", "监听地址，如 0.0.0.0:8080（覆盖 TTMUX_WEB_BIND）")
	webFlag := flag.String("web", "", "前端构建产物目录 frontend/dist（覆盖自动探测）")
	tlsFlag := flag.Bool("tls", false, "启用自签 HTTPS（也可用 TTMUX_WEB_TLS=1）；手机用麦克风/剪贴板需安全上下文")
	tlsCertFlag := flag.String("tls-cert", "", "TLS 证书路径（缺省 <data>/tls/cert.pem，缺失则自动生成）")
	tlsKeyFlag := flag.String("tls-key", "", "TLS 私钥路径（缺省 <data>/tls/key.pem，缺失则自动生成）")
	flag.Parse()

	bin := envOr("TTMUX_BIN", "ttmux")
	bind := firstNonEmpty(*addrFlag, os.Getenv("TTMUX_WEB_BIND"), "0.0.0.0:8080")
	fdir := *webFlag
	if fdir == "" {
		fdir = frontendDir()
	}

	pw := os.Getenv("TTMUX_WEB_PASSWORD")
	if pw == "" {
		pw = randHex(6)
		log.Printf("⚠ 未设置 TTMUX_WEB_PASSWORD，已生成临时口令: %s", pw)
	}
	if _, err := exec.LookPath(bin); err != nil {
		log.Printf("⚠ 找不到 ttmux (%s)，请确认已安装并在 PATH 中", bin)
	}

	// 两步验证：密钥初始种子来自 TTMUX_WEB_TOTP_SECRET（默认关闭）；
	// 之后可在控制台「系统配置」里开启/关闭，状态持久化到 totp.json（以文件为准）。
	// TTMUX_WEB_2FA=off/0/false/no 可让初始种子失效（默认关闭）。
	totp := os.Getenv("TTMUX_WEB_TOTP_SECRET")
	switch strings.ToLower(os.Getenv("TTMUX_WEB_2FA")) {
	case "off", "0", "false", "no":
		totp = ""
	}

	// TLS：-tls 或 TTMUX_WEB_TLS 真值开启。证书缺失则就地生成自签证书（SAN 覆盖本机 IP）。
	tlsOn := *tlsFlag || isTruthy(os.Getenv("TTMUX_WEB_TLS"))
	certPath := firstNonEmpty(*tlsCertFlag, os.Getenv("TTMUX_WEB_TLS_CERT"), filepath.Join(dataDir(), "tls", "cert.pem"))
	keyPath := firstNonEmpty(*tlsKeyFlag, os.Getenv("TTMUX_WEB_TLS_KEY"), filepath.Join(dataDir(), "tls", "key.pem"))
	// 「下载证书」端点下发的是根 CA（手机装它），而非服务器叶子证书。
	caCertPath := filepath.Join(filepath.Dir(certPath), "ca-cert.pem")
	scheme := "http"
	if tlsOn {
		scheme = "https"
	}

	// 导航起始页挂在本服务的公开路由 /home 上（免登录，供被投屏的 Chrome 当默认主页）。
	// Chrome 与本服务同机，统一用回环地址访问（绑定即便是 0.0.0.0 也走 127.0.0.1）。
	port := "8080"
	if _, p, err := net.SplitHostPort(bind); err == nil && p != "" {
		port = p
	}
	homeURL := scheme + "://127.0.0.1:" + port + "/home"

	cfg := server.Config{
		TTmuxBin:    bin,
		LogsDir:     logsDir(),
		FrontendDir: fdir,
		BrowserHome: homeURL,
		DataDir:     dataDir(),
		TLSCertPath: tlsCertPathIf(tlsOn, caCertPath),
		Password:    pw,
		TOTPSecret:  totp,
		TOTPState:   filepath.Join(dataDir(), "totp.json"),
		LockAfter:   atoiOr(os.Getenv("TTMUX_WEB_LOCK_AFTER"), 10),
		LockSecs:    atoiOr(os.Getenv("TTMUX_WEB_LOCK_SECS"), 30),
	}

	r := server.New(cfg)

	// 退出时回收本进程拉起的 Chrome（含其子进程组），避免泄漏孤儿进程
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		browser.Shutdown()
		os.Exit(0)
	}()

	if tlsOn {
		gen, err := ensureSelfSignedCert(certPath, keyPath)
		if err != nil {
			log.Fatalf("生成/读取自签 TLS 证书失败: %v", err)
		}
		if gen {
			log.Printf("已生成自签 TLS 证书: %s", certPath)
		}
		log.Printf("ttmux-web 监听 https://%s  (ttmux=%s；自签证书，手机首访点「继续前往」信任)", bind, bin)
		if err := r.RunTLS(bind, certPath, keyPath); err != nil {
			log.Fatal(err)
		}
		return
	}
	log.Printf("ttmux-web 监听 http://%s  (ttmux=%s)", bind, bin)
	if err := r.Run(bind); err != nil {
		log.Fatal(err)
	}
}

// isTruthy 判定环境变量是否为「开启」语义；空/0/off/false/no 视为关闭。
func isTruthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "0", "off", "false", "no":
		return false
	}
	return true
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// tlsCertPathIf 仅在 TLS 开启时返回证书路径，供「下载证书」端点下发；关闭时返回空（端点 404）。
func tlsCertPathIf(on bool, path string) string {
	if on {
		return path
	}
	return ""
}

func atoiOr(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return d
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "ttmux"
	}
	return hex.EncodeToString(b)
}

func dataDir() string {
	data := os.Getenv("TTMUX_DATA")
	if data == "" {
		home, _ := os.UserHomeDir()
		data = filepath.Join(home, ".local", "share", "ttmux")
	}
	return data
}

func logsDir() string { return filepath.Join(dataDir(), "logs") }

// frontendDir 解析前端构建产物目录（仓库根 frontend/dist，与后端分离）。
// 优先 TTMUX_WEB_FRONTEND；否则在可执行文件与工作目录附近探测。
func frontendDir() string {
	if d := os.Getenv("TTMUX_WEB_FRONTEND"); d != "" {
		return d
	}
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(base, "..", "frontend", "dist"), // backend/ 下的二进制 → ../frontend/dist
			filepath.Join(base, "frontend", "dist"),
		)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "frontend", "dist"),
			filepath.Join(cwd, "..", "frontend", "dist"),
		)
	}
	for _, d := range candidates {
		if st, err := os.Stat(filepath.Join(d, "index.html")); err == nil && !st.IsDir() {
			return d
		}
	}
	return ""
}
