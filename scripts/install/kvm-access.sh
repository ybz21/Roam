# scripts/install/kvm-access.sh — /dev/kvm 的访问权：能拿就拿，拿不了就把命令说清楚。
#
# 没有 KVM，本机 Android 模拟器（QEMU+KVM）根本起不来，界面上只剩一句「无权访问 /dev/kvm」。
#
# 权限有两条来路，两条都要，因为它们管的时间段不一样：
#   setfacl  立刻生效（ACL 按 uid 匹配，连正在跑的 roam 都能开），但它是 logind 挂的，
#            换个座位会话就被重挂掉，也不过重启
#   kvm 组   持久、重启后照样在，代价是附加组在进程创建时定死 —— 要新登录才带得上
# ACL 管「现在」，组管「以后」。中间那段（加了组还没重新登录）由后端套 sg 兜住，
# 见 backend/phone/kvm.go。
#
# **提权按仓库既有的规矩**（lib/platform.sh 的 can_autoinstall）：root / 免密 sudo /
# 交互式终端才动手，否则只打印命令。curl|bash 和 systemd 下 stdin 不是终端，
# 这时候去 sudo 只会卡在密码输入上 —— 一个装到一半卡死的安装器比不装更难查。
# shellcheck shell=bash

# kvm_can_elevate 现在动 sudo 会不会卡住。
kvm_can_elevate() {
    [ "$(id -u)" -eq 0 ] && return 0
    command -v sudo >/dev/null 2>&1 || return 1
    sudo -n true 2>/dev/null && return 0   # 免密 sudo
    [ -t 0 ]                               # 交互式终端：允许弹密码
}

kvm_usable() { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }

# kvm_in_group 组数据库里有没有这个用户（不是「本进程带没带上」——那是后端管的事）。
kvm_in_group() {
    getent group kvm 2>/dev/null | grep -q "[:,]${USER}\(,\|$\)"
}

kvm_manual_hint() {
    echo "    sudo gpasswd -a \$USER kvm && sudo setfacl -m u:\$USER:rw /dev/kvm"
}

# kvm_ensure [say] — say 是一个接收单行消息的函数名，默认 echo。
#
# 拿不到就说清楚，绝不假装成功：装上一个不生效的授权比没有更糟 —— 以为有闸，于是不再管它。
# 所以判据一律是**回读设备/组数据库**，不是命令返回码。
kvm_ensure() {
    local say="${1:-echo}"
    [ "$(uname -s)" = Linux ] || return 0                 # macOS 用 HVF，不碰 /dev/kvm
    if [ "${ROAM_NO_KVM:-0}" = 1 ]; then
        $say "ROAM_NO_KVM=1：跳过 /dev/kvm 授权（本机模拟器将起不来）"; return 0
    fi
    # 机器上没有这个设备就整段跳过：云主机大多如此，不该为一个用不上的功能弹口令框。
    [ -e /dev/kvm ] || return 0
    kvm_usable && { $say "KVM 已就绪（本机模拟器可用）"; return 0; }

    if ! kvm_can_elevate; then
        $say "无权访问 /dev/kvm，本机模拟器起不来。在终端里跑一次即可（只需一次）："
        kvm_manual_hint
        return 0
    fi

    local sudo=""; [ "$(id -u)" -ne 0 ] && sudo=sudo
    $say "无权访问 /dev/kvm，申请授权（可能需要 sudo 口令）..."
    getent group kvm >/dev/null 2>&1 || $sudo groupadd -r kvm 2>/dev/null || true
    $sudo gpasswd -a "$USER" kvm >/dev/null 2>&1 || $sudo usermod -aG kvm "$USER" 2>/dev/null || true

    # setfacl 来自 acl 包，不是每台机器都有；缺了就补，补不上也只是少了「立刻生效」这半。
    if ! command -v setfacl >/dev/null 2>&1; then
        if   command -v apt-get >/dev/null; then $sudo apt-get install -y -qq acl 2>/dev/null
        elif command -v dnf     >/dev/null; then $sudo dnf install -y acl 2>/dev/null
        elif command -v pacman  >/dev/null; then $sudo pacman -Sy --noconfirm acl 2>/dev/null
        elif command -v zypper  >/dev/null; then $sudo zypper -n install acl 2>/dev/null
        elif command -v apk     >/dev/null; then $sudo apk add acl 2>/dev/null
        fi
    fi
    command -v setfacl >/dev/null 2>&1 && $sudo setfacl -m "u:$USER:rw" /dev/kvm 2>/dev/null

    if kvm_usable; then
        $say "KVM 已授权（已加入 kvm 组，重启后依然有效）"
    elif kvm_in_group; then
        $say "已加入 kvm 组（重新登录后生效；在那之前 roam 会自动借 sg 起模拟器）"
    else
        $say "KVM 授权未成功，本机模拟器起不来。手动执行："
        kvm_manual_hint
    fi
}
