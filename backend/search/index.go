package search

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 跳过的目录：产物、依赖、缓存。搜文件时它们只会淹没结果——没人想在搜索框里
// 翻 node_modules 里的第 4000 个 index.js。`.github` 这类点目录是有用的，所以
// 不按「点开头一律跳过」处理，只按名单跳。
var skipDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "bower_components": true, "vendor": true,
	"dist": true, "build": true, "out": true, "target": true,
	".next": true, ".nuxt": true, ".turbo": true, ".gradle": true,
	"__pycache__": true, ".venv": true, "venv": true, ".tox": true,
	".cache": true, ".pytest_cache": true, ".mypy_cache": true,
	".idea": true, ".DS_Store": true,
	// roam 自己的 worktree 落在仓库内的 .worktrees/ 下：不跳的话同一个文件会以
	// 「主仓库一份 + 每个 worktree 一份」出现在结果里，同名多行谁也分不清
	".worktrees": true,
}

// FileIndex 是项目文件的名字索引：一个根目录一份相对路径清单，带 TTL。
//
// **遍历一定在后台做，请求永远不等它**。第一版是同步走树：八个项目里有几棵大的，
// 第一次按键就卡了半分钟，搜索框直接废掉。现在 Files() 立刻交出手头有的那一份
// （第一次可能是空的），同时在后台重建；建好后下一次按键就有了。
//
// 不做常驻 watcher。搜索是「打字时连着问」的场景，真正要压掉的是同一次输入里
// 反复走同一棵目录树；TTL 内复用清单就够了，代价是新建的文件最多晚 TTL 秒能搜到，
// 而一个 fsnotify 常驻监听要为此吃掉每个项目的 inotify 配额。
type FileIndex struct {
	mu    sync.Mutex
	roots map[string]*rootIndex

	TTL      time.Duration // 清单多久算过期
	MaxFiles int           // 单个根收录上限，超出即截断
	MaxVisit int           // 单次遍历访问条目上限
	MaxWalk  time.Duration // 单次遍历时间预算：再大的树也不许无限走下去
}

type rootIndex struct {
	at        time.Time
	files     []string
	truncated bool
	building  bool
}

func NewFileIndex() *FileIndex {
	return &FileIndex{
		roots: map[string]*rootIndex{},
		// 上限给得比「一个正常项目」大不少：真实的项目里常混着反编译产物、素材库这类
		// 几万文件的子树，卡在 3 万条的话，排在它后面的 docs/ 整个进不了索引——
		// 用户搜得到一堆 .java，却搜不到自己上周写的那篇文档。
		TTL: 120 * time.Second, MaxFiles: 60000, MaxVisit: 400000, MaxWalk: 15 * time.Second,
	}
}

// Files 立刻返回手头的文件相对路径清单，绝不阻塞。
//
//	truncated 清单被条数/时间上限截断了
//	ready     这个根**至少建成过一次**；false = 还没有任何清单可用（首次建索引中）。
//	          过期后的后台重建不算「没准备好」——手上那份还能用，提示「正在建索引」
//	          只会让人以为搜索坏了。
func (ix *FileIndex) Files(root string) (files []string, truncated bool, ready bool) {
	root = filepath.Clean(root)
	if root == "" || !filepath.IsAbs(root) {
		return nil, false, true
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	r := ix.roots[root]
	if r == nil {
		r = &rootIndex{}
		ix.roots[root] = r
	}
	built := !r.at.IsZero()
	fresh := built && time.Since(r.at) < ix.ttl()
	if !fresh && !r.building {
		r.building = true
		go func() {
			files, truncated := ix.walk(root)
			ix.mu.Lock()
			// 整片替换切片头，不就地改——已经拿走旧切片的读者照样安全
			r.files, r.truncated, r.at, r.building = files, truncated, time.Now(), false
			ix.mu.Unlock()
		}()
	}
	return r.files, r.truncated, built
}

// Rebuild 同步重建一个根的索引（预热与测试用；正常请求路径走 Files）。
func (ix *FileIndex) Rebuild(root string) ([]string, bool) {
	root = filepath.Clean(root)
	files, truncated := ix.walk(root)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	r := ix.roots[root]
	if r == nil {
		r = &rootIndex{}
		ix.roots[root] = r
	}
	r.files, r.truncated, r.at, r.building = files, truncated, time.Now(), false
	return files, truncated
}

// Invalidate 丢弃某个根的缓存（目录被删/改名后由调用方清）。root 为空则清空全部。
func (ix *FileIndex) Invalidate(root string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if root == "" {
		ix.roots = map[string]*rootIndex{}
		return
	}
	delete(ix.roots, filepath.Clean(root))
}

func (ix *FileIndex) ttl() time.Duration {
	if ix.TTL <= 0 {
		return 60 * time.Second
	}
	return ix.TTL
}

func (ix *FileIndex) walk(root string) ([]string, bool) {
	maxFiles, maxVisit, budget := ix.MaxFiles, ix.MaxVisit, ix.MaxWalk
	if maxFiles <= 0 {
		maxFiles = 30000
	}
	if maxVisit <= 0 {
		maxVisit = 200000
	}
	if budget <= 0 {
		budget = 15 * time.Second
	}
	deadline := time.Now().Add(budget)
	files := make([]string, 0, 512)
	visited := 0
	truncated := false
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 读不动的条目跳过，不要整棵树失败
		}
		visited++
		if len(files) >= maxFiles || visited >= maxVisit {
			truncated = true
			return filepath.SkipAll
		}
		// 时间预算每 512 个条目查一次：网络盘/超深目录上，条数上限可能远远到不了
		if visited%512 == 0 && time.Now().After(deadline) {
			truncated = true
			return filepath.SkipAll
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil // 软链不跟：跟了会绕回自己，也会把别处的树算进这个项目
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil || strings.HasPrefix(rel, "..") {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	return files, truncated
}
