#!/usr/bin/env bash
#
# chrome — 浏览器自动化 CLI（Playwright over CDP）
# https://github.com/ybz21/ttmux
#
# ⚠ 本文件由 cli/chrome-cli/build.sh 生成（driver.mjs 内联进下方占位标记处），请勿手改。
#   改 cli/chrome-cli/{driver.mjs,launcher.sh} 后跑 cli/chrome-cli/build.sh 重新生成。
#
# 驱动 127.0.0.1:9222 上的全局 Chrome——与 ttmux Web 镜像同一台，自动化能在
# 控制台「浏览器」标签里实时围观。引擎 playwright-core 的 connectOverCDP 复用
# 已开的 Chrome，不下载 Playwright 自带浏览器（依赖很轻）。
#
set -euo pipefail

TTMUX_CHROME_VERSION="0.1.0"
TTMUX_DATA="${TTMUX_DATA:-${HOME}/.local/share/ttmux}"
CHROME_DIR="${TTMUX_DATA}/chrome"

# 颜色/提示
if [ -t 2 ]; then
    _c_blue=$'\033[34m'; _c_red=$'\033[31m'; _c_dim=$'\033[2m'; _c_reset=$'\033[0m'
else
    _c_blue=''; _c_red=''; _c_dim=''; _c_reset=''
fi
_info() { echo -e " ${_c_blue}●${_c_reset} $*" >&2; }
_err()  { echo -e " ${_c_red}✘${_c_reset} $*" >&2; }

_cdp() { echo "${TTMUX_CHROME_CDP:-http://127.0.0.1:9222}"; }

