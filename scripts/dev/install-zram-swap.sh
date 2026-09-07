#!/usr/bin/env bash
# 给这台机器加一块 zram 压缩交换区 —— 需要 root，跑一次即可，重启后仍在。
#
#   sudo bash scripts/dev/install-zram-swap.sh [大小]      # 例: sudo bash ... 16G
#
# 背景：2026-09-06 22:09，一个跑了一周的会话（Claude + 安卓模拟器，9.5G）连同
# 里面 20 个进程被 systemd-oomd 整条 scope 端掉，理由是 user@1000 的内存压力
# 85% 超过 50% 持续 20 秒。这台机器当时 8G swap 用掉 7.3G、zswap 关着、zram 没加载 ——
# **回收这个动作没有落点**。内核一遍遍扫 LRU（那一轮 pgscan 3700 万）一页也腾不出，
# PSI 于是永远降不下来，oomd 按压力选 victim，选中的就是压力最大的那个。
#
# 三层护栏各管一件事，这是补上的第四块地基：
#   - internal/memguard（L1）    单会话失控        → 硬顶 memory.max，只杀它自己
#   - internal/memthrottle（L2） 加起来把机器压垮   → 先主动压缩回收，再踩软刹车
#   - install-memory-guard.sh    真爆那一下         → 把 global OOM 关在用户切片里
#   - 本脚本                     回收出来的页往哪放 → 压进 zram，而不是无处可去
#
# 没有这一块，上面那层「压」和「踩」都是空转：L2 会检测到没落点、放弃动手，
# 转而在会话列表上提醒你来跑这个脚本（见 memalert.NoSwapRoom）。
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "✘ 需要 root：sudo bash $0 [大小]" >&2
  exit 1
fi

# 默认给物理内存的一半。zstd 在真实 agent 负载上压到 3:1 上下，所以「15G 的 zram」
# 最坏情况下也只占 5G 真内存，而它换来的是 15G 匿名页的落点。
ALGO="${ROAM_ZRAM_ALGO:-zstd}"
SIZE="${1:-$(awk '/MemTotal/ {printf "%dM", $2/2/1024}' /proc/meminfo)}"
PRIO=100 # 高于磁盘 swap（那条通常是 -1）：先压进内存，压不下了才落盘
EXEC=/usr/local/sbin/roam-zram-swap
UNIT=/etc/systemd/system/roam-zram-swap.service
SYSCTL=/etc/sysctl.d/60-roam-zram.conf

cat > "$EXEC" <<EXECEOF
#!/bin/sh
# Roam · zram 压缩交换区。由 scripts/dev/install-zram-swap.sh 写入。
set -e
STATE=/run/roam-zram.dev
case "\$1" in
  start)
    modprobe zram
    dev=\$(zramctl --find --size "$SIZE" --algorithm "$ALGO")
    mkswap "\$dev" >/dev/null
    swapon --priority $PRIO "\$dev"
    printf '%s' "\$dev" > "\$STATE"
    ;;
  stop)
    [ -f "\$STATE" ] || exit 0
    dev=\$(cat "\$STATE")
    swapoff "\$dev" || true
    zramctl --reset "\$dev" || true
    rm -f "\$STATE"
    ;;
esac
EXECEOF
chmod 755 "$EXEC"

cat > "$UNIT" <<UNITEOF
[Unit]
Description=Roam · zram 压缩交换区
DefaultDependencies=no
Before=swap.target
After=systemd-modules-load.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$EXEC start
ExecStop=$EXEC stop

[Install]
WantedBy=swap.target
UNITEOF

# zram 的两条标准调参。都不是「更激进地用 swap」，是「让压缩这条路走得通」：
#   swappiness=180  匿名页压进 zram 的代价远低于回收 page cache 再重读磁盘，
#                   默认的 60 是按「swap = 慢速磁盘」定的，对内存里的压缩块设备偏保守。
#   page-cluster=0  磁盘 swap 一次预读 8 页是为了摊薄寻道；zram 没有寻道，
#                   预读只是白白多解压 7 页。
cat > "$SYSCTL" <<'SYSCTLEOF'
# Roam · zram 调参。由 scripts/dev/install-zram-swap.sh 写入。
vm.swappiness=180
vm.page-cluster=0
SYSCTLEOF
sysctl -q --load "$SYSCTL"

# zswap 和 zram 同时开 = 压两遍：zswap 会把送往 zram 的页先压一次，再交给 zram 压第二次。
# 留一个就好，而 zram 是这里的主力（zswap 只是磁盘 swap 前面的缓存）。
if [ -w /sys/module/zswap/parameters/enabled ]; then
  echo N > /sys/module/zswap/parameters/enabled
fi

systemctl daemon-reload
systemctl enable --now roam-zram-swap.service

echo "✔ zram 交换区已启用（$SIZE / $ALGO / 优先级 $PRIO）"
zramctl | sed 's/^/  /'
swapon --show | sed 's/^/  /'
echo
echo "  校验：swapon --show 里 /dev/zram0 的 PRIO 应当高于磁盘 swap。"
echo "  卸载：sudo systemctl disable --now roam-zram-swap.service && sudo rm $UNIT $EXEC $SYSCTL"
