// 文件服务：供对话页（Claude / Codex）右侧文件侧栏浏览工作目录、查看文件内容。
// 整个 Web 控制台已是口令鉴权且提供终端全访问，这里读文件与之一致，不再额外限制根目录。
package api

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

type fileEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}

// Files GET /files?path=<dir> —— 列出目录内容（目录在前，按名排序）。
func (a *API) Files(c *gin.Context) {
	p := c.Query("path")
	if p == "" {
		home, _ := os.UserHomeDir()
		p = home
	}
	p = filepath.Clean(p)
	entries, err := os.ReadDir(p)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "FS_ERROR", "message": err.Error()}})
		return
	}
	list := []fileEntry{}
	for _, e := range entries {
		var size int64
		if info, err := e.Info(); err == nil {
			size = info.Size()
		}
		list = append(list, fileEntry{Name: e.Name(), Dir: e.IsDir(), Size: size})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Dir != list[j].Dir {
			return list[i].Dir // 目录排前
		}
		return list[i].Name < list[j].Name
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "parent": filepath.Dir(p), "entries": list}})
}

const fileReadCap = 512 * 1024 // 单文件正文上限，超出截断

// File GET /file?path=<file> —— 读取文件内容（限大小；含 NUL 的二进制不返回正文）。
func (a *API) File(c *gin.Context) {
	p := filepath.Clean(c.Query("path"))
	if p == "" || !filepath.IsAbs(p) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_FILE"}})
		return
	}
	f, err := os.Open(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "READ_ERROR", "message": err.Error()}})
		return
	}
	defer f.Close()

	data, _ := io.ReadAll(io.LimitReader(f, fileReadCap+1))
	truncated := false
	if len(data) > fileReadCap {
		data = data[:fileReadCap]
		truncated = true
	}
	binary := bytes.IndexByte(data, 0) >= 0
	content := ""
	if !binary {
		content = string(data)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"path": p, "size": info.Size(), "truncated": truncated, "binary": binary, "content": content,
	}})
}

// FileRaw GET /file/raw?path=<file> —— 原样返回文件字节（图片等内联预览用，Content-Type 按扩展名嗅探）。
func (a *API) FileRaw(c *gin.Context) {
	p := filepath.Clean(c.Query("path"))
	if p == "" || !filepath.IsAbs(p) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_FILE"}})
		return
	}
	if c.Query("dl") != "" { // 强制下载（附件），带原文件名
		c.FileAttachment(p, filepath.Base(p))
		return
	}
	c.File(p)
}

// uniquePath 目标已存在时在扩展名前加 (1)/(2)… 避免覆盖。
func uniquePath(p string) string {
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand
		}
	}
}

// Upload POST /upload —— multipart 上传文件到指定目录(dir)。
// form: dir=<绝对目录> + 一个或多个 files=<文件>。返回保存后的绝对路径。
func (a *API) Upload(c *gin.Context) {
	dir := filepath.Clean(c.PostForm("dir"))
	if dir == "" || !filepath.IsAbs(dir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_DIR"}})
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_FORM", "message": err.Error()}})
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NO_FILE"}})
		return
	}
	saved := []string{}
	for _, fh := range files {
		name := filepath.Base(fh.Filename) // 去掉任何路径成分，防穿越
		if name == "" || name == "." || name == ".." {
			continue
		}
		dest := uniquePath(filepath.Join(dir, name))
		if err := c.SaveUploadedFile(fh, dest); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
			return
		}
		saved = append(saved, dest)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"dir": dir, "saved": saved}})
}
