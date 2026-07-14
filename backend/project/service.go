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
