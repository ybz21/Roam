//go:build !linux

package api

// renameNoReplace 非 Linux 平台没有 RENAME_NOREPLACE，用检查+改名尽力而为。
func renameNoReplace(oldpath, newpath string) error {
	return renameNoReplaceFallback(oldpath, newpath)
}
