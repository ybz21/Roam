// ttmux-web — ttmux 的 Web 控制台后端入口。
// 加载 config（flag > 环境变量 > config.yaml > 默认）→ 组装 server.Config → 启动 Gin。
//
// 另提供 `ttmux-web config show|ensure` 子命令：供 start.sh 读取解析后的配置，
// 使「配置解析」只有本二进制一处实现（bash 不再自己解析）。
package main

import (
	"flag"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"ttmux-web/browser"
	"ttmux-web/config"
	"ttmux-web/server"
)

func main() {
	// 子命令：config show|ensure —— 在解析 server flag 之前拦截。
	if len(os.Args) > 1 && os.Args[1] == "config" {
		runConfigCmd(os.Args[2:])
		return
	}

	addrFlag := flag.String("addr", "", "监听地址，如 0.0.0.0:13579（覆盖配置 web.bind）")
	webFlag := flag.String("web", "", "前端构建产物目录 frontend/dist（覆盖自动探测）")
	tlsFlag := flag.Bool("tls", false, "强制启用自签 HTTPS（覆盖配置 web.tls）")
	tlsCertFlag := flag.String("tls-cert", "", "TLS 证书路径（缺省 <data>/tls/cert.pem，缺失则自动生成）")
	tlsKeyFlag := flag.String("tls-key", "", "TLS 私钥路径（缺省 <data>/tls/key.pem，缺失则自动生成）")
	cfgFlag := flag.String("config", "", "配置文件路径（缺省 ./config.yaml 或 <data>/config.yaml）")
	flag.Parse()

	cfg, err := config.Load(*cfgFlag)
	if err != nil {
		log.Fatalf("读取配置失败: %v", err)
	}
	// 直接 exec 启动（未经 start.sh）时也保证有口令：为空则生成并回写。
	if gen, err := cfg.EnsurePassword(); err != nil {
		log.Printf("⚠ 回写生成口令失败: %v", err)
	} else if gen {
		log.Printf("⚠ 未设置口令，已随机生成并写入 %s: %s", cfg.Path(), cfg.Web.Password)
	}

	// 命令行 flag 覆盖配置（优先级最高）。
	bind := firstNonEmpty(*addrFlag, cfg.Web.Bind)
	fdir := *webFlag
	if fdir == "" {
		fdir = firstNonEmpty(cfg.Web.Frontend, frontendDir())
	}
	tlsOn := cfg.TLSOn() || *tlsFlag

	bin := cfg.Bin
	if _, err := exec.LookPath(bin); err != nil {
		log.Printf("⚠ 找不到 ttmux (%s)，请确认已安装并在 PATH 中", bin)
	}

	dataDir := cfg.DataDirResolved()
	certPath := firstNonEmpty(*tlsCertFlag, cfg.CertPath())
	keyPath := firstNonEmpty(*tlsKeyFlag, cfg.KeyPath())
	// 「下载证书」端点下发的是根 CA（手机装它），而非服务器叶子证书。
	caCertPath := filepath.Join(filepath.Dir(certPath), "ca-cert.pem")

	scheme := "http"
	if tlsOn {
		scheme = "https"
	}
	// 导航起始页挂在本服务的公开路由 /home 上（免登录，供被投屏的 Chrome 当默认主页）。
	// Chrome 与本服务同机，统一用回环地址访问（绑定即便是 0.0.0.0 也走 127.0.0.1）。
	homeURL := scheme + "://127.0.0.1:" + cfg.Port() + "/home"

	srvCfg := server.Config{
		TTmuxBin:    bin,
		LogsDir:     filepath.Join(dataDir, "logs"),
		FrontendDir: fdir,
		BrowserHome: homeURL,
		DataDir:     dataDir,
		TLSCertPath: tlsCertPathIf(tlsOn, caCertPath),
		Password:    cfg.Web.Password,
		TOTPSecret:  cfg.EffectiveTOTPSecret(),
		TOTPState:   filepath.Join(dataDir, "totp.json"),
		LockAfter:   cfg.Web.LockAfter,
		LockSecs:    cfg.Web.LockSecs,
	}

	r := server.New(srvCfg)

	// 退出时回收本进程拉起的 Chrome（含其子进程组），避免泄漏孤儿进程
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		browser.Shutdown()
		os.Exit(0)
	}()

	if tlsOn {
		gen, err := ensureSelfSignedCert(certPath, keyPath, cfg.Web.TLSSAN)
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

// runConfigCmd 处理 `ttmux-web config <show|ensure> [-config path]`。
//   - show:   只读解析并打印可被 bash eval 的 KEY=VALUE（无副作用）。
//   - ensure: 口令为空则生成并回写，再打印同样的 KEY=VALUE（start.sh 启动前调用）。
func runConfigCmd(args []string) {
	fs := flag.NewFlagSet("config", flag.ExitOnError)
	cfgFlag := fs.String("config", "", "配置文件路径")
	sub := "show"
	if len(args) > 0 && (args[0] == "show" || args[0] == "ensure") {
		sub = args[0]
		args = args[1:]
	}
	_ = fs.Parse(args)

	cfg, err := config.Load(*cfgFlag)
	if err != nil {
		log.Fatalf("读取配置失败: %v", err)
	}
	pwGenerated := false
	if sub == "ensure" {
		if gen, err := cfg.EnsurePassword(); err != nil {
			log.Fatalf("回写生成口令失败: %v", err)
		} else {
			pwGenerated = gen
		}
	}
	os.Stdout.WriteString(cfg.RenderShell(pwGenerated))
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

// frontendDir 解析前端构建产物目录（仓库根 frontend/dist，与后端分离）。
// 在可执行文件与工作目录附近探测（配置里的 web.frontend 优先，已在 main 中处理）。
func frontendDir() string {
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
