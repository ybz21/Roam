# scripts/install-chrome.sh — [2/3] chrome：2.1 node · 2.2 playwright · 2.3 chrome CLI。
# 注：playwright 依赖经 `chrome setup` 安装，需 CLI 先就位，
#     故实际执行顺序为 node(2.1) → chrome CLI(2.3) → playwright(2.2)。
# 依赖：lib/common, lib/platform, lib/github；编排器导出 CHROME_BUILD/INSTALL_DIR。
# shellcheck shell=bash

# 2.1 node 运行时（playwright-core 需 Node ≥ 18）
chrome_node() {
    if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
        if can_autoinstall; then
            step "2.1 node — 未检测到 node/npm，自动安装中 (${PKG})..."
            pkg_do node || true
        fi
    fi
    local nm; nm="$(node_major)"
    if command -v node &>/dev/null && command -v npm &>/dev/null && [[ "$nm" -ge 18 ]]; then
        info "2.1 node — Node v${nm} 就绪"
    elif command -v node &>/dev/null; then
        warn "2.1 node — Node 版本过低 (v${nm})，playwright 需 ≥ 18；升级: nvm install --lts  或  $(pkg_cmd node)"
    else
        warn "2.1 node — 缺少 node/npm，playwright 将跳过；安装 Node≥18: $(pkg_cmd node)"
    fi
}

# 2.3 chrome CLI（把 driver.mjs 内联进 launcher 生成单文件二进制；远程则下 release）
chrome_cli() {
    if [[ -f "$CHROME_BUILD" ]]; then
        bash "$CHROME_BUILD" "${INSTALL_DIR}/chrome" >/dev/null 2>&1 || true
    else
        download_asset chrome "chrome" 2>/dev/null || true
    fi
    if [[ -f "${INSTALL_DIR}/chrome" ]]; then
        chmod +x "${INSTALL_DIR}/chrome"
        info "2.3 chrome CLI — 已安装到 ${INSTALL_DIR}/chrome"
    else
        warn "2.3 chrome CLI — 未能安装(无源码且无 release)"
    fi
}

# 2.2 playwright 依赖（chrome setup：写 driver + npm i playwright-core，不下载浏览器）
chrome_playwright() {
    [[ -x "${INSTALL_DIR}/chrome" ]] || { warn "2.2 playwright — chrome CLI 缺失，跳过"; return 0; }
    local nm; nm="$(node_major)"
    if command -v node &>/dev/null && command -v npm &>/dev/null && [[ "$nm" -ge 18 ]]; then
        step "2.2 playwright — 安装 playwright-core..."
        if "${INSTALL_DIR}/chrome" setup; then
            info "2.2 playwright — 依赖已就绪 (playwright-core)"
        else
            warn "2.2 playwright — 安装失败，稍后重试: chrome setup"
        fi
    else
        warn "2.2 playwright — node 未就绪，跳过；node 装好后运行: chrome setup"
    fi
}

# 浏览器本体（投屏/自动化需要一台 Chrome/Chromium；不自动装，给平台化指引）
chrome_browser_hint() {
    if command -v google-chrome &>/dev/null || command -v google-chrome-stable &>/dev/null \
        || command -v chromium &>/dev/null || command -v chromium-browser &>/dev/null \
        || { [[ "$OS" == mac ]] && [[ -d "/Applications/Google Chrome.app" ]]; }; then
        info "Chrome/Chromium 已就绪（浏览器投屏可用）"
    else
        warn "浏览器投屏需要 Chrome/Chromium：$(pkg_cmd chromium)"
    fi
    if [[ "$IS_WSL" == 1 ]]; then
        warn "WSL：无头 Chrome 若因沙箱起不来，让 CHROME_BIN 指向带 --no-sandbox 的包装脚本"
        echo -e "      ${dim}# ~/.ttmux-chrome.sh 内容:  exec chromium-browser --no-sandbox \"\$@\"${reset}"
        echo -e "      ${dim}export CHROME_BIN=~/.ttmux-chrome.sh   # 再启动后端${reset}"
    fi
}

module_chrome() {
    head2 "[2/3] 部署 chrome"
    chrome_node         # 2.1
    chrome_cli          # 2.3（先于 playwright：chrome setup 经 CLI 跑）
    chrome_playwright   # 2.2
    chrome_browser_hint
}
