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

# 下载或复制 ttmux-chrome（独立的浏览器自动化 CLI）
if [[ -f "${SCRIPT_DIR}/ttmux-chrome" ]]; then
    cp "${SCRIPT_DIR}/ttmux-chrome" "${INSTALL_DIR}/ttmux-chrome"
else
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/ttmux-chrome" \
        -o "${INSTALL_DIR}/ttmux-chrome" 2>/dev/null || true
fi
[[ -f "${INSTALL_DIR}/ttmux-chrome" ]] && chmod +x "${INSTALL_DIR}/ttmux-chrome" \
    && info "ttmux-chrome 已安装到 ${INSTALL_DIR}/ttmux-chrome"

# 安装 Claude Code skills
mkdir -p "$SKILL_DIR"

# ttmux skill
if [[ -f "${SCRIPT_DIR}/skills/tmux/SKILL.md" ]]; then
    cp "${SCRIPT_DIR}/skills/tmux/SKILL.md" "${SKILL_DIR}/ttmux.md"
    info "ttmux skill 已安装"
elif curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/tmux/SKILL.md" \
        -o /tmp/ttmux-skill.md 2>/dev/null; then
    mv /tmp/ttmux-skill.md "${SKILL_DIR}/ttmux.md"
    info "ttmux skill 已安装"
fi

# cc-swarm skill — 合并多个子文档为一个文件（按生命周期顺序）
CC_SWARM_DOCS="intake decompose spawn patrol approve test-push review concurrency integrate memory"

install_cc_swarm_skill() {
    local src_dir="$1"
    local dest="${SKILL_DIR}/cc-swarm.md"
    if [[ -f "${src_dir}/SKILL.md" ]]; then
        cat "${src_dir}/SKILL.md" > "$dest"
        for doc in $CC_SWARM_DOCS; do
            # 子文档放在 docs/ 下；兼容老的扁平布局
            local doc_file="${src_dir}/docs/${doc}.md"
            [[ -f "$doc_file" ]] || doc_file="${src_dir}/${doc}.md"
            if [[ -f "$doc_file" ]]; then
                echo "" >> "$dest"
                echo "" >> "$dest"
                cat "$doc_file" >> "$dest"
            fi
        done
        info "cc-swarm skill 已安装"
        return 0
    fi
    return 1
}

if [[ -d "${SCRIPT_DIR}/skills/cc-swarm" ]]; then
    install_cc_swarm_skill "${SCRIPT_DIR}/skills/cc-swarm"
else
    # 从 GitHub 下载各子文档并合并
    local_tmp=$(mktemp -d)
    mkdir -p "${local_tmp}/docs"
    all_ok=true
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/SKILL.md" \
        -o "${local_tmp}/SKILL.md" 2>/dev/null || all_ok=false
    for d in $CC_SWARM_DOCS; do
        $all_ok || break
        curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/docs/${d}.md" \
            -o "${local_tmp}/docs/${d}.md" 2>/dev/null || { all_ok=false; break; }
    done
    if $all_ok; then
        install_cc_swarm_skill "$local_tmp"
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

# 浏览器自动化依赖（ttmux-chrome —— Playwright over CDP）
# connectOverCDP 复用已开的 Chrome，不下载额外浏览器，仅装 playwright-core。
if [[ -x "${INSTALL_DIR}/ttmux-chrome" ]]; then
    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        step "安装 ttmux-chrome 依赖 (playwright-core)..."
        "${INSTALL_DIR}/ttmux-chrome" setup || echo -e "   ${dim}稍后可手动重试: ttmux-chrome setup${reset}"
    else
        echo -e "  ${dim}⚠ 未检测到 node/npm，跳过 ttmux-chrome 依赖（装好后运行: ttmux-chrome setup）${reset}"
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
