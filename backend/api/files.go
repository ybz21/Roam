// 文件服务：供对话页（Claude / Codex）右侧文件侧栏浏览工作目录、查看文件内容。
// 整个 Web 控制台已是口令鉴权且提供终端全访问，这里读文件与之一致，不再额外限制根目录。
package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type fileEntry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Ctime int64  `json:"ctime"`
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
		var size, mtime, ctime int64
		if info, err := e.Info(); err == nil {
			size = info.Size()
			mtime = info.ModTime().Unix()
			ctime = fileCtime(info)
		}
		list = append(list, fileEntry{Name: e.Name(), Dir: e.IsDir(), Size: size, Mtime: mtime, Ctime: ctime})
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
		"path": p, "size": info.Size(), "mtime": info.ModTime().Unix(), "truncated": truncated, "binary": binary, "content": content,
	}})
}

// FileSave POST /file/save —— 覆盖写入已存在的普通文件内容（编辑器保存用）。
// 只允许覆盖既有普通文件（新建走 upload/mkdir），并保留原文件权限位。
func (a *API) FileSave(c *gin.Context) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_FORM", "message": err.Error()}})
		return
	}
	p := filepath.Clean(req.Path)
	if p == "" || !filepath.IsAbs(p) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_FILE"}})
		return
	}
	if err := os.WriteFile(p, []byte(req.Content), info.Mode().Perm()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	var size, mtime int64
	if ni, err := os.Stat(p); err == nil {
		size = ni.Size()
		mtime = ni.ModTime().Unix()
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "size": size, "mtime": mtime}})
}

// FileSearch GET /file/search?dir=<dir>&q=<query> —— 从 dir 递归按文件名模糊(子串,忽略大小写)搜文件。
// 有界：跳过 .git/node_modules，限制访问条目与返回条数，避免大目录卡死。
func (a *API) FileSearch(c *gin.Context) {
	dir := filepath.Clean(c.Query("dir"))
	q := strings.TrimSpace(c.Query("q"))
	if dir == "" || !filepath.IsAbs(dir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	type hit struct {
		Path string `json:"path"`
		Name string `json:"name"`
		Rel  string `json:"rel"`
	}
	results := []hit{}
	if q == "" {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"results": results, "truncated": false}})
		return
	}
	// 匹配器：优先当正则(忽略大小写、不锚定)；正则非法(如 *.py 以 * 开头)则按 glob 再试；
	// 都不行退化为子串包含。这样纯文字=子串，a*.py / *.py 等通配也能用。
	ql := strings.ToLower(q)
	re, err := regexp.Compile("(?i)" + q)
	if err != nil {
		re, err = regexp.Compile("(?i)^" + globToRegex(q) + "$")
		if err != nil {
			re = nil
		}
	}
	match := func(name string) bool {
		if re != nil {
			return re.MatchString(name)
		}
		return strings.Contains(strings.ToLower(name), ql)
	}
	const maxResults, maxVisited = 200, 50000
	visited := 0
	truncated := false
	skipDir := map[string]bool{".git": true, "node_modules": true}
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 跳过不可读条目
		}
		if len(results) >= maxResults || visited >= maxVisited {
			truncated = true
			return filepath.SkipAll
		}
		if d.IsDir() {
			if p != dir && skipDir[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		visited++
		if match(d.Name()) {
			rel, _ := filepath.Rel(dir, p)
			results = append(results, hit{Path: p, Name: d.Name(), Rel: rel})
		}
		return nil
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"results": results, "truncated": truncated}})
}

// globToRegex 把 shell 通配(*,?)转成正则片段，其余字符原样转义。用于 *.py 这类 glob 搜索。
func globToRegex(g string) string {
	var b strings.Builder
	for _, r := range g {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String()
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
		serveAttachment(c, p, filepath.Base(p))
		return
	}
	c.File(p)
}

var officePreviewExt = map[string]bool{
	".doc": true, ".docx": true, ".odt": true, ".rtf": true,
	".xls": true, ".xlsx": true, ".xlsm": true, ".ods": true,
	".ppt": true, ".pptx": true, ".odp": true,
}

