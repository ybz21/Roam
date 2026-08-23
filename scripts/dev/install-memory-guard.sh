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
# 与每会话上限（internal/memguard）是两层，各管一件事：
#   - memguard：单个会话失控 → 只杀它自己
#   - 本脚本：  每个会话都合规、加起来超了 → 先减速，再关起门来 OOM
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
