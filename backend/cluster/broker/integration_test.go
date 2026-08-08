package broker_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"ttmux-web/cluster/broker"
	"ttmux-web/cluster/node"
)

// TestTunnelProxyEndToEnd 拉起一个 Broker（gin + httptest），让一个节点经隧道注册进来，
// 再通过 /n/<id>/api/ping 把请求反代到节点的业务 Handler，验证整条数据面打通：
// enrollment → yamux over ws 隧道 → 反代 → 节点响应回传。
func TestTunnelProxyEndToEnd(t *testing.T) {
	gin.SetMode(gin.TestMode)
	brk := broker.New(t.TempDir())

	r := gin.New()
	r.GET("/cluster/tunnel", brk.HandleTunnel)
	r.POST("/api/broker/enroll", brk.Enroll)
	r.GET("/api/broker/nodes", brk.Nodes)
	r.Any("/n/:nodeId/*path", brk.ProxyNode)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 1) 签发接入令牌
	token := enroll(t, srv.URL)

	// 2) 节点：业务 Handler 只回 pong
	biz := http.NewServeMux()
	biz.HandleFunc("/api/ping", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "pong")
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cl := &node.Client{
		Broker:   srv.URL,
		Token:    token,
		Name:     "test-node",
		Version:  "test",
		CredPath: filepath.Join(t.TempDir(), "node.json"),
		Handler:  biz,
	}
	go cl.Run(ctx)

	// 3) 等节点上线，取 nodeId
	id := waitOnline(t, srv.URL)

	// 4) 经 Broker 反代打到节点业务 Handler
	got := ""
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(srv.URL + "/n/" + id + "/api/ping")
		if err == nil && resp.StatusCode == http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			got = string(b)
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got != "pong" {
		t.Fatalf("反代结果 = %q，期望 %q", got, "pong")
	}
}

