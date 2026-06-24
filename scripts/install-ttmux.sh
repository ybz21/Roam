# scripts/install-ttmux.sh — [1/3] ttmux CLI 二进制 + skills + Tab 补全。
# 依赖：lib/common, lib/platform, lib/github；编排器导出 GO_SRC/TTMUX_BUILD/SKILL_DIR/CC_SWARM_DOCS/INSTALL_DIR/REPO/BRANCH。
# shellcheck shell=bash

ttmux_bin() {
    # 本地有 Go 源码：优先 Go 原生构建（自动按主机 x86/arm 出二进制），失败回退 bash；
    # 否则从 GitHub Releases 下对应 <os>-<arch> 预编译产物。
    if [[ -d "${GO_SRC}/cmd/ttmux-cli-go" ]]; then
        if command -v go &>/dev/null; then
            step "用 Go 构建 ttmux (原生二进制)..."
            if (cd "$GO_SRC" && CGO_ENABLED=0 go build -o "${INSTALL_DIR}/ttmux" ./cmd/ttmux-cli-go); then
                info "ttmux (Go) 已安装到 ${INSTALL_DIR}/ttmux"
            else
                warn "Go 构建失败，回退 bash 构建"
                bash "$TTMUX_BUILD" "${INSTALL_DIR}/ttmux" >/dev/null
                info "ttmux (bash) 已安装到 ${INSTALL_DIR}/ttmux"
            fi
        else
            step "未检测到 Go，构建 bash ttmux..."
            bash "$TTMUX_BUILD" "${INSTALL_DIR}/ttmux" >/dev/null
            info "ttmux (bash) 已安装到 ${INSTALL_DIR}/ttmux"
        fi
    else
        step "从 GitHub Releases 下载 ttmux ($(release_target))..."
        if download_asset ttmux "ttmux-$(release_target)"; then
            info "ttmux 已安装到 ${INSTALL_DIR}/ttmux"
        else
            die "下载失败；请确认已发布 release，或克隆仓库本地安装"
        fi
    fi
    chmod +x "${INSTALL_DIR}/ttmux"
}

ttmux_skills() {
    mkdir -p "$SKILL_DIR"
    if [[ -f "${SCRIPT_DIR}/skills/sync-skills.sh" ]]; then
        # 本地安装：复用 skills/sync-skills.sh（与开发模式 start.sh --dev 同一套合并逻辑）
        bash "${SCRIPT_DIR}/skills/sync-skills.sh" "$SKILL_DIR" >/dev/null && info "skills 已安装 (ttmux, cc-swarm)"
        return 0
    fi
    # curl|bash 无本地文件：从 GitHub 下载合并。
    # 技能须为目录形式 <名>/SKILL.md（扁平 <名>.md 不被 Claude Code v2.1+ 识别）。
    # 目标：Claude + (存在则) Codex —— codex 成员/指挥也能用。
    local SKILL_TARGETS=("$SKILL_DIR")
    [[ -d "${HOME}/.codex" ]] && SKILL_TARGETS+=("${HOME}/.codex/skills")

    local local_tmp; local_tmp=$(mktemp -d); local all_ok=true
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/ttmux/SKILL.md" \
        -o "${local_tmp}/ttmux.md" 2>/dev/null || all_ok=false
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/SKILL.md" \
        -o "${local_tmp}/cc-swarm.md" 2>/dev/null || all_ok=false
    local d
    for d in $CC_SWARM_DOCS; do
        $all_ok || break
        curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/cc-swarm/docs/${d}.md" \
            -o "${local_tmp}/doc-${d}.md" 2>/dev/null && \
            { printf '\n\n' >> "${local_tmp}/cc-swarm.md"; cat "${local_tmp}/doc-${d}.md" >> "${local_tmp}/cc-swarm.md"; }
    done
    if $all_ok; then
        local sd
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
}

ttmux_completion() {
    step "安装 Tab 补全..."
    "${INSTALL_DIR}/ttmux" completion 2>/dev/null || true
}

module_ttmux() {
    head2 "[1/3] 部署 ttmux"
    ttmux_bin
    ttmux_skills
    ttmux_completion
}
