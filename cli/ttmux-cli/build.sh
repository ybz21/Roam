#!/usr/bin/env bash
#
# cli/ttmux-cli/build.sh — 把 lib/*.sh 按顺序拼接成单文件 仓库根/ttmux
#
# 开发时改 cli/ttmux-cli/lib/*.sh，然后跑本脚本重新生成根目录的 ttmux。
# 根 ttmux 是生成物，请勿手改。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
OUT="${SCRIPT_DIR}/../../ttmux"   # 仓库根（cli/ttmux-cli → ../../）

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
