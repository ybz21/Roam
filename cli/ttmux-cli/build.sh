#!/usr/bin/env bash
#
# cli/ttmux-cli/build.sh — 把 lib/*.sh 按顺序拼接成单文件 ttmux（bash 回退版）
#
# 输出路径：$1（缺省 ~/.local/bin/ttmux）。直接产出到系统 PATH，不在仓库根留产物。
# 开发想生成到别处自测：bash cli/ttmux-cli/build.sh /tmp/ttmux
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
OUT="${1:-${HOME}/.local/bin/ttmux}"
mkdir -p "$(dirname "$OUT")"

# 拼接顺序（必须 00-header 在最前、99-main 在最后）
MODULES=(
    00-header
    core
    store
    env
    group
    status
    spawn
    capture
    wait
    collect
    agent
    swarm
    plaza
    board
    listener
    completion
    help
    interactive
    99-main
)

# 校验所有模块存在
missing=0
for m in "${MODULES[@]}"; do
    [[ -f "${LIB_DIR}/${m}.sh" ]] || { echo "✘ 缺少模块: lib/${m}.sh"; missing=1; }
done
[[ "$missing" -eq 0 ]] || exit 1

# 拼接到临时文件再原子替换
tmp="$(mktemp)"
for m in "${MODULES[@]}"; do
    cat "${LIB_DIR}/${m}.sh" >> "$tmp"
done

mv "$tmp" "$OUT"
chmod +x "$OUT"

# 语法自检
if bash -n "$OUT"; then
    echo "✔ 已生成 $OUT  ($(wc -l < "$OUT") 行, ${#MODULES[@]} 个模块)"
else
    echo "✘ 生成的 ttmux 语法检查失败"
    exit 1
fi
