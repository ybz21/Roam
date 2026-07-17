package broker_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
