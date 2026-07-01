# scripts/install/lib/github.sh — GitHub Releases 下载助手。依赖编排器导出的 REPO / INSTALL_DIR。
# shellcheck shell=bash

# 目标平台标识（用于 release 资产名 ttmux-<os>-<arch>，覆盖 x86/arm × linux/mac）
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
