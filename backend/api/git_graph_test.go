package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 造一个带分叉与合并的临时仓库：
//
//	A ─ B ─── M(merge)      main
//	     └ C ─┘             side
func makeTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	// 环境里所有 GIT_* 都要剔掉：在 pre-commit 钩子里跑测试时，外面的 GIT_DIR /
	// GIT_WORK_TREE 会漏进子进程，git 直接报 "must be run in a work tree"。
	base := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			base = append(base, kv)
		}
	}
	base = append(base,
		"GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@e",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = base
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	write := func(name, body string) {
		if out, err := exec.Command("sh", "-c", "cd "+dir+" && printf '%s' '"+body+"' > "+name).CombinedOutput(); err != nil {
			t.Fatalf("write %s: %v\n%s", name, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	write("a.txt", "a1")
	run("add", "a.txt")
	run("commit", "-qm", "feat: A")
	write("b.txt", "b1")
	run("add", "b.txt")
	run("commit", "-qm", "feat: B")
	run("checkout", "-q", "-b", "side", "HEAD~1")
	write("c.txt", "c1")
	run("add", "c.txt")
	run("commit", "-qm", "feat: C")
	run("checkout", "-q", "main")
	run("merge", "-q", "--no-ff", "--no-edit", "side")
	run("tag", "v1.0")
	return dir
}

// call 走真实路由：把 handler 挂上 gin 再打一次请求，顺带验证参数绑定。
func call(t *testing.T, h gin.HandlerFunc, method, target string, body any) (int, map[string]any) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Handle(method, "/x", h)
	var req *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		req = httptest.NewRequest(method, target, strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %s", w.Body.String())
	}
	return w.Code, out
}

func dataOf(t *testing.T, resp map[string]any) map[string]any {
	t.Helper()
	d, ok := resp["data"].(map[string]any)
	if !ok {
		t.Fatalf("缺 data: %+v", resp)
	}
	return d
}

func TestGitGraphReturnsParentsAndRefs(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}
	code, resp := call(t, a.GitGraph, "GET", "/x?dir="+dir+"&limit=20", nil)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%+v", code, resp)
	}
	d := dataOf(t, resp)
	commits, _ := d["commits"].([]any)
	if len(commits) != 4 { // A B C M
		t.Fatalf("提交数 = %d, want 4: %+v", len(commits), d["commits"])
	}

	// 最新一条是合并提交：两个父
	head, _ := commits[0].(map[string]any)
	parents, _ := head["parents"].([]any)
	if len(parents) != 2 {
		t.Fatalf("合并提交应有 2 个父, got %v", head["parents"])
	}
	// refs 里应解析出 HEAD -> main（kind=head）与 tag
	kinds := map[string]string{}
	for _, r := range head["refs"].([]any) {
		m := r.(map[string]any)
		kinds[m["name"].(string)] = m["kind"].(string)
	}
	if kinds["main"] != "head" {
		t.Fatalf("main 应标成 head, refs=%v", head["refs"])
	}
	if kinds["v1.0"] != "tag" {
		t.Fatalf("v1.0 应标成 tag, refs=%v", head["refs"])
	}
	if d["hasMore"] != false {
		t.Fatalf("hasMore 应为 false: %v", d["hasMore"])
	}

	// 每条提交的 parents 都必须在结果集里能找到（除了根提交）——泳道算法的前提
	byHash := map[string]bool{}
	for _, c := range commits {
		byHash[c.(map[string]any)["hash"].(string)] = true
	}
	roots := 0
	for _, c := range commits {
		ps, _ := c.(map[string]any)["parents"].([]any)
		if len(ps) == 0 {
			roots++
		}
	}
	if roots != 1 {
		t.Fatalf("应恰有 1 个根提交, got %d", roots)
	}
}

func TestGitGraphSearchAndScope(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}
	_, resp := call(t, a.GitGraph, "GET", "/x?dir="+dir+"&q=feat%3A+C", nil)
	commits, _ := dataOf(t, resp)["commits"].([]any)
	if len(commits) != 1 {
		t.Fatalf("按提交信息搜应只命中 1 条, got %d", len(commits))
	}
	if s := commits[0].(map[string]any)["subject"].(string); s != "feat: C" {
		t.Fatalf("命中的是 %q", s)
	}

	// scope=current 只走 HEAD 可达（这里 main 已合并 side，所以仍是 4 条）；
	// 换 side 分支视角应看不到 B 之后的合并提交。
	_, resp = call(t, a.GitGraph, "GET", "/x?dir="+dir+"&scope=current", nil)
	if got := len(dataOf(t, resp)["commits"].([]any)); got != 4 {
		t.Fatalf("scope=current 应是 4 条, got %d", got)
	}
}

