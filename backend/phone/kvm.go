// kvm.go：本机模拟器能不能用上 KVM，以及用不上时缺的到底是哪一步。
//
// 单独成文是因为它有三种「起不来」，用户看到的却常常是同一句话：
//
//	没有 /dev/kvm      机器/虚拟机本身没开虚拟化 —— 谁也救不了，只能说清楚
//	组里没名字          要一次 sudo：把用户加进 kvm 组
//	组里有名字、进程没带  加过组但没重新登录 —— 命令明明成功了，模拟器还是起不来
//
// 第三种最坑：附加组是进程创建时定死的，systemd 的用户实例也是登录时定死的，
// `systemctl --user restart roam` 换不来新组，用户于是以为那条 sudo 没生效。
// 这一档我们自己兜住（见 sgCommand），不让它变成一次「重启试试」。
package phone

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

// kvmFixHint 是缺权限时给用户的那条命令。两条都要，分工不同：
// setfacl 立刻生效（ACL 按 uid 匹配，正在跑的进程也能开），但它是 logind 挂的，
// 换个座位会话就会被重挂掉；gpasswd 才持久，代价是要新登录才带得上。
const kvmFixHint = "sudo gpasswd -a $USER kvm && sudo setfacl -m u:$USER:rw /dev/kvm"

// kvmAccess 是本进程此刻对 /dev/kvm 的处境。
type kvmAccess int

const (
	kvmOK       kvmAccess = iota // 直接开得了
	kvmViaGroup                  // 组里有名字，本进程没带上 —— 借 sg 就能起
	kvmNoDevice                  // 机器上就没有这个设备
	kvmDenied                    // 有设备、没权限、组里也没名字
)

// kvmState 判断当前进程能不能真的用上 KVM。
//
// 必须真开一次而不是 Stat：/dev/kvm 常年在那儿，权限却是 logind 按会话动态挂的 ACL，
// 文件存在和当前进程能不能用完全是两回事。
func kvmState() (kvmAccess, error) {
	f, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err == nil {
		f.Close()
		return kvmOK, nil
	}
	if os.IsNotExist(err) {
		return kvmNoDevice, errors.New("没有 /dev/kvm：模拟器需要 KVM（虚拟机里要先开嵌套虚拟化）")
	}
	if os.IsPermission(err) {
		if kvmGroupPending() {
			return kvmViaGroup, nil
		}
		return kvmDenied, errors.New("无权访问 /dev/kvm，跑一次：" + kvmFixHint)
	}
	return kvmDenied, fmt.Errorf("/dev/kvm 不可用: %w", err)
}

// kvmUsable 保留给「只想知道行不行」的调用方；kvmViaGroup 算行，因为我们会套 sg 起。
func kvmUsable() error {
	st, err := kvmState()
	if st == kvmOK || st == kvmViaGroup {
		return nil
	}
	return err
}

// kvmGroupPending 报「/etc/group 里已经加过 kvm 组，但本进程没带上」。
func kvmGroupPending() bool {
	g, err := user.LookupGroup("kvm")
	if err != nil {
		return false
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return false
	}
	have, err := syscall.Getgroups()
	if err != nil {
		return false
	}
	u, err := user.Current()
	if err != nil {
		return false
	}
	ids, err := u.GroupIds() // 查的是组数据库，不是本进程 —— 两者不一致正是我们要认的那一格
	if err != nil {
		return false
	}
	return groupPending(gid, g.Gid, have, ids)
}

// groupPending 是上面那个判断的纯函数部分：组数据库里有、本进程组里没有。
func groupPending(gid int, gidStr string, procGIDs []int, userGIDs []string) bool {
	for _, x := range procGIDs {
		if x == gid {
			return false // 组已经带上了，还开不了就不是组的事（多半是 SELinux/权限位）
		}
	}
	for _, s := range userGIDs {
		if s == gidStr {
			return true
		}
	}
	return false
}

// sgCommand 在需要时把命令套进 `sg kvm -c "…"`。
//
// sg 会照组数据库重算整套组再执行，这正是「加了组但没重新登录」缺的那一下，
// 而且不要口令 —— 用户本来就是成员。副作用只有一个：这条命令新建的文件属组变成 kvm，
// 落在 AVD 自己的镜像文件上，无碍。
//
// 找不到 sg（shadow-utils 没装）就原样返回：起不来时的报错仍然说得清该干什么。
func sgCommand(lookPath func(string) (string, error), group, bin string, args []string) (string, []string) {
	sg, err := lookPath("sg")
	if err != nil {
		return bin, args
	}
	return sg, []string{group, "-c", shJoin(append([]string{bin}, args...))}
}

// shJoin 把参数拼成一行安全的 shell 命令：sg -c 收的是字符串，不是 argv。
// 一律单引号包起来，内部的单引号按 '\” 转义 —— SDK 路径里出现空格并不稀奇。
func shJoin(parts []string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, "'"+strings.ReplaceAll(p, "'", `'\''`)+"'")
	}
	return strings.Join(out, " ")
}

// kvmSpawn 按当前处境决定「用什么命令起模拟器」。
func kvmSpawn(st kvmAccess, bin string, args []string) (string, []string) {
	if st != kvmViaGroup {
		return bin, args
	}
	return sgCommand(exec.LookPath, "kvm", bin, args)
}
