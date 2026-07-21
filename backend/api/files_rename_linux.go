//go:build linux

package api

import (
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace 原子改名，目标已存在时报 os.ErrExist 而不是静默覆盖。
func renameNoReplace(oldpath, newpath string) error {
	err := unix.Renameat2(unix.AT_FDCWD, oldpath, unix.AT_FDCWD, newpath, unix.RENAME_NOREPLACE)
	switch err {
	case nil:
		return nil
	case unix.EINVAL, unix.ENOSYS, unix.ENOTSUP:
		// 文件系统/内核不支持 RENAME_NOREPLACE：退化为 检查+改名
		return renameNoReplaceFallback(oldpath, newpath)
	default:
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
	}
}
