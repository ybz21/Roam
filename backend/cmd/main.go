// ttmux-web — ttmux 的 Web 控制台后端入口。
// 解析环境变量 → 组装 server.Config → 启动 Gin。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"ttmux-web/server"
)

func main() {
	addrFlag := flag.String("addr", "", "监听地址，如 0.0.0.0:8080（覆盖 TTMUX_WEB_BIND）")
	webFlag := flag.String("web", "", "前端构建产物目录 frontend/dist（覆盖自动探测）")
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

	cfg := server.Config{
		TTmuxBin:    bin,
		LogsDir:     logsDir(),
		FrontendDir: fdir,
		KannaURL:    os.Getenv("TTMUX_KANNA_URL"),
		Password:    pw,
		LockAfter:   atoiOr(os.Getenv("TTMUX_WEB_LOCK_AFTER"), 10),
		LockSecs:    atoiOr(os.Getenv("TTMUX_WEB_LOCK_SECS"), 30),
	}

	r := server.New(cfg)
	log.Printf("ttmux-web 监听 http://%s  (ttmux=%s)", bind, bin)
	if err := r.Run(bind); err != nil {
		log.Fatal(err)
	}
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

func logsDir() string {
	data := os.Getenv("TTMUX_DATA")
	if data == "" {
		home, _ := os.UserHomeDir()
		data = filepath.Join(home, ".local", "share", "ttmux")
	}
	return filepath.Join(data, "logs")
}

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
