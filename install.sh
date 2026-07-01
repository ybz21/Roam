#!/usr/bin/env bash
#
# ttmux 部署编排器（瘦壳）。真正的逻辑在 scripts/ 下分模块：
#
#   scripts/install/lib/common.sh      颜色 + 日志助手
#   scripts/install/lib/platform.sh    平台/架构检测 + 包管理辅助
#   scripts/install/lib/github.sh      release 下载助手
#   scripts/install/preflight.sh       系统检查（tmux / 目录）
#   scripts/install/install-ttmux.sh   [1/3] ttmux CLI + skills + 补全
#   scripts/install/install-chrome.sh  [2/3] node + playwright + chrome CLI
#   scripts/install/install-backend.sh [3/3] 构建后端产物（dist + 二进制），不启动
#
# 一行安装（k3s 风格）：
#   curl -sfL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
#
# 本地 checkout 直接 source scripts/*；curl|bash 远程则按需从 GitHub raw 下载各模块。
# 装完只产出产物、不启动服务；启动用：bash start.sh  /  bash start.sh --dev
#
# 环境开关：
#   TTMUX_SKIP_BACKEND=1     只装 CLI/chrome，不构建后端
#   TTMUX_INSTALL_BRANCH=xx  远程拉取模块/skills 用的分支（默认 main）
#

set -euo pipefail

# ── 配置 ─────────────────────────────────────────────────────────
REPO="ybz21/ttmux"
BRANCH="${TTMUX_INSTALL_BRANCH:-main}"
INSTALL_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills"
DATA_DIR="${HOME}/.local/share/ttmux"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
GO_SRC="${SCRIPT_DIR}/cli/ttmux-cli-go"
TTMUX_BUILD="${SCRIPT_DIR}/cli/ttmux-cli/build.sh"
CHROME_BUILD="${SCRIPT_DIR}/cli/chrome-cli/build.sh"
# cc-swarm 子文档拼接顺序(生命周期)；与 skills/sync-skills.sh 保持一致。
CC_SWARM_DOCS="intake decompose spawn patrol approve test-push review concurrency integrate memory"

# ── 模块加载：本地有就 source；curl|bash 远程则下载到临时目录再 source ──
if [[ -d "${SCRIPT_DIR}/scripts" ]]; then
    MODULE_BASE="${SCRIPT_DIR}/scripts"
else
    MODULE_BASE="$(mktemp -d)"
    trap 'rm -rf "$MODULE_BASE"' EXIT
fi

load() {  # <scripts/ 下的相对路径>
    local rel="$1"
    local dst="${MODULE_BASE}/${rel}"
    if [[ ! -f "$dst" ]]; then
        mkdir -p "$(dirname "$dst")"
        curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/${rel}" -o "$dst" \
            || { echo " ✘ 下载模块失败: scripts/${rel}（分支 ${BRANCH}）" >&2; exit 1; }
    fi
    # shellcheck disable=SC1090
    source "$dst"
}

load install/lib/common.sh
load install/lib/platform.sh
load install/lib/github.sh
load install/preflight.sh
load install/install-ttmux.sh
load install/install-chrome.sh
load install/install-backend.sh

# ── 主流程 ───────────────────────────────────────────────────────
echo ""
echo -e "  ${bold}ttmux${reset} ${dim}— AI-native tmux 部署脚本${reset}"
echo ""

preflight            # 平台横幅 + tmux + 建目录
module_ttmux         # [1/3]
module_chrome        # [2/3]
module_backend       # [3/3]（只构建，不启动）
# 注：手机后端依赖（adb / idb）不在此预装；由设置页「手机」平台开关按需安装（scripts/phone/install-phone.sh）。

# PATH 提示
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    echo ""
    warn "${INSTALL_DIR} 不在 PATH 中，请添加:"
    echo ""
    echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo ""
echo -e "  ${bold}部署完成!${reset}"
echo ""
echo -e "  ${dim}启动后端服务:${reset}"
echo -e "    bash start.sh            ${dim}# 直接启动已构建产物${reset}"
echo -e "    bash start.sh --dev      ${dim}# 开发：每次重新编译${reset}"
echo ""
echo -e "  ${dim}试试 CLI:${reset}"
echo -e "    ttmux help"
echo -e "    ttmux new dev"
echo ""