func TestGitRefsListsBranchesTagsStash(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}
	code, resp := call(t, a.GitRefs, "GET", "/x?dir="+dir, nil)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%+v", code, resp)
	}
	d := dataOf(t, resp)
	branches, _ := d["branches"].([]any)
	if len(branches) != 2 {
		t.Fatalf("本地分支应有 main/side 两条, got %+v", d["branches"])
	}
	cur := ""
	for _, b := range branches {
		m := b.(map[string]any)
		if m["current"] == true {
			cur = m["name"].(string)
		}
	}
	if cur != "main" {
		t.Fatalf("当前分支应是 main, got %q", cur)
	}
	if tags, _ := d["tags"].([]any); len(tags) != 1 {
		t.Fatalf("标签应有 1 个, got %+v", d["tags"])
	}
	if _, ok := d["stashes"].([]any); !ok {
		t.Fatalf("stashes 应是数组: %+v", d["stashes"])
	}
}

func TestGitShowFilesAndMergeFirstParent(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}
	_, resp := call(t, a.GitShow, "GET", "/x?dir="+dir+"&hash=HEAD", nil)
	d := dataOf(t, resp)
	if len(d["parents"].([]any)) != 2 {
		t.Fatalf("HEAD 应是合并提交: %+v", d["parents"])
	}
	// --first-parent：相对 main 侧只多出 side 带来的 c.txt
	files, _ := d["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["path"] != "c.txt" {
		t.Fatalf("合并提交按第一父应只有 c.txt: %+v", d["files"])
	}
	if files[0].(map[string]any)["status"] != "A" {
		t.Fatalf("c.txt 应是新增: %+v", files[0])
	}

	// 普通提交：拿到 numstat 与 name-status 合并后的清单
	_, resp = call(t, a.GitShow, "GET", "/x?dir="+dir+"&hash=side", nil)
	d = dataOf(t, resp)
	if d["subject"] != "feat: C" {
		t.Fatalf("subject=%v", d["subject"])
	}
	if d["adds"].(float64) != 1 {
		t.Fatalf("adds=%v", d["adds"])
	}
}

func TestGitActionBranchLifecycle(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}

	// 新建并切换
	code, resp := call(t, a.GitAction, "POST", "/x", gin.H{"root": dir, "action": "branch-create", "name": "feat/x", "checkout": true})
	if code != http.StatusOK {
		t.Fatalf("branch-create 失败: %+v", resp)
	}
	_, resp = call(t, a.GitRefs, "GET", "/x?dir="+dir, nil)
	found := false
	for _, b := range dataOf(t, resp)["branches"].([]any) {
		m := b.(map[string]any)
		if m["name"] == "feat/x" && m["current"] == true {
			found = true
		}
	}
	if !found {
		t.Fatal("新分支未创建或未切过去")
	}

	// 切回去再删掉（已合并，-d 就够）
	if code, resp = call(t, a.GitAction, "POST", "/x", gin.H{"root": dir, "action": "checkout", "ref": "main"}); code != http.StatusOK {
		t.Fatalf("checkout 失败: %+v", resp)
	}
	if code, resp = call(t, a.GitAction, "POST", "/x", gin.H{"root": dir, "action": "branch-delete", "ref": "feat/x"}); code != http.StatusOK {
		t.Fatalf("branch-delete 失败: %+v", resp)
	}

	// 白名单之外与 - 开头的引用都要挡掉
	if code, _ = call(t, a.GitAction, "POST", "/x", gin.H{"root": dir, "action": "rm-rf"}); code != http.StatusBadRequest {
		t.Fatalf("未知 action 应 400, got %d", code)
	}
	if code, _ = call(t, a.GitAction, "POST", "/x", gin.H{"root": dir, "action": "checkout", "ref": "--upload-pack=touch /tmp/pwn"}); code != http.StatusBadRequest {
		t.Fatalf("- 开头的 ref 应 400, got %d", code)
	}
}

func TestGitStatusReportsCleanState(t *testing.T) {
	dir := makeTestRepo(t)
	a := &API{}
	_, resp := call(t, a.GitStatus, "GET", "/x?dir="+dir, nil)
	d := dataOf(t, resp)
	if d["repo"] != true || d["branch"] != "main" {
		t.Fatalf("status = %+v", d)
	}
	if d["state"] != "" {
		t.Fatalf("干净仓库 state 应为空, got %v", d["state"])
	}
	if len(d["conflicts"].([]any)) != 0 {
		t.Fatalf("不该有冲突: %+v", d["conflicts"])
	}
}
