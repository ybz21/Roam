#!/usr/bin/env bash
#
# cli/chrome-cli/build.sh — 把 driver.mjs 内联进 launcher.sh，生成单文件 仓库根/chrome
#
# 开发时改 driver.mjs / launcher.sh，然后跑本脚本重新生成根目录的 chrome。
# 根 chrome 是生成物，请勿手改。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${SCRIPT_DIR}/../../chrome"   # 仓库根（cli/chrome-cli → ../../）

[[ -f "${SCRIPT_DIR}/launcher.sh" ]] || { echo "✘ 缺少 launcher.sh"; exit 1; }
[[ -f "${SCRIPT_DIR}/driver.mjs"  ]] || { echo "✘ 缺少 driver.mjs"; exit 1; }

# 把 launcher.sh 里的 @@DRIVER@@ 标记行替换为 driver.mjs 全文（awk 逐行打印，driver 原样内联）
tmp="$(mktemp)"
awk -v drv="${SCRIPT_DIR}/driver.mjs" '
    /@@DRIVER@@/ { while ((getline line < drv) > 0) print line; close(drv); next }
    { print }
' "${SCRIPT_DIR}/launcher.sh" > "$tmp"

mv "$tmp" "$OUT"
chmod +x "$OUT"

if bash -n "$OUT"; then
    echo "✔ 已生成 $OUT  ($(wc -l < "$OUT") 行)"
else
    echo "✘ 生成的 chrome 语法检查失败"; exit 1
fi
