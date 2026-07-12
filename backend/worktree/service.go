// Package worktree 是 Worktree 领域服务：独占一切 git worktree 操作
// （create/list/diff/merge/remove/prune + 仓库锁）。设计见
// docs/design/web/07-worktree.md §2.3——ttmux CLI 只管 session，不理解 worktree；
// HTTP handler 只做薄转发，编排（建 worktree→建会话→失败补偿）在上层组合 API。
//
// 硬规则（评审 P0/P1）：
//   - 仓库身份 = canonical git-common-dir；所有写操作持 common-dir 级 flock。
//   - base 真相源写 worktree-local config（roam.baseref/startoid/createdby/createdat），
//     外部 worktree 无字段即 base=unknown，禁止一键合并。
//   - 最终 branch/path 在锁内分配；ref 输入过 check-ref-format / rev-parse --verify。
//   - merge 执行位 = checkout 了 base 的 worktree，找不到建临时 integration worktree；
//     三种 strategy 语义分开；冲突分别 abort 并返回 {stage, conflictFiles}。
//   - 读接口无写副作用（prune 显式）；ahead 指「未合并到 base」，与推送无关。
package worktree

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ── 错误模型 ──────────────────────────────────────────────

type Err struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Extra   map[string]any `json:"extra,omitempty"`
}

func (e *Err) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, a ...any) *Err {
	return &Err{Code: code, Message: fmt.Sprintf(format, a...)}
}

// ── 服务与仓库解析 ────────────────────────────────────────

type Service struct {
	mu    sync.Mutex
	cache map[string]listCache // key: commonDir
}

type listCache struct {
	at   time.Time
	data []Worktree
}

func New() *Service { return &Service{cache: map[string]listCache{}} }

const listCacheTTL = 3 * time.Second

// scrubGitEnv 去掉环境里的 GIT_*（GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE…）：
// 进程若诞生于 git 钩子或被设置过这些变量，子进程 git 会被劫持到错误仓库。
func scrubGitEnv() []string {
	env := os.Environ()
	out := env[:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
			"GIT_COMMON_DIR", "GIT_PREFIX", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE":
			continue
		}
		out = append(out, kv)
	}
	return out
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir, "-c", "core.quotepath=false"}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(scrubGitEnv(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\n"), err
}

// gitID 同 git()，用于会产生提交的操作（merge/squash commit/rebase/wip commit）：
// 仓库连全局都没配 user.name/email 时（CI、裸机），注入 roam 机器身份兜底——
// 只在 `git var GIT_AUTHOR_IDENT` 解析失败时注入，绝不覆盖用户已配置的身份。
func gitID(ctx context.Context, dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir, "-c", "core.quotepath=false"}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(scrubGitEnv(), "GIT_TERMINAL_PROMPT=0")
	if _, err := git(ctx, dir, "var", "GIT_AUTHOR_IDENT"); err != nil {
		cmd.Env = append(cmd.Env,
			"GIT_AUTHOR_NAME=roam", "GIT_AUTHOR_EMAIL=roam@localhost",
			"GIT_COMMITTER_NAME=roam", "GIT_COMMITTER_EMAIL=roam@localhost")
	}
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\n"), err
}

// Repo 是解析后的仓库身份。
type Repo struct {
	CommonDir string // canonical git-common-dir（仓库身份）
	Root      string // 主 worktree 根（common dir 的宿主）
}

func canonical(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Clean(p)
}

// ResolveRepo 从任意目录解析仓库身份。不能假设 root/.git 是目录
// （linked worktree / submodule 是 gitfile）。
func (s *Service) ResolveRepo(ctx context.Context, dir string) (Repo, error) {
	dir = filepath.Clean(dir)
	if !filepath.IsAbs(dir) {
		return Repo{}, errf("BAD_PATH", "dir must be absolute: %s", dir)
	}
	common, err := git(ctx, dir, "rev-parse", "--git-common-dir")
	if err != nil {
		return Repo{}, errf("NOT_GIT_REPO", "%s", common)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	common = canonical(common)
	// 主 worktree 根：porcelain 列表第一个条目即主 worktree
	out, err := git(ctx, dir, "worktree", "list", "--porcelain")
	if err != nil {
		return Repo{}, errf("GIT_ERROR", "%s", out)
	}
	root := ""
	for _, line := range strings.Split(out, "\n") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			root = canonical(p)
			break
		}
	}
	if root == "" {
		return Repo{}, errf("NOT_GIT_REPO", "no worktree entries under %s", dir)
	}
	return Repo{CommonDir: common, Root: root}, nil
}

