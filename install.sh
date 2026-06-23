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

# ttmux / chrome 是生成物，不再提交进仓库：
#   - 本地 checkout：现场构建（ttmux 优先 Go，回退 bash；chrome 走 build.sh）
#   - curl|bash 远程：从 GitHub Releases 下载预编译产物
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO_SRC="${SCRIPT_DIR}/cli/ttmux-cli-go"
TTMUX_BUILD="${SCRIPT_DIR}/cli/ttmux-cli/build.sh"
CHROME_BUILD="${SCRIPT_DIR}/cli/chrome-cli/build.sh"

# 目标平台标识（用于 release 资产名 ttmux-<os>-<arch>）
release_target() {
    local os arch
    case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) os=linux ;; esac
    case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
    echo "${os}-${arch}"
}
# 从 latest release 下载资产到 INSTALL_DIR/<本地名>
download_asset() {  # <local-name> <asset-name>
    curl -fsSL "https://github.com/${REPO}/releases/latest/download/${2}" -o "${INSTALL_DIR}/${1}"
}

# ── ttmux ──
if [[ -d "${GO_SRC}/cmd/ttmux-cli-go" ]]; then
    if command -v go &>/dev/null; then
        step "用 Go 构建 ttmux (原生二进制)..."
        if (cd "$GO_SRC" && CGO_ENABLED=0 go build -o "${INSTALL_DIR}/ttmux" ./cmd/ttmux-cli-go); then
            info "ttmux (Go) 已安装到 ${INSTALL_DIR}/ttmux"
        else
            echo -e "  ${dim}⚠ Go 构建失败，回退 bash 构建${reset}"
            bash "$TTMUX_BUILD" >/dev/null && cp "${SCRIPT_DIR}/ttmux" "${INSTALL_DIR}/ttmux"
            info "ttmux (bash) 已安装到 ${INSTALL_DIR}/ttmux"
        fi
    else
        step "未检测到 Go，构建 bash ttmux..."
        bash "$TTMUX_BUILD" >/dev/null && cp "${SCRIPT_DIR}/ttmux" "${INSTALL_DIR}/ttmux"
        info "ttmux (bash) 已安装到 ${INSTALL_DIR}/ttmux"
    fi
else
    step "从 GitHub Releases 下载 ttmux ($(release_target))..."
    if download_asset ttmux "ttmux-$(release_target)"; then
        info "ttmux 已安装到 ${INSTALL_DIR}/ttmux"
    else
        echo -e " ✘ 下载失败；请确认已发布 release，或克隆仓库本地安装"
        exit 1
    fi
fi
chmod +x "${INSTALL_DIR}/ttmux"

# ── chrome（独立的浏览器自动化 CLI，仅 bash）──
if [[ -f "$CHROME_BUILD" ]]; then
    bash "$CHROME_BUILD" >/dev/null 2>&1 && cp "${SCRIPT_DIR}/chrome" "${INSTALL_DIR}/chrome" 2>/dev/null || true
else
    download_asset chrome "chrome" 2>/dev/null || true
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
    # curl|bash 无本地文件：从 GitHub 下载合并。
    # 技能须为目录形式 <名>/SKILL.md（扁平 <名>.md 不被 Claude Code v2.1+ 识别）。
    # 目标：Claude + (存在则) Codex —— codex 成员/指挥也能用。
    SKILL_TARGETS=("$SKILL_DIR")
    [[ -d "${HOME}/.codex" ]] && SKILL_TARGETS+=("${HOME}/.codex/skills")

    local_tmp=$(mktemp -d); all_ok=true
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/ttmux/SKILL.md" \
        -o "${local_tmp}/ttmux.md" 2>/dev/null || all_ok=false
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/SKILL.md" \
        -o "${local_tmp}/cc-swarm.md" 2>/dev/null || all_ok=false
    for d in $CC_SWARM_DOCS; do
        $all_ok || break
        curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/docs/${d}.md" \
            -o "${local_tmp}/doc-${d}.md" 2>/dev/null && \
            { printf '\n\n' >> "${local_tmp}/cc-swarm.md"; cat "${local_tmp}/doc-${d}.md" >> "${local_tmp}/cc-swarm.md"; }
    done
    if $all_ok; then
        for sd in "${SKILL_TARGETS[@]}"; do
            mkdir -p "$sd"
            rm -f "${sd}/ttmux.md" "${sd}/cc-swarm.md"   # 清历史扁平文件
            mkdir -p "${sd}/ttmux" "${sd}/cc-swarm"
            cp "${local_tmp}/ttmux.md" "${sd}/ttmux/SKILL.md"
            cp "${local_tmp}/cc-swarm.md" "${sd}/cc-swarm/SKILL.md"
        done
        info "skills 已安装 (ttmux, cc-swarm)"
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