// FilePreview GET /file/preview?path=<office-file> —— 使用本机 LibreOffice/soffice 转成 PDF 后内嵌预览。
func (a *API) FilePreview(c *gin.Context) {
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
	if !officePreviewExt[strings.ToLower(filepath.Ext(p))] {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "UNSUPPORTED_PREVIEW", "message": "此文件类型不支持 Office 预览"}})
		return
	}
	soffice := findSoffice()
	if soffice == "" {
		c.JSON(http.StatusNotImplemented, gin.H{"error": gin.H{"code": "PREVIEW_UNAVAILABLE", "message": "未安装 LibreOffice/soffice，无法生成 Office 预览"}})
		return
	}
	tmp, err := os.MkdirTemp("", "ttmux-office-preview-*")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "PREVIEW_ERROR", "message": err.Error()}})
		return
	}
	defer os.RemoveAll(tmp)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, soffice, "--headless", "--nologo", "--nofirststartwizard", "--convert-to", "pdf", "--outdir", tmp, p)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": gin.H{"code": "PREVIEW_TIMEOUT", "message": "Office 预览转换超时"}})
		return
	}
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "PREVIEW_ERROR", "message": msg}})
		return
	}
	pdfs, _ := filepath.Glob(filepath.Join(tmp, "*.pdf"))
	if len(pdfs) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "PREVIEW_ERROR", "message": "转换完成但未生成 PDF"}})
		return
	}
	c.Header("Content-Type", "application/pdf")
	c.Header("Content-Disposition", contentDisposition("inline", strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))+".pdf"))
	c.File(pdfs[0])
}

func findSoffice() string {
	for _, name := range []string{"libreoffice", "soffice"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func serveAttachment(c *gin.Context, path, filename string) {
	c.Header("Content-Disposition", contentDisposition("attachment", filename))
	if ct := mime.TypeByExtension(filepath.Ext(filename)); ct != "" {
		c.Header("Content-Type", ct)
	}
	c.File(path)
}

func contentDisposition(kind, filename string) string {
	if filename == "" {
		filename = "download"
	}
	ascii := asciiFilename(filename)
	return fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, kind, ascii, urlPathEscape(filename))
}

func urlPathEscape(s string) string {
	return strings.ReplaceAll(url.PathEscape(s), "%2F", "_")
}

func asciiFilename(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 32 || r == 127 || r == '\\' || r == '"' || r == '/' {
			b.WriteByte('_')
			continue
		}
		if r > 126 {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "download"
	}
	return out
}

// FileStat GET /file/stat?path=<file-or-dir> —— 判断路径是否存在以及是否目录。
func (a *API) FileStat(c *gin.Context) {
	p := filepath.Clean(c.Query("path"))
	if p == "" || !filepath.IsAbs(p) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": "路径不存在"}})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "FS_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "dir": info.IsDir(), "size": info.Size(), "mtime": info.ModTime().Unix()}})
}

// FileDelete DELETE /file?path=<file-or-empty-dir> —— 删除文件或空目录。
func (a *API) FileDelete(c *gin.Context) {
	p := filepath.Clean(c.Query("path"))
	if p == "" || !filepath.IsAbs(p) || p == string(filepath.Separator) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	info, err := os.Lstat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "missing": true}})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "FS_ERROR", "message": err.Error()}})
		return
	}
	if info.IsDir() {
		entries, err := os.ReadDir(p)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "READ_ERROR", "message": err.Error()}})
			return
		}
		if len(entries) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "DIR_NOT_EMPTY", "message": "目录非空，未删除"}})
			return
		}
	}
	if err := os.Remove(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "DELETE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "dir": info.IsDir()}})
}

// FileMkdir POST /file/mkdir —— 在指定目录(dir)下新建子目录(name)。返回创建后的绝对路径。
func (a *API) FileMkdir(c *gin.Context) {
	var req struct {
		Dir  string `json:"dir"`
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_FORM", "message": err.Error()}})
		return
	}
	dir := filepath.Clean(req.Dir)
	if dir == "" || !filepath.IsAbs(dir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_DIR"}})
		return
	}
	name := filepath.Base(strings.TrimSpace(req.Name)) // 去掉任何路径成分，防穿越
	if name == "" || name == "." || name == ".." {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_NAME", "message": "目录名无效"}})
		return
	}
	dest := filepath.Join(dir, name)
	if _, err := os.Stat(dest); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "EXISTS", "message": "同名文件或目录已存在"}})
		return
	}
	if err := os.Mkdir(dest, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "MKDIR_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": dest}})
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
	// paths[i] 与 files[i] 平行：上传文件夹时存相对路径(保留层级)，普通文件为空。
	// Go 的 multipart 会用 filepath.Base 抹掉 fh.Filename 的路径，故层级只能靠它传。
	paths := form.Value["paths"]
	saved := []string{}
	for i, fh := range files {
		name := fh.Filename
		if i < len(paths) && strings.TrimSpace(paths[i]) != "" {
			name = paths[i]
		}
		// 用 Clean("/"+name) 把任何 .. 折叠到根再去掉前导 /，杜绝路径穿越。
		rel := filepath.Clean("/" + filepath.ToSlash(name))
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" || rel == "." {
			continue
		}
		dest := uniquePath(filepath.Join(dir, rel))
		// 双保险：清理后仍须落在 dir 之内
		if r, err := filepath.Rel(dir, dest); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(os.PathSeparator)) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
			return
		}
		if err := c.SaveUploadedFile(fh, dest); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
			return
		}
		saved = append(saved, dest)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"dir": dir, "saved": saved}})
}