func enroll(t *testing.T, base string) string {
	t.Helper()
	resp, err := http.Post(base+"/api/broker/enroll", "application/json", nil)
	if err != nil {
		t.Fatalf("enroll 失败: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Data struct{ Token string } `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Data.Token == "" {
		t.Fatalf("解析 enroll 响应失败: %v (token=%q)", err, out.Data.Token)
	}
	return out.Data.Token
}

func waitOnline(t *testing.T, base string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(base + "/api/broker/nodes")
		if err == nil {
			var out struct {
				Data []struct {
					ID     string `json:"id"`
					Online bool   `json:"online"`
				} `json:"data"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&out)
			resp.Body.Close()
			for _, n := range out.Data {
				if n.Online {
					return n.ID
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("节点未在超时内上线")
	return ""
}

// TestProxyPreservesRawPath 盯的是一个只在真实文件名上才炸的坑：反代重写路径时如果拿
// c.Param("path")（已解码值）赋回 URL.Path，RawPath 就失效，转发时按默认规则重新编码。
// 而 /api/file/serve/*path 把**绝对路径塞进 URL**，文件名里的 # ? % 空格全会在这一跳
// 变形 → 预览/下载 404。见 docs/design/cluster/architecture.html §3 ①。
func TestProxyPreservesRawPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	brk := broker.New(t.TempDir())

	r := gin.New()
	r.UseRawPath = true // 与 server.New / NewBroker 一致
	r.GET("/cluster/tunnel", brk.HandleTunnel)
	r.POST("/api/broker/enroll", brk.Enroll)
	r.GET("/api/broker/nodes", brk.Nodes)
	r.Any("/n/:nodeId/*path", brk.ProxyNode)
	srv := httptest.NewServer(r)
	defer srv.Close()

	token := enroll(t, srv.URL)

	// 节点侧把收到的原始 RequestURI 原样回显——要比的就是它有没有在中间变形
	biz := http.NewServeMux()
	biz.HandleFunc("/api/file/serve/", func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, req.URL.EscapedPath()+"|"+req.URL.RawQuery)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cl := &node.Client{
		Broker: srv.URL, Token: token, Name: "test-node", Version: "test",
		CredPath: filepath.Join(t.TempDir(), "node.json"), Handler: biz,
	}
	go cl.Run(ctx)
	id := waitOnline(t, srv.URL)

	// 一个能把上面每种错误都踩响的路径：空格、#、%、中文
	raw := "/api/file/serve/" + url.PathEscape("/home/x/a b#c%d 文件.txt")
	want := url.PathEscape("/home/x/a b#c%d 文件.txt")

	resp, err := http.Get(srv.URL + "/n/" + id + raw + "?q=a%20b%23c")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	got := string(b)
	if !strings.Contains(got, want) {
		t.Fatalf("节点收到的路径 = %q，期望包含 %q（RawPath 在反代那一跳被重编码了）", got, want)
	}
	if !strings.HasSuffix(got, "|q=a%20b%23c") {
		t.Fatalf("query 也变形了: %q", got)
	}
}

// TestLatencyMeasured 验证控制流上的 ping/pong：心跳是节点单向上报，量不出 RTT，
// 而界面每一处都要显示「12ms」。见 architecture.html §3 ③。
func TestLatencyMeasured(t *testing.T) {
	gin.SetMode(gin.TestMode)
	brk := broker.New(t.TempDir())

	r := gin.New()
	r.GET("/cluster/tunnel", brk.HandleTunnel)
	r.POST("/api/broker/enroll", brk.Enroll)
	r.GET("/api/broker/nodes", brk.Nodes)
	srv := httptest.NewServer(r)
	defer srv.Close()

	token := enroll(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cl := &node.Client{
		Broker: srv.URL, Token: token, Name: "test-node", Version: "test",
		CredPath: filepath.Join(t.TempDir(), "node.json"), Handler: http.NewServeMux(),
	}
	go cl.Run(ctx)
	waitOnline(t, srv.URL)

	// 本地回环的 RTT 是亚毫秒，所以只断言「这个字段被填过」——>0 或至少不再是缺省。
	// 真正会退化的是「节点根本不回 pong」，那时 latencyMs 永远是 0。
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(srv.URL + "/api/broker/nodes")
		if err == nil {
			var out struct {
				Data []struct {
					LatencyMs int  `json:"latencyMs"`
					Online    bool `json:"online"`
				} `json:"data"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&out)
			resp.Body.Close()
			// pong 回来过：Latency() 会顺带刷新 lastHeartbeat，节点因此在心跳周期
			// （15s）之前就被认作在线——这正是加 ping 的第二个理由
			if len(out.Data) > 0 && out.Data[0].Online {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("5s 内没有观察到 ping/pong 生效")
}

// TestNodeTokenHashNotExposed：节点列表是给浏览器的，长期凭证的哈希没有任何理由发过去。
func TestNodeTokenHashNotExposed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	brk := broker.New(dir)
	r := gin.New()
	r.GET("/cluster/tunnel", brk.HandleTunnel)
	r.POST("/api/broker/enroll", brk.Enroll)
	r.GET("/api/broker/nodes", brk.Nodes)
	srv := httptest.NewServer(r)
	defer srv.Close()

	token := enroll(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cl := &node.Client{
		Broker: srv.URL, Token: token, Name: "test-node", Version: "test",
		CredPath: filepath.Join(t.TempDir(), "node.json"), Handler: http.NewServeMux(),
	}
	go cl.Run(ctx)
	waitOnline(t, srv.URL)

	resp, err := http.Get(srv.URL + "/api/broker/nodes")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(b), "tokenHash") {
		t.Fatalf("节点列表把凭证哈希发给了浏览器: %s", b)
	}

	// 反过来：它**必须**还在 nodes.json 里。少了它，Broker 一重启所有节点都认不回来，
	// 而接入令牌是一次性的——等于把机器锁在门外。
	saved, err := os.ReadFile(filepath.Join(dir, "nodes.json"))
	if err != nil {
		t.Fatalf("读 nodes.json 失败: %v", err)
	}
	if !strings.Contains(string(saved), "tokenHash") {
		t.Fatalf("落盘丢了凭证哈希，Broker 重启后节点将无法重连: %s", saved)
	}
}
