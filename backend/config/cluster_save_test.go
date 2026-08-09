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
  # standard（默认）= 本机跑活；cloud = 只当入口
  mode: standard
  # 填了才上云
  broker: https://old.example.com
  insecure: false
`
	if err := os.WriteFile(p, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	err := SaveCluster(p, Cluster{Mode: "standard", Broker: "https://new.example.com", Name: "公司工作站", Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	s := string(got)

	for _, want := range []string{
		`password: "secret"`, // 别的段一个字节都不许动
		"# 登录口令：留空则首次打开网页时设置",               // 别人的注释
		"# standard（默认）= 本机跑活",              // 自己段里的注释也要留着
		`broker: "https://new.example.com"`, // 改掉的值
		`name: "公司工作站"`,                     // 新增的键
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

// 清空一个字段 = 删掉那一行。留 broker: "" 会让人以为配过又没生效。
func TestSaveClusterEmptyRemovesLine(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("cluster:\n  mode: standard\n  broker: https://x\n  token: abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveCluster(p, Cluster{Mode: "standard"}); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if strings.Contains(string(s), "broker:") || strings.Contains(string(s), "token:") {
		t.Errorf("断开接入后应删掉 broker/token 行，实际:\n%s", s)
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
	if err := SaveCluster(p, Cluster{Mode: "cloud"}); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if !strings.Contains(string(s), "cluster:") || !strings.Contains(string(s), `mode: "cloud"`) {
		t.Errorf("没建出 cluster 段:\n%s", s)
	}
	if !strings.Contains(string(s), "bind: 0.0.0.0:13579") {
		t.Errorf("原有内容被弄丢了:\n%s", s)
	}
}
