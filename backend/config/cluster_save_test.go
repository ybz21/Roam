package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 写 cluster 段**不能**动别的东西，尤其不能吃掉注释——那些注释是用户手改配置时
// 唯一的说明书，yaml.Marshal 全量重写一次就全没了。
func TestSaveClusterKeepsComments(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	src := `web:
  # 登录口令：留空则首次打开网页时设置
  password: "secret"
  bind: 0.0.0.0:13579

# ── 多机 ──
cluster:
  # standard（默认）= 本机跑活；hub = 只当入口
  mode: standard
  # 填了才接入中心
  hub: https://old.example.com
  insecure: false
`
	if err := os.WriteFile(p, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	err := SaveCluster(p, Cluster{Mode: "standard", Hub: "https://new.example.com", Name: "公司工作站", Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	s := string(got)

	for _, want := range []string{
		`password: "secret"`, // 别的段一个字节都不许动
		"# 登录口令：留空则首次打开网页时设置",            // 别人的注释
		"# standard（默认）= 本机跑活",           // 自己段里的注释也要留着
		`hub: "https://new.example.com"`, // 改掉的值
		`name: "公司工作站"`,                  // 新增的键
		"insecure: true",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("写回后丢了 %q\n----\n%s", want, s)
		}
	}
	if strings.Contains(s, "old.example.com") {
		t.Errorf("旧值没被替换掉:\n%s", s)
	}
}

// 清空一个字段 = 删掉那一行。留 hub: "" 会让人以为配过又没生效。
func TestSaveClusterEmptyRemovesLine(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("cluster:\n  mode: standard\n  hub: https://x\n  token: abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveCluster(p, Cluster{Mode: "standard"}); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if strings.Contains(string(s), "hub:") || strings.Contains(string(s), "token:") {
		t.Errorf("断开接入后应删掉 hub/token 行，实际:\n%s", s)
	}
	if !strings.Contains(string(s), "mode: \"standard\"") {
		t.Errorf("mode 应保留:\n%s", s)
	}
}

// 配置里还没有 cluster 段时（老用户升上来）要能自己建一段，而不是写不进去。
func TestSaveClusterCreatesSection(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("web:\n  bind: 0.0.0.0:13579\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveCluster(p, Cluster{Mode: "hub"}); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if !strings.Contains(string(s), "cluster:") || !strings.Contains(string(s), `mode: "hub"`) {
		t.Errorf("没建出 cluster 段:\n%s", s)
	}
	if !strings.Contains(string(s), "bind: 0.0.0.0:13579") {
		t.Errorf("原有内容被弄丢了:\n%s", s)
	}
}

// 旧键兼容：这套东西一度叫 broker / cloud。已经写进 config.yaml 的那些不能一改就断，
// 但也不该两个键并存——读旧的，写新的，写完旧键就该消失。
func TestLegacyBrokerKeyRead(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("cluster:\n  mode: cloud\n  broker: https://old.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Cluster.Hub != "https://old.example.com" {
		t.Errorf("旧键 broker: 没读到，Hub = %q", c.Cluster.Hub)
	}
	if c.Cluster.Mode != "hub" {
		t.Errorf("旧值 mode: cloud 应归一成 hub，实际 %q", c.Cluster.Mode)
	}
}

func TestSaveClusterDropsLegacyKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("cluster:\n  mode: standard\n  broker: https://old.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveCluster(p, Cluster{Mode: "standard", Hub: "https://new.example.com"}); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if strings.Contains(string(s), "broker:") {
		t.Errorf("写回后旧键还在，会和 hub: 并存:\n%s", s)
	}
	if !strings.Contains(string(s), `hub: "https://new.example.com"`) {
		t.Errorf("新键没写进去:\n%s", s)
	}
}

// 「中心」这个模式一度叫 cloud。配置层把旧值归一成 hub 之后，**判分流的地方也必须跟着改**——
// 漏一处就是：配置说 hub、界面显示 hub，进程却按「这台机器」起来了，而且一点报错都没有。
// 这一条就是照着那次真机翻车补的。
func TestModeNormalizedToHub(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	for _, raw := range []string{"cloud", "hub"} {
		if err := os.WriteFile(p, []byte("cluster:\n  mode: "+raw+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		c, err := Load(p)
		if err != nil {
			t.Fatal(err)
		}
		if c.Cluster.Mode != "hub" {
			t.Errorf("mode: %s 应归一成 hub，实际 %q", raw, c.Cluster.Mode)
		}
	}
}
