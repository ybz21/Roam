#!/usr/bin/env bash
#
# ttmux installer
# curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
#

set -euo pipefail

REPO="ybz21/ttmux"
BRANCH="main"
INSTALL_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills"
DATA_DIR="${HOME}/.local/share/ttmux"

bold=$'\033[1m'
green=$'\033[32m'
cyan=$'\033[36m'
dim=$'\033[2m'
reset=$'\033[0m'

info() { echo -e " ${green}✔${reset} $*"; }
step() { echo -e " ${cyan}●${reset} $*"; }

echo ""
echo -e "  ${bold}ttmux${reset} ${dim}— AI-native tmux installer${reset}"
echo ""

# 检查依赖
if ! command -v tmux &>/dev/null; then
    echo -e " ✘ 需要先安装 tmux"
    echo "   sudo apt install tmux  /  brew install tmux"
    exit 1
fi

# 创建目录
mkdir -p "$INSTALL_DIR" "$DATA_DIR/logs" "$DATA_DIR/groups"

# 下载或复制 ttmux
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/ttmux" ]]; then
    step "从本地安装..."
    cp "${SCRIPT_DIR}/ttmux" "${INSTALL_DIR}/ttmux"
else
    step "从 GitHub 下载..."
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/ttmux" \
        -o "${INSTALL_DIR}/ttmux"
fi
chmod +x "${INSTALL_DIR}/ttmux"
info "ttmux 已安装到 ${INSTALL_DIR}/ttmux"

# 安装 Claude Code skill
if [[ -f "${SCRIPT_DIR}/skills/tmux/SKILL.md" ]]; then
    mkdir -p "$SKILL_DIR"
    cp "${SCRIPT_DIR}/skills/tmux/SKILL.md" "${SKILL_DIR}/ttmux.md"
    info "Claude Code skill 已安装"
elif curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/tmux/SKILL.md" \
        -o /tmp/ttmux-skill.md 2>/dev/null; then
    mkdir -p "$SKILL_DIR"
    mv /tmp/ttmux-skill.md "${SKILL_DIR}/ttmux.md"
    info "Claude Code skill 已安装"
fi

# 检查 PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    echo ""
    echo -e "  ${dim}⚠ ${INSTALL_DIR} 不在 PATH 中，请添加:${reset}"
    echo ""
    echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
fi

# 安装补全
step "安装 Tab 补全..."
"${INSTALL_DIR}/ttmux" completion 2>/dev/null || true

echo ""
echo -e "  ${bold}安装完成!${reset}"
echo ""
echo -e "  ${dim}试试:${reset}"
echo -e "    ttmux help"
echo -e "    ttmux new dev"
echo -e "    ttmux spawn build \"lint\" \"echo ok\" \"test\" \"echo pass\""
echo ""
