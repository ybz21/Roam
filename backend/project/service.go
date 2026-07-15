// Package project 实现「项目 = git 仓库」的弱台账（knownRepos）与 UI 偏好持久化
// （<dataDir>/projects.json，08 设计 §2.1/§5.2）。项目本身是读模型：发现 = 会话
// cwd join 的副作用（api 层聚合时 Touch），退场 = 读时收敛；git/session 真相源
// 不在此——文件丢失只损失「零会话仓库的可发现性」与置顶等偏好，活跃仓库下次
// 开会话即重建。
package project

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Prefs 是项目的 UI 偏好（PATCH /projects/:key/prefs 可改）。
type Prefs struct {
	Pinned       bool   `json:"pinned,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
	DefaultAgent string `json:"defaultAgent,omitempty"`
	DefaultBase  string `json:"defaultBase,omitempty"`
}

// Entry 是台账里的一个仓库：dir 为 canonical 主仓库根（来自 cwd join 的
// AnnotationHit.Repo 或显式创建时的 ResolveRepo，均已 canonical 化）。
// Origin 区分两条入册通道：
//   - "user"：用户显式创建（POST /projects）——一等对象，永不自动退场，只能显式 DELETE；
//   - ""（discovered）：会话 cwd join 自动发现——按退场规则读时收敛。
type Entry struct {
	Dir    string `json:"dir"`
	Origin string `json:"origin,omitempty"`
	Prefs
	FirstSeen int64 `json:"firstSeen"`
	LastSeen  int64 `json:"lastSeen"`
}

type fileShape struct {
	Repos map[string]*Entry `json:"repos"`
}

// Store 单写者：所有变更持内存互斥锁，落盘 tmp+rename 原子替换（同 RaceStore 体例）。
type Store struct {
	mu    sync.Mutex
	path  string
	repos map[string]*Entry
}

func NewStore(dataDir string) *Store {
	s := &Store{repos: map[string]*Entry{}}
	if dataDir != "" {
		s.path = filepath.Join(dataDir, "projects.json")
		if b, err := os.ReadFile(s.path); err == nil {
			var f fileShape
			if json.Unmarshal(b, &f) == nil && f.Repos != nil {
				s.repos = f.Repos
			}
		}
	}
	return s
}

// save 持久化全量（调用方须持锁）。
func (s *Store) save() {
	if s.path == "" {
		return
	}
	b, err := json.MarshalIndent(fileShape{Repos: s.repos}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

// KeyFor 生成 repoKey：目录名 slug + 全路径短 hash（可读、稳定、路径不进 URL）。
func KeyFor(dir string) string {
	base := strings.ToLower(filepath.Base(dir))
	slug := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '-'
	}, base)
	slug = strings.Trim(slug, "-.")
	if slug == "" {
		slug = "repo"
	}
	h := sha1.Sum([]byte(dir))
	return slug + "-" + hex.EncodeToString(h[:])[:4]
}

// Touch 发现记账：不在册则记入（FirstSeen），在册则刷新 LastSeen。返回 repoKey。
func (s *Store) Touch(dir string) string {
	key := KeyFor(dir)
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.repos[key]; ok {
		if now-e.LastSeen >= 60 { // LastSeen 只按分钟粒度刷新，避免每次轮询都写盘
			e.LastSeen = now
			s.save()
		}
		return key
	}
	s.repos[key] = &Entry{Dir: dir, FirstSeen: now, LastSeen: now}
	s.save()
	return key
}

// Add 显式创建（POST /projects）：origin=user 的一等对象。已在册则升级为 user
// （发现来的条目被用户「转正」），并可顺带设显示名。返回 repoKey。
func (s *Store) Add(dir, displayName string) string {
	key := KeyFor(dir)
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.repos[key]
	if !ok {
		e = &Entry{Dir: dir, FirstSeen: now}
		s.repos[key] = e
	}
	e.Origin = "user"
	e.LastSeen = now
	if displayName != "" {
		e.DisplayName = displayName
	}
	s.save()
	return key
}

// Entries 返回台账快照（copy，供只读聚合遍历）。
func (s *Store) Entries() map[string]Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]Entry, len(s.repos))
	for k, e := range s.repos {
		out[k] = *e
	}
	return out
}

// Dir 反查 repoKey → 目录。API 只接受在册 key，顺带杜绝任意路径探测。
func (s *Store) Dir(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.repos[key]
	if !ok {
		return "", false
	}
	return e.Dir, true
}

// SetPrefs 原子改偏好；key 不在册返回 false。
func (s *Store) SetPrefs(key string, patch func(*Prefs)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.repos[key]
	if !ok {
		return false
	}
	patch(&e.Prefs)
	s.save()
	return true
}

// Remove 退场收敛（目录不存在，或 无 roam worktree ∧ 无会话 ∧ 未置顶——判定在聚合层）。
func (s *Store) Remove(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.repos[key]; ok {
		delete(s.repos, key)
		s.save()
	}
}

// ── 收尾留痕（08 §5.2）：<dataDir>/activity.log JSONL，只增不改 ──
// 不是任务真相源——丢弃删除后的提交不可达，留痕只保住「任务→动作→统计」的摘要。

// TraceEntry 一条收尾留痕。Action: merged | discarded | cleaned。
type TraceEntry struct {
	Repo     string `json:"repo"`
	Branch   string `json:"branch"`
	HeadOid  string `json:"headOid,omitempty"`
	Base     string `json:"base,omitempty"`
	Action   string `json:"action"`
	Strategy string `json:"strategy,omitempty"`
	At       int64  `json:"at"`
}

func (s *Store) tracePath() string {
	if s.path == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(s.path), "activity.log")
}

// Trace 追加留痕；超 5MB 轮转一代（.1），读放大有界。写失败只丢摘要，不影响主流程。
func (s *Store) Trace(e TraceEntry) {
	p := s.tracePath()
	if p == "" {
		return
	}
	if st, err := os.Stat(p); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(p, p+".1")
	}
	e.At = time.Now().Unix()
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

// ReadTrace 读某仓库的留痕（两代合并、新在前、上限 limit）。
func (s *Store) ReadTrace(repoDir string, limit int) []TraceEntry {
	p := s.tracePath()
	if p == "" {
		return nil
	}
	var out []TraceEntry
	for _, f := range []string{p + ".1", p} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var e TraceEntry
			if json.Unmarshal([]byte(line), &e) == nil && e.Repo == repoDir {
				out = append(out, e)
			}
		}
	}
	// 文件本身按时间追加，倒序 = 新在前
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Rekey 把条目迁移到新目录（typically 仓库子目录归位到根）。目标 key 已存在则
// 合并：置顶/origin=user/显示名等「用户意志」按或语义保留，不丢。
func (s *Store) Rekey(oldKey, newDir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.repos[oldKey]
	if !ok {
		return
	}
	delete(s.repos, oldKey)
	newKey := KeyFor(newDir)
	if dst, exists := s.repos[newKey]; exists {
		dst.Pinned = dst.Pinned || e.Pinned
		if dst.Origin == "" {
			dst.Origin = e.Origin
		}
		if dst.DisplayName == "" {
			dst.DisplayName = e.DisplayName
		}
		if e.FirstSeen > 0 && (dst.FirstSeen == 0 || e.FirstSeen < dst.FirstSeen) {
			dst.FirstSeen = e.FirstSeen
		}
	} else {
		e.Dir = newDir
		s.repos[newKey] = e
	}
	s.save()
}
