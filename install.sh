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

# 下载或复制 chrome（独立的浏览器自动化 CLI）
if [[ -f "${SCRIPT_DIR}/chrome" ]]; then
    cp "${SCRIPT_DIR}/chrome" "${INSTALL_DIR}/chrome"
else
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/chrome" \
        -o "${INSTALL_DIR}/chrome" 2>/dev/null || true
fi
[[ -f "${INSTALL_DIR}/chrome" ]] && chmod +x "${INSTALL_DIR}/chrome" \
    && info "chrome 已安装到 ${INSTALL_DIR}/chrome"

# 安装 Claude Code skills
mkdir -p "$SKILL_DIR"
# cc-swarm 子文档拼接顺序(生命周期)；与 skills/sync-skills.sh 保持一致。
CC_SWARM_DOCS="intake decompose spawn patrol approve test-push review concurrency integrate memory"

if [[ -f "${SCRIPT_DIR}/skills/sync-skills.sh" ]]; then
    # 本地安装：复用 skills/sync-skills.sh（与开发模式 start-all.sh 同一套合并逻辑）
    bash "${SCRIPT_DIR}/skills/sync-skills.sh" "$SKILL_DIR" >/dev/null && info "skills 已安装 (ttmux, cc-swarm)"
else
    # curl|bash 无本地文件：从 GitHub 下载合并
    if curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/ttmux/SKILL.md" \
            -o /tmp/ttmux-skill.md 2>/dev/null; then
        mv /tmp/ttmux-skill.md "${SKILL_DIR}/ttmux.md"
        info "ttmux skill 已安装"
    fi
    local_tmp=$(mktemp -d); all_ok=true
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/SKILL.md" \
        -o "${local_tmp}/SKILL.md" 2>/dev/null || all_ok=false
    for d in $CC_SWARM_DOCS; do
        $all_ok || break
        curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/docs/${d}.md" \
            -o "${local_tmp}/${d}.md" 2>/dev/null || { all_ok=false; break; }
    done
    if $all_ok; then
        dest="${SKILL_DIR}/cc-swarm.md"
        cat "${local_tmp}/SKILL.md" > "$dest"
        for d in $CC_SWARM_DOCS; do
            [[ -f "${local_tmp}/${d}.md" ]] && { printf '\n\n' >> "$dest"; cat "${local_tmp}/${d}.md" >> "$dest"; }
        done
        info "cc-swarm skill 已安装"
    fi
    rm -rf "$local_tmp"
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

# 浏览器自动化依赖（chrome —— Playwright over CDP）
# connectOverCDP 复用已开的 Chrome，不下载额外浏览器，仅装 playwright-core。
if [[ -x "${INSTALL_DIR}/chrome" ]]; then
    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        step "安装 chrome 依赖 (playwright-core)..."
        "${INSTALL_DIR}/chrome" setup || echo -e "   ${dim}稍后可手动重试: chrome setup${reset}"
    else
        echo -e "  ${dim}⚠ 未检测到 node/npm，跳过 chrome 依赖（装好后运行: chrome setup）${reset}"
    fi
fi

echo ""
echo -e "  ${bold}安装完成!${reset}"
echo ""
echo -e "  ${dim}试试:${reset}"
echo -e "    ttmux help"
echo -e "    ttmux new dev"
echo -e "    ttmux spawn build \"lint\" \"echo ok\" \"test\" \"echo pass\""
echo ""