// lock 持仓库级 flock；返回解锁函数。
func (s *Service) lock(repo Repo) (func(), error) {
	path := filepath.Join(repo.CommonDir, "roam-worktree.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, errf("LOCK_FAILED", "%v", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, errf("LOCK_FAILED", "%v", err)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

func (s *Service) invalidate(repo Repo) {
	s.mu.Lock()
	delete(s.cache, repo.CommonDir)
	s.mu.Unlock()
}

// ── 数据模型 ─────────────────────────────────────────────

type SessRef struct {
	Session string `json:"session"`
	Primary bool   `json:"primary"` // 该会话的 active pane 是否落在此 worktree
}

type Worktree struct {
	Path           string    `json:"path"`
	Branch         string    `json:"branch"` // 短名；detached 为空
	Head           string    `json:"head"`
	IsMain         bool      `json:"isMain"`
	Base           string    `json:"base"` // roam.baseref 短名；"" = unknown
	StartOid       string    `json:"startOid,omitempty"`
	CreatedBy      string    `json:"createdBy,omitempty"`
	CreatedAt      string    `json:"createdAt,omitempty"`
	External       bool      `json:"external"` // 非 roam 创建（无 roam.* 字段）
	Dirty          int       `json:"dirty"`    // 未提交改动（含暂存）
	Untracked      int       `json:"untracked"`
	CommittedAhead int       `json:"committedAhead"` // 未合并到 base 的提交（≠ 未推送）
	Behind         int       `json:"behind"`
	LastCommitAt   int64     `json:"lastCommitAt"`
	Locked         bool      `json:"locked"`
	Prunable       bool      `json:"prunable"`
	Sessions       []SessRef `json:"sessions"`
}

// ── Create ───────────────────────────────────────────────

type CreateReq struct {
	Dir    string `json:"dir"`
	Branch string `json:"branch"` // 空 = 旧时间戳行为（兼容）
	Base   string `json:"base"`   // 空 = 仓库默认分支
	Remote string `json:"remote"` // 非空则先 fetch remote base
}

type CreateResp struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"`
	Base     string `json:"base"`
	StartOid string `json:"startOid"`
}

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func pathSlug(branch string) string {
	s := slugRe.ReplaceAllString(strings.ReplaceAll(branch, "/", "-"), "-")
	s = strings.Trim(s, "-.")
	if s == "" {
		s = "wt"
	}
	return s
}

// defaultBase 解析缺省 base：origin/HEAD 指向的本地分支 → 本地 main → master →
// 当前 HEAD 分支兜底。很多仓库没设 origin/HEAD（clone 早/本地建库），不能让 base
// 默认成当前检出的 feature 分支——base 应始终是本地主干。
func (s *Service) defaultBase(ctx context.Context, repo Repo) string {
	if out, err := git(ctx, repo.Root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if name := strings.TrimPrefix(strings.TrimSpace(out), "origin/"); branchExists(ctx, repo, name) {
			return name
		}
	}
	for _, name := range []string{"main", "master"} {
		if branchExists(ctx, repo, name) {
			return name
		}
	}
	if out, err := git(ctx, repo.Root, "rev-parse", "--abbrev-ref", "HEAD"); err == nil && out != "HEAD" {
		return strings.TrimSpace(out)
	}
	return ""
}

func (s *Service) Create(ctx context.Context, req CreateReq) (CreateResp, error) {
	repo, err := s.ResolveRepo(ctx, req.Dir)
	if err != nil {
		return CreateResp{}, err
	}
	if out, e := git(ctx, repo.Root, "rev-parse", "--verify", "HEAD"); e != nil {
		return CreateResp{}, errf("EMPTY_REPO", "repository has no commits yet: %s", out)
	}

	base := strings.TrimSpace(req.Base)
	if base == "" {
		base = s.defaultBase(ctx, repo)
		if base == "" {
			return CreateResp{}, errf("BASE_UNRESOLVED", "cannot determine default base branch")
		}
	}
	// 远端 ref：显式 remote+ref，fetch 后锁定 OID（不做字符串猜测）
	startRef := base
	if req.Remote != "" {
		if out, e := git(ctx, repo.Root, "fetch", "--", req.Remote, base); e != nil {
			return CreateResp{}, errf("FETCH_FAILED", "%s", out)
		}
		startRef = req.Remote + "/" + base
	}
	startOid, e := git(ctx, repo.Root, "rev-parse", "--verify", "--end-of-options", startRef+"^{commit}")
	if e != nil {
		return CreateResp{}, errf("BAD_BASE", "cannot resolve %s: %s", startRef, startOid)
	}

	unlock, err := s.lock(repo)
	if err != nil {
		return CreateResp{}, err
	}
	defer unlock()
	defer s.invalidate(repo)

	branch := strings.TrimSpace(req.Branch)
	legacy := branch == ""
	if legacy {
		now := time.Now()
		branch = "_" + now.Format("20060102150405") + fmt.Sprintf("%03d", now.Nanosecond()/1e6)
	} else {
		if out, e := git(ctx, repo.Root, "check-ref-format", "--branch", branch); e != nil {
			return CreateResp{}, errf("BAD_BRANCH", "invalid branch name %q: %s", branch, out)
		}
	}
	// 锁内分配最终 branch/path（冲突加序号后缀）
	finalBranch := branch
	for i := 2; branchExists(ctx, repo, finalBranch) && i < 100; i++ {
		finalBranch = fmt.Sprintf("%s-%d", branch, i)
	}
	if branchExists(ctx, repo, finalBranch) {
		return CreateResp{}, errf("BRANCH_TAKEN", "cannot allocate branch name from %q", branch)
	}
	wtDir := filepath.Join(repo.Root, ".worktrees")
	if err := os.MkdirAll(wtDir, 0o755); err != nil {
		return CreateResp{}, errf("MKDIR_FAILED", "%v", err)
	}
	path := filepath.Join(wtDir, pathSlug(finalBranch))
	for i := 2; pathExists(path) && i < 100; i++ {
		path = filepath.Join(wtDir, fmt.Sprintf("%s-%d", pathSlug(finalBranch), i))
	}

	if out, e := git(ctx, repo.Root, "worktree", "add", "--no-track", "-b", finalBranch, "--", path, startOid); e != nil {
		return CreateResp{}, errf("WORKTREE_ADD_FAILED", "%s", out)
	}
	// 身份写进 git：worktree-local config（先在 common 配置启用扩展）
	_, _ = git(ctx, repo.Root, "config", "extensions.worktreeConfig", "true")
	for k, v := range map[string]string{
		"roam.baseref":   base,
		"roam.startoid":  startOid,
		"roam.createdby": "roam",
		"roam.createdat": time.Now().Format(time.RFC3339),
	} {
		if out, e := git(ctx, path, "config", "--worktree", k, v); e != nil {
			// 写身份失败视为创建失败：反向补偿，绝不留下无身份的"roam worktree"
			_, _ = git(ctx, repo.Root, "worktree", "remove", "--force", "--", path)
			_, _ = git(ctx, repo.Root, "branch", "-D", "--", finalBranch)
			return CreateResp{}, errf("CONFIG_FAILED", "git config --worktree %s: %s", k, out)
		}
	}
	s.ensureExclude(repo)
	return CreateResp{Path: path, Branch: finalBranch, Base: base, StartOid: startOid}, nil
}

func branchExists(ctx context.Context, repo Repo, name string) bool {
	_, err := git(ctx, repo.Root, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

func pathExists(p string) bool { _, err := os.Stat(p); return err == nil }

// ensureExclude 幂等追加 /.worktrees/ 到 common git dir 的 info/exclude。
func (s *Service) ensureExclude(repo Repo) {
	const line = "/.worktrees/"
	p := filepath.Join(repo.CommonDir, "info", "exclude")
	b, _ := os.ReadFile(p)
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) == line {
			return
		}
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(b) > 0 && !strings.HasSuffix(string(b), "\n") {
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString(line + "\n")
}

// ── List ─────────────────────────────────────────────────

// List 解析 porcelain 清单并补状态；带 3s 缓存。无任何写副作用。
func (s *Service) List(ctx context.Context, dir string) ([]Worktree, error) {
	repo, err := s.ResolveRepo(ctx, dir)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if c, ok := s.cache[repo.CommonDir]; ok && time.Since(c.at) < listCacheTTL {
		s.mu.Unlock()
		return s.joinSessions(ctx, c.data), nil
	}
	s.mu.Unlock()

	out, e := git(ctx, repo.Root, "worktree", "list", "--porcelain")
	if e != nil {
		return nil, errf("GIT_ERROR", "%s", out)
	}
	var list []Worktree
	var cur *Worktree
	flush := func() {
		if cur != nil {
			list = append(list, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur = &Worktree{Path: canonical(strings.TrimPrefix(line, "worktree "))}
		case cur == nil:
		case strings.HasPrefix(line, "HEAD "):
			cur.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
		case line == "locked" || strings.HasPrefix(line, "locked "):
			cur.Locked = true
		case line == "prunable" || strings.HasPrefix(line, "prunable "):
			cur.Prunable = true
		}
	}
	flush()

	for i := range list {
		w := &list[i]
		w.IsMain = w.Path == repo.Root
		if w.Prunable {
			continue
		}
		// 身份（roam.* worktree config；读不到 = 外部创建 base unknown）
		if v, e := git(ctx, w.Path, "config", "--worktree", "--get", "roam.baseref"); e == nil {
			w.Base = strings.TrimSpace(v)
		}
		if v, e := git(ctx, w.Path, "config", "--worktree", "--get", "roam.startoid"); e == nil {
			w.StartOid = strings.TrimSpace(v)
		}
		if v, e := git(ctx, w.Path, "config", "--worktree", "--get", "roam.createdby"); e == nil {
			w.CreatedBy = strings.TrimSpace(v)
		}
		if v, e := git(ctx, w.Path, "config", "--worktree", "--get", "roam.createdat"); e == nil {
			w.CreatedAt = strings.TrimSpace(v)
		}
		w.External = w.CreatedBy != "roam"
		// 状态
		if st, e := git(ctx, w.Path, "status", "--porcelain=v1"); e == nil && st != "" {
			for _, l := range strings.Split(st, "\n") {
				if strings.HasPrefix(l, "??") {
					w.Untracked++
				} else if strings.TrimSpace(l) != "" {
					w.Dirty++
				}
			}
		}
		if w.Base != "" && !w.IsMain {
			if cnt, e := git(ctx, w.Path, "rev-list", "--left-right", "--count", w.Base+"...HEAD"); e == nil {
				parts := strings.Fields(cnt)
				if len(parts) == 2 {
					w.Behind, _ = strconv.Atoi(parts[0])
					w.CommittedAhead, _ = strconv.Atoi(parts[1])
				}
			}
		}
		if ts, e := git(ctx, w.Path, "log", "-1", "--format=%ct"); e == nil {
			w.LastCommitAt, _ = strconv.ParseInt(strings.TrimSpace(ts), 10, 64)
		}
	}
	s.mu.Lock()
	s.cache[repo.CommonDir] = listCache{at: time.Now(), data: list}
	s.mu.Unlock()
	return s.joinSessions(ctx, list), nil
}

// ── session ↔ worktree join（cwd 现算，不写台账）──────────

type pane struct {
	Session string
	Active  bool
	Cwd     string
}

func tmuxBin() string {
	if b := os.Getenv("TMUX_BIN"); b != "" {
		return b
	}
	return "tmux"
}

func tmuxPanes(ctx context.Context) []pane {
	cmd := exec.CommandContext(ctx, tmuxBin(), "list-panes", "-a", "-F", "#{session_name}\t#{pane_active}\t#{pane_current_path}")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var panes []pane
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) == 3 {
			panes = append(panes, pane{Session: parts[0], Active: parts[1] == "1", Cwd: canonical(parts[2])})
		}
	}
	return panes
}

// underPath 按路径段边界判断 p 是否在 root 内。
func underPath(p, root string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

func (s *Service) joinSessions(ctx context.Context, list []Worktree) []Worktree {
	out := make([]Worktree, len(list))
	copy(out, list)
	panes := tmuxPanes(ctx)
	for i := range out {
		out[i].Sessions = nil
	}
	for _, p := range panes {
		// 最长前缀命中（worktree 可能嵌套于主仓库之下，主 worktree 也参与）
		best, bestLen := -1, -1
		for i := range out {
			if underPath(p.Cwd, out[i].Path) && len(out[i].Path) > bestLen {
				best, bestLen = i, len(out[i].Path)
			}
		}
		if best < 0 {
			continue
		}
		found := false
		for j := range out[best].Sessions {
			if out[best].Sessions[j].Session == p.Session {
				out[best].Sessions[j].Primary = out[best].Sessions[j].Primary || p.Active
				found = true
			}
		}
		if !found {
			out[best].Sessions = append(out[best].Sessions, SessRef{Session: p.Session, Primary: p.Active})
		}
	}
	return out
}

// ── Annotations（跨仓库：session → worktree 归属）─────────

type Annotation struct {
	Primary   *AnnotationHit  `json:"primary,omitempty"`
	Matches   []AnnotationHit `json:"matches"`
	Ambiguous bool            `json:"ambiguous"`
}

type AnnotationHit struct {
	Repo     string `json:"repo"`     // 主仓库根
	Worktree string `json:"worktree"` // worktree 根（linked 才有意义）
	Branch   string `json:"branch"`
	Linked   bool   `json:"linked"`   // 是否 linked worktree（≠ 主 worktree）
	External bool   `json:"external"` // 无 roam.* 身份（用户手建），UI 标 ⧉
}

type cwdInfo struct {
	at  time.Time
	hit *AnnotationHit
}

var (
	cwdCacheMu sync.Mutex
	cwdCache   = map[string]cwdInfo{}
)

func resolveCwd(ctx context.Context, cwd string) *AnnotationHit {
	cwdCacheMu.Lock()
	if c, ok := cwdCache[cwd]; ok && time.Since(c.at) < 5*time.Second {
		cwdCacheMu.Unlock()
		return c.hit
	}
	cwdCacheMu.Unlock()
	var hit *AnnotationHit
	if top, err := git(ctx, cwd, "rev-parse", "--show-toplevel"); err == nil {
		top = canonical(top)
		gitDir, _ := git(ctx, cwd, "rev-parse", "--absolute-git-dir")
		commonDir, _ := git(ctx, cwd, "rev-parse", "--git-common-dir")
		if !filepath.IsAbs(commonDir) {
			commonDir = filepath.Join(cwd, commonDir)
		}
		linked := canonical(gitDir) != canonical(commonDir)
		branch, _ := git(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
		repoRoot := top
		if linked {
			// 主仓库根 = common dir 的宿主目录
			repoRoot = filepath.Dir(canonical(commonDir))
		}
		external := false
		if linked {
			cb, cbErr := git(ctx, top, "config", "--worktree", "--get", "roam.createdby")
			external = cbErr != nil || strings.TrimSpace(cb) != "roam"
		}
		hit = &AnnotationHit{Repo: repoRoot, Worktree: top, Branch: strings.TrimSpace(branch), Linked: linked, External: external}
	}
	cwdCacheMu.Lock()
	cwdCache[cwd] = cwdInfo{at: time.Now(), hit: hit}
	cwdCacheMu.Unlock()
	return hit
}

// Annotations 返回 {session → {primary, matches[], ambiguous}}。
func (s *Service) Annotations(ctx context.Context) map[string]*Annotation {
	res := map[string]*Annotation{}
	for _, p := range tmuxPanes(ctx) {
		hit := resolveCwd(ctx, p.Cwd)
		if hit == nil {
			continue
		}
		a := res[p.Session]
		if a == nil {
			a = &Annotation{}
			res[p.Session] = a
		}
		dup := false
		for _, m := range a.Matches {
			if m.Worktree == hit.Worktree {
				dup = true
				break
			}
		}
		if !dup {
			a.Matches = append(a.Matches, *hit)
		}
		if p.Active {
			h := *hit
			a.Primary = &h
		}
	}
	for _, a := range res {
		a.Ambiguous = len(a.Matches) > 1
		if a.Primary == nil && len(a.Matches) > 0 {
			h := a.Matches[0]
			a.Primary = &h
		}
	}
	return res
}

// ── DiffBase ─────────────────────────────────────────────

type FileStat struct {
	Path   string `json:"path"`
	Adds   int    `json:"adds"`
	Dels   int    `json:"dels"`
	Binary bool   `json:"binary"`
}

type DiffPart struct {
	Files []FileStat `json:"files"`
	Adds  int        `json:"adds"`
	Dels  int        `json:"dels"`
}

type DiffResp struct {
	Base        string   `json:"base"`
	MergeBase   string   `json:"mergeBase"`
	Committed   DiffPart `json:"committed"`   // mergeBase..HEAD（已提交差异）
	WorkingTree DiffPart `json:"workingTree"` // 未提交改动（另算，不与上混）
	Untracked   int      `json:"untracked"`
}

func parseNumstat(out string) DiffPart {
	var p DiffPart
	for _, l := range strings.Split(out, "\n") {
		parts := strings.SplitN(l, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		f := FileStat{Path: parts[2]}
		if parts[0] == "-" || parts[1] == "-" {
			f.Binary = true
		} else {
			f.Adds, _ = strconv.Atoi(parts[0])
			f.Dels, _ = strconv.Atoi(parts[1])
		}
		p.Adds += f.Adds
		p.Dels += f.Dels
		p.Files = append(p.Files, f)
	}
	return p
}

func (s *Service) DiffBase(ctx context.Context, path string) (DiffResp, error) {
	path = canonical(path)
	base, e := git(ctx, path, "config", "--worktree", "--get", "roam.baseref")
	if e != nil || strings.TrimSpace(base) == "" {
		return DiffResp{}, errf("BASE_UNKNOWN", "worktree has no recorded base (external worktree?)")
	}
	base = strings.TrimSpace(base)
	mb, e := git(ctx, path, "merge-base", base, "HEAD")
	if e != nil {
		return DiffResp{}, errf("GIT_ERROR", "merge-base: %s", mb)
	}
	mb = strings.TrimSpace(mb)
	resp := DiffResp{Base: base, MergeBase: mb}
	if out, e := git(ctx, path, "diff", "--numstat", mb, "HEAD"); e == nil {
		resp.Committed = parseNumstat(out)
	}
	if out, e := git(ctx, path, "diff", "--numstat", "HEAD"); e == nil {
		resp.WorkingTree = parseNumstat(out)
	}
	if out, e := git(ctx, path, "ls-files", "--others", "--exclude-standard"); e == nil && out != "" {
		resp.Untracked = len(strings.Split(out, "\n"))
	}
	return resp, nil
}

// DiffBaseFile 返回单文件相对 mergeBase 的统一 diff 文本（W3 对比视图点开文件用）。
func (s *Service) DiffBaseFile(ctx context.Context, path, file string) (string, error) {
	path = canonical(path)
	base, e := git(ctx, path, "config", "--worktree", "--get", "roam.baseref")
	if e != nil || strings.TrimSpace(base) == "" {
		return "", errf("BASE_UNKNOWN", "worktree has no recorded base")
	}
	mb, e := git(ctx, path, "merge-base", strings.TrimSpace(base), "HEAD")
	if e != nil {
		return "", errf("GIT_ERROR", "merge-base: %s", mb)
	}
	out, e := git(ctx, path, "diff", strings.TrimSpace(mb), "HEAD", "--", file)
	if e != nil {
		return "", errf("GIT_ERROR", "%s", out)
	}
	return out, nil
}

// ── Merge ────────────────────────────────────────────────

type MergeReq struct {
	Path         string `json:"path"`
	Strategy     string `json:"strategy"` // merge | squash | rebase
	ExpectedHead string `json:"expectedHead,omitempty"`
}

type MergeResp struct {
	Strategy  string `json:"strategy"`
	Base      string `json:"base"`
	MergedOid string `json:"mergedOid"`
}

func conflictFiles(ctx context.Context, dir string) []string {
	out, _ := git(ctx, dir, "diff", "--name-only", "--diff-filter=U")
	if strings.TrimSpace(out) == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

func inProgress(ctx context.Context, dir string) string {
	for _, p := range []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "sequencer"} {
		gp, err := git(ctx, dir, "rev-parse", "--git-path", p)
		if err != nil {
			continue
		}
		if !filepath.IsAbs(gp) {
			gp = filepath.Join(dir, gp)
		}
		if pathExists(gp) {
			return p
		}
	}
	return ""
}

func isClean(ctx context.Context, dir string) bool {
	out, err := git(ctx, dir, "status", "--porcelain=v1")
	return err == nil && strings.TrimSpace(out) == ""
}

// baseSite 找 checkout 了 base 的 worktree；没有则建临时 integration worktree。
// 返回 (执行位路径, 清理函数, error)。
func (s *Service) baseSite(ctx context.Context, repo Repo, base string) (string, func(), error) {
	out, e := git(ctx, repo.Root, "worktree", "list", "--porcelain")
	if e != nil {
		return "", nil, errf("GIT_ERROR", "%s", out)
	}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			cur = canonical(p)
		}
		if strings.TrimPrefix(line, "branch ") == "refs/heads/"+base && cur != "" {
			return cur, func() {}, nil
		}
	}
	// 临时 integration worktree（base 未被任何 worktree checkout 时才可能成功）
	tmp := filepath.Join(repo.Root, ".worktrees", fmt.Sprintf("_integr-%d", time.Now().UnixNano()))
	if out, e := git(ctx, repo.Root, "worktree", "add", "--", tmp, base); e != nil {
		return "", nil, errf("BASE_WORKTREE_NOT_FOUND", "base %q is not checked out anywhere and temp worktree failed: %s", base, out)
	}
	cleanup := func() {
		_, _ = git(ctx, repo.Root, "worktree", "remove", "--force", "--", tmp)
	}
	return tmp, cleanup, nil
}

func (s *Service) Merge(ctx context.Context, req MergeReq) (MergeResp, error) {
	path := canonical(req.Path)
	repo, err := s.ResolveRepo(ctx, path)
	if err != nil {
		return MergeResp{}, err
	}
	base, e := git(ctx, path, "config", "--worktree", "--get", "roam.baseref")
	if e != nil || strings.TrimSpace(base) == "" {
		return MergeResp{}, errf("BASE_UNKNOWN", "refusing to merge a worktree without recorded base")
	}
	base = strings.TrimSpace(base)
	srcBranch, e := git(ctx, path, "rev-parse", "--abbrev-ref", "HEAD")
	if e != nil || srcBranch == "HEAD" {
		return MergeResp{}, errf("DETACHED_HEAD", "source worktree is not on a branch")
	}

	unlock, err := s.lock(repo)
	if err != nil {
		return MergeResp{}, err
	}
	defer unlock()
	defer s.invalidate(repo)

	// 确认后漂移防护
	head, _ := git(ctx, path, "rev-parse", "HEAD")
	if req.ExpectedHead != "" && !strings.HasPrefix(head, req.ExpectedHead) {
		return MergeResp{}, errf("HEAD_MOVED", "worktree HEAD changed since confirmation (expected %s, got %s)", req.ExpectedHead, head)
	}
	if p := inProgress(ctx, path); p != "" {
		return MergeResp{}, errf("OPERATION_IN_PROGRESS", "source worktree has %s in progress", p)
	}

	site, cleanup, err := s.baseSite(ctx, repo, base)
	if err != nil {
		return MergeResp{}, err
	}
	defer cleanup()
	if p := inProgress(ctx, site); p != "" {
		return MergeResp{}, errf("OPERATION_IN_PROGRESS", "base worktree has %s in progress", p)
	}
	if !isClean(ctx, site) {
		return MergeResp{}, errf("BASE_DIRTY", "worktree holding %q has uncommitted changes; commit or stash there first", base)
	}

	conflictErr := func(stage, dir, out string) error {
		files := conflictFiles(ctx, dir)
		return &Err{Code: "MERGE_CONFLICT", Message: strings.TrimSpace(out), Extra: map[string]any{
			"stage": stage, "strategy": req.Strategy, "conflictFiles": files, "recovered": true,
		}}
	}

	switch req.Strategy {
	case "merge":
		if out, e := gitID(ctx, site, "merge", "--no-edit", "--", srcBranch); e != nil {
			err := conflictErr("merge", site, out)
			_, _ = git(ctx, site, "merge", "--abort")
			return MergeResp{}, err
		}
	case "squash":
		if out, e := git(ctx, site, "merge", "--squash", "--", srcBranch); e != nil {
			err := conflictErr("merge", site, out)
			if _, e2 := git(ctx, site, "merge", "--abort"); e2 != nil {
				_, _ = git(ctx, site, "reset", "--merge")
			}
			return MergeResp{}, err
		}
		if out, e := gitID(ctx, site, "commit", "--no-verify", "-m", fmt.Sprintf("squash: merge %s into %s (roam)", srcBranch, base)); e != nil {
			_, _ = git(ctx, site, "reset", "--merge")
			return MergeResp{}, errf("COMMIT_FAILED", "%s", out)
		}
	case "rebase":
		// 第一步：在 source worktree 把 source rebase onto base
		if out, e := gitID(ctx, path, "rebase", "--", base); e != nil {
			err := conflictErr("rebase", path, out)
			_, _ = git(ctx, path, "rebase", "--abort")
			return MergeResp{}, err
		}
		// 第二步：base 快进到 source
		if out, e := git(ctx, site, "merge", "--ff-only", "--", srcBranch); e != nil {
			return MergeResp{}, errf("FF_FAILED", "base cannot fast-forward after rebase: %s", out)
		}
	default:
		return MergeResp{}, errf("BAD_STRATEGY", "unknown strategy %q (merge|squash|rebase)", req.Strategy)
	}
	merged, _ := git(ctx, site, "rev-parse", "HEAD")
	return MergeResp{Strategy: req.Strategy, Base: base, MergedOid: strings.TrimSpace(merged)}, nil
}

// ── Remove / Prune ───────────────────────────────────────

type RemoveReq struct {
	Path              string `json:"path"`
	ForceWorktree     bool   `json:"forceWorktree"`     // 脏也删
	DeleteBranch      bool   `json:"deleteBranch"`      // git branch -d
	ForceDeleteBranch bool   `json:"forceDeleteBranch"` // git branch -D（未合并也删）
	IgnoreSessions    bool   `json:"-"`                 // 组合编排内部用（已先杀会话）
}

func (s *Service) Remove(ctx context.Context, req RemoveReq) error {
	path := canonical(req.Path)
	repo, err := s.ResolveRepo(ctx, path)
	if err != nil {
		return err
	}
	if path == repo.Root {
		return errf("MAIN_WORKTREE", "refusing to remove the main worktree")
	}
	unlock, err := s.lock(repo)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.invalidate(repo)

	// 占用检查：还有 session/pane 在里面默认禁止删
	if !req.IgnoreSessions {
		var inside []string
		for _, p := range tmuxPanes(ctx) {
			if underPath(p.Cwd, path) {
				inside = append(inside, p.Session)
			}
		}
		if len(inside) > 0 {
			return &Err{Code: "SESSIONS_INSIDE", Message: "sessions are still using this worktree", Extra: map[string]any{"sessions": dedup(inside)}}
		}
	}
	branch, _ := git(ctx, path, "rev-parse", "--abbrev-ref", "HEAD")
	if !req.ForceWorktree {
		st, _ := git(ctx, path, "status", "--porcelain=v1")
		if strings.TrimSpace(st) != "" {
			dirty, untracked := 0, 0
			for _, l := range strings.Split(st, "\n") {
				if strings.HasPrefix(l, "??") {
					untracked++
				} else if strings.TrimSpace(l) != "" {
					dirty++
				}
			}
			return &Err{Code: "WORKTREE_DIRTY", Message: "worktree has uncommitted changes", Extra: map[string]any{"dirty": dirty, "untracked": untracked}}
		}
	}
	args := []string{"worktree", "remove"}
	if req.ForceWorktree {
		args = append(args, "--force")
	}
	args = append(args, "--", path)
	if out, e := git(ctx, repo.Root, args...); e != nil {
		return errf("WORKTREE_REMOVE_FAILED", "%s", out)
	}
	if (req.DeleteBranch || req.ForceDeleteBranch) && branch != "" && branch != "HEAD" {
		flag := "-d"
		if req.ForceDeleteBranch {
			flag = "-D"
		}
		if out, e := git(ctx, repo.Root, "branch", flag, "--", branch); e != nil {
			return &Err{Code: "BRANCH_NOT_MERGED", Message: strings.TrimSpace(out), Extra: map[string]any{"branch": branch, "worktreeRemoved": true}}
		}
	}
	return nil
}

func (s *Service) Prune(ctx context.Context, dir string) error {
	repo, err := s.ResolveRepo(ctx, dir)
	if err != nil {
		return err
	}
	unlock, err := s.lock(repo)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.invalidate(repo)
	if out, e := git(ctx, repo.Root, "worktree", "prune"); e != nil {
		return errf("PRUNE_FAILED", "%s", out)
	}
	return nil
}

// CommitAll 把 worktree 里全部改动（含未跟踪）提交为一笔；无改动时为 no-op。
// 供 close-with-worktree 的「合并并删除」先落一笔 wip 用。
func (s *Service) CommitAll(ctx context.Context, path, msg string) error {
	path = canonical(path)
	if isClean(ctx, path) {
		return nil
	}
	if out, e := git(ctx, path, "add", "-A"); e != nil {
		return errf("GIT_ERROR", "add -A: %s", out)
	}
	if out, e := gitID(ctx, path, "commit", "--no-verify", "-m", msg); e != nil {
		return errf("COMMIT_FAILED", "%s", out)
	}
	return nil
}

// Head 返回 worktree 当前 HEAD OID（编排层做确认后漂移校验用，如 crown 冻结）。
func (s *Service) Head(ctx context.Context, path string) (string, error) {
	out, e := git(ctx, canonical(path), "rev-parse", "--verify", "HEAD")
	if e != nil {
		return "", errf("GIT_ERROR", "rev-parse HEAD: %s", out)
	}
	return strings.TrimSpace(out), nil
}

// Branches 返回本地分支列表与默认 base（W1 start-from 选择器用）。
func (s *Service) Branches(ctx context.Context, dir string) ([]string, string, error) {
	repo, err := s.ResolveRepo(ctx, dir)
	if err != nil {
		return nil, "", err
	}
	out, e := git(ctx, repo.Root, "for-each-ref", "refs/heads", "--format=%(refname:short)", "--sort=-committerdate")
	if e != nil {
		return nil, "", errf("GIT_ERROR", "%s", out)
	}
	var branches []string
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) != "" {
			branches = append(branches, strings.TrimSpace(l))
		}
	}
	return branches, s.defaultBase(ctx, repo), nil
}

func dedup(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