_chrome_bin() {
    if [ -n "${CHROME_BIN:-}" ] && [ -x "$CHROME_BIN" ]; then
        echo "$CHROME_BIN"; return 0
    fi
    if command -v google-chrome >/dev/null 2>&1; then
        command -v google-chrome; return 0
    fi
    if command -v chromium >/dev/null 2>&1; then
        command -v chromium; return 0
    fi
    if command -v chromium-browser >/dev/null 2>&1; then
        command -v chromium-browser; return 0
    fi
    if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; return 0
    fi
    if [ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
        echo "/Applications/Chromium.app/Contents/MacOS/Chromium"; return 0
    fi
    return 1
}

_daemon_start() {
    if command -v setsid >/dev/null 2>&1; then
        setsid "$@" </dev/null >/dev/null 2>&1 &
    else
        nohup "$@" </dev/null >/dev/null 2>&1 &
    fi
}

# 写出内嵌 driver.mjs（构建时由 driver.mjs 内联）。引号 heredoc → JS 原样不展开。
_write_driver() {
    mkdir -p "$CHROME_DIR"
    cat > "${CHROME_DIR}/driver.mjs" <<'TTMUX_CHROME_DRIVER_EOF'
@@DRIVER@@
TTMUX_CHROME_DRIVER_EOF
}

# 安装/校验依赖：node + npm + playwright-core
_setup() {
    command -v node >/dev/null 2>&1 || { _err "需要 node（未找到）"; return 1; }
    command -v npm  >/dev/null 2>&1 || { _err "需要 npm（未找到）"; return 1; }
    _write_driver
    if [ ! -d "${CHROME_DIR}/node_modules/playwright-core" ]; then
        _info "安装 playwright-core → ${CHROME_DIR}（首次, 不下载额外浏览器）"
        ( cd "$CHROME_DIR" \
            && { [ -f package.json ] || npm init -y >/dev/null 2>&1; } \
            && npm i --no-audit --no-fund --loglevel=error playwright-core ) \
            || { _err "playwright-core 安装失败（可重试: chrome setup）"; return 1; }
    fi
    return 0
}

# 确保 CDP 端口上有 Chrome：探活，否则按与 ttmux 后端一致的 flag 自起（无 DISPLAY 走 headless）。
_ensure_browser() {
    local base; base="$(_cdp)"
    curl -fsS "${base}/json/version" >/dev/null 2>&1 && return 0
    local chrome_bin
    chrome_bin="$(_chrome_bin)" || { _err "${base} 上无 Chrome，且未找到 Chrome/Chromium"; return 1; }
    local args=(--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
        --remote-allow-origins=* --user-data-dir=/tmp/ttmux-chrome
        --no-first-run --no-default-browser-check
        --ignore-certificate-errors
        --force-device-scale-factor="${TTMUX_CHROME_SCALE:-2}")
    [ "$(uname -s 2>/dev/null || echo unknown)" != "Darwin" ] && [ -z "${DISPLAY:-}" ] && args+=(--headless=new --window-size=1280,800)
    _info "拉起 Chrome（调试端口 9222）..."
    _daemon_start "$chrome_bin" "${args[@]}" about:blank
    local i
    for i in $(seq 1 50); do
        curl -fsS "${base}/json/version" >/dev/null 2>&1 && return 0
        sleep 0.1
    done
    _err "Chrome 调试端口未就绪"
    return 1
}

_help() {
    cat <<'EOF'
chrome — 浏览器自动化（Playwright over CDP，驱动 ttmux Web 镜像那台 Chrome）

  chrome setup                     安装/更新依赖 (node + playwright-core)
  chrome goto <url>                打开网址
  chrome click <选择器>            点击
  chrome fill  <选择器> <文本>     填表单（直接设值）
  chrome type  <选择器> <文本>     逐字键入
  chrome press [选择器] <键>       按键（如 Enter / Control+a）
  chrome text  [选择器]            取可见文本（默认 body）
  chrome html  [选择器]            取 HTML（默认整页）
  chrome attr  <选择器> <属性>     取属性值
  chrome eval  "<js>"              页面内执行 JS 并打印返回（JSON）
  chrome wait  <选择器>            等待元素出现
  chrome screenshot [文件] [--full]   截图（默认 screenshot.png）
  chrome pdf   [文件]              导出 PDF（headless）
  chrome tabs                      列出标签页（序号 / 标题 / url）
  chrome new   [url]               新开标签页
  chrome close                     关闭标签页

  通用选项: --tab <序号> | --url <子串>  选目标标签页（默认第一个）
            --timeout <ms>（默认 15000）  --cdp <地址>
  截图选项: --viewport 1280x800  --wait <ms>  --clip x,y,w,h  --fast
            --fresh --goto <url>（临时干净 Chrome 截图）  --quality <1-100>（jpg）
            --mobile（手机视口=iPhone）  --device iphone|iphone-se|pixel|ipad（指定机型）
            默认截图失败时自动降级到 CDP 截图；所有路径受 --timeout 约束
  环境变量: TTMUX_CHROME_CDP=http://127.0.0.1:9222  TTMUX_CHROME_SCALE=2
EOF
}

# ── 主入口 ──
sub="${1:-help}"
case "$sub" in
    help|-h|--help) _help; exit 0 ;;
    -v|--version)   echo "chrome v${TTMUX_CHROME_VERSION}"; exit 0 ;;
    setup)          _setup; exit $? ;;
esac
fresh_screenshot=0
if [ "$sub" = "screenshot" ] || [ "$sub" = "shot" ]; then
    for arg in "$@"; do
        [ "$arg" = "--fresh" ] && fresh_screenshot=1 && break
    done
fi

# 首次/缺失才跑完整 setup（装依赖）；齐了就走快路径。
if [ ! -f "${CHROME_DIR}/driver.mjs" ] || [ ! -d "${CHROME_DIR}/node_modules/playwright-core" ]; then
    _setup || exit 1
else
    # 根 chrome 是单文件分发；每次执行刷新内嵌 driver，确保升级后的 CLI 立即生效。
    _write_driver
fi
if [ "$fresh_screenshot" -eq 0 ]; then
    _ensure_browser || exit 1
fi
exec node "${CHROME_DIR}/driver.mjs" "$@"
