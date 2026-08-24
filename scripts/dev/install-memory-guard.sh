#!/usr/bin/env bash
# 装上「用户切片内存总闸」（L2）—— 需要 root，跑一次即可，重启后仍在。
#
#   sudo bash scripts/dev/install-memory-guard.sh
#
# 背景：2026-08-22 21:51，一个跑在 Roam 会话里的 Claude Code 进程涨到 15.5 GB，
# 把这台 30 GB 的机器打爆。内核当时打的是 **global_oom** —— 在全机范围选 victim，
# 于是整个桌面僵死，只能按电源。
#
# 这两行不为了「不 OOM」，是为了把 OOM **关在用户切片里**：撞顶时被杀的是用户
# 会话里的进程，sshd / journald / system.slice 上的服务都还活着，机器还进得来。
#
# 与另外两层各管一件事：
#   - internal/memguard（L1）：单个会话失控 → 硬顶，只杀它自己
#   - internal/memthrottle（L2 软限）：机器快没内存 → 给最大的会话踩软刹车。
#     **不需要 root，已经默认在跑**，它把「快要爆」拉回来。
#   - 本脚本（L2 硬顶）：拦不住的那一下 —— 一次瞬间的巨额分配 —— 仍会打成
#     global_oom 让整个桌面僵死。只有 root 能把这一下关在用户切片里。
#
# 换句话说：不跑这个脚本，护栏也是有的（L1 + 软限总量闸）；跑了它才补上
# 「真爆的时候机器还进得来」这一层。两者互补，不是替代。
#
# 见 docs/design/reliability/memory-guard.html §05。
set -euo pipefail

UID_TARGET="${1:-1000}"
UNIT="user@${UID_TARGET}.service"
DIR="/etc/systemd/system/${UNIT}.d"
CONF="${DIR}/roam-memory.conf"

if [ "$(id -u)" != "0" ]; then
  echo "✘ 需要 root：sudo bash $0 [uid]" >&2
  exit 1
fi

mkdir -p "$DIR"
cat > "$CONF" <<'CONF'
# Roam · 用户切片内存总闸（L2）。由 scripts/dev/install-memory-guard.sh 写入。
#
# MemoryHigh 是软限：到了先激进回收 + throttle，进程变慢但不死，留出反应时间。
# MemoryMax 是硬顶，仍给内核和系统服务留出 12% —— 那正是「机器还救得回来」的余量。
[Service]
MemoryHigh=75%
MemoryMax=88%
CONF

systemctl daemon-reload
# 运行时也设一次：drop-in 要等下次 user session 起来才生效，而这台机器上的会话
# 正跑着活儿，不该为了装个护栏把人的活儿掀掉。
systemctl set-property "$UNIT" MemoryHigh=75% MemoryMax=88%

echo "✔ 已写入 $CONF"
systemctl show "$UNIT" -p MemoryHigh -p MemoryMax -p MemoryCurrent | sed 's/^/  /'
echo
echo "  校验：MemoryHigh/MemoryMax 应为具体字节数而非 infinity。"
echo "  卸载：sudo rm $CONF && sudo systemctl daemon-reload"
