# scripts/install/preflight.sh — 系统检查/前置：打印平台横幅、装好 tmux、建目录。
# 依赖 lib/common.sh + lib/platform.sh（已 source）。
# shellcheck shell=bash

ensure_tmux() {
    command -v tmux &>/dev/null && return 0
    if can_autoinstall; then
        step "未检测到 tmux，自动安装中 (${PKG})..."
        pkg_do tmux && { info "tmux 已安装"; return 0; }
        die "自动安装 tmux 失败，请手动安装：$(pkg_cmd tmux)"
    fi
    die "需要先安装 tmux：$(pkg_cmd tmux)"
}

preflight() {
    step "平台: ${PLAT_H} · 架构: ${ARCH_H} · 包管理器: ${PKG:-未知}"
    ensure_tmux
    mkdir -p "$INSTALL_DIR" "$DATA_DIR/logs" "$DATA_DIR/groups"
}
