#!/usr/bin/env bash
#
# Roam 常驻安装器 —— 下载单一自包含二进制并注册为常驻服务（systemd）。适合 24 小时运行的机器。
#
# 一行安装（推荐）：
#   curl -fsSL https://raw.githubusercontent.com/ybz21/Roam/main/install.sh | bash
#
# roam 是自包含二进制（内嵌前端 + ttmux CLI），目标机无需 go/node/npm。
# 配置与数据都在 ~/.roam/（首次启动自动生成 config.yaml）。首次打开网页设置登录口令。
#
# 环境开关：
#   ROAM_VERSION=vX.Y.Z   指定版本（默认 latest）
#   ROAM_BIN_DIR=DIR      安装目录（默认 ~/.local/bin）
#   ROAM_NO_SERVICE=1     只装二进制，不注册 systemd 服务
#   ROAM_SYSTEM=1         注册系统级 systemd 服务（/etc/systemd/system，需 root/sudo）
#   ROAM_FROM_SOURCE=1    在仓库 clone 内从源码构建（需 go+node），而非下载 release
#
# 开发/源码构建请用 start.sh --dev（会从源码构建 CLI/chrome/skills + 前后端）。
#
set -euo pipefail

REPO="ybz21/Roam"
VERSION="${ROAM_VERSION:-latest}"
BIN_DIR="${ROAM_BIN_DIR:-${HOME}/.local/bin}"
SERVICE_NAME="roam"

# ── 输出助手 ─────────────────────────────────────────────────────
if [ -t 1 ]; then
  bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; cyan=$'\e[36m'; yellow=$'\e[33m'; reset=$'\e[0m'
else
  bold=''; dim=''; green=''; cyan=''; yellow=''; reset=''
fi
info() { echo -e " ${green}✔${reset} $*"; }
step() { echo -e " ${cyan}●${reset} $*"; }
warn() { echo -e "  ${yellow}⚠ $*${reset}"; }
die()  { echo -e " ✘ $*" >&2; exit 1; }

# ── 平台检测 → release 资产名 roam-<os>-<arch> ───────────────────
detect_asset() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) die "暂不支持的系统: $(uname -s)（支持 Linux / macOS）" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "暂不支持的架构: $(uname -m)（支持 amd64 / arm64）" ;;
  esac
  OS="$os"; ASSET="roam-${os}-${arch}"
}

# 解析生效的 release tag：显式 ROAM_VERSION 直接用；否则优先 stable「latest」，
# 若仓库只有 prerelease（latest 会 404）则退回 GitHub API 取最新一个 release（含 prerelease）。
resolve_tag() {
  [ "$VERSION" != latest ] && { echo "$VERSION"; return; }
  if curl -fsIL -o /dev/null "https://github.com/${REPO}/releases/latest/download/${ASSET}" 2>/dev/null; then
    echo latest; return
  fi
  curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=1" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
}

download_url() {  # <tag>
  local tag="$1"
  if [ -z "$tag" ] || [ "$tag" = latest ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${ASSET}"
  else
    echo "https://github.com/${REPO}/releases/download/${tag}/${ASSET}"
  fi
}

# ── 安装二进制：下载 release，或（ROAM_FROM_SOURCE / 下载失败且在 clone 内）从源码构建 ──
install_binary() {
  mkdir -p "$BIN_DIR"
  local dest="${BIN_DIR}/roam"

  if [ "${ROAM_FROM_SOURCE:-0}" != 1 ]; then
    local tag url; tag="$(resolve_tag)"; url="$(download_url "$tag")"
    step "下载 ${ASSET} (${tag:-latest})..."
    if curl -fSL --progress-bar -o "${dest}.tmp" "$url"; then
      mv "${dest}.tmp" "$dest"; chmod +x "$dest"
      info "roam 已安装到 $dest"
      return 0
    fi
    rm -f "${dest}.tmp"
    warn "下载失败（可能该 release 尚未发布）。"
  fi

  # 源码构建回退（需在 clone 内，且有 go+node）
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
  if [ -f "${here}/scripts/build/build-roam.sh" ] && command -v go >/dev/null && command -v npm >/dev/null; then
    step "从源码构建 roam（scripts/build/build-roam.sh）..."
    ( cd "$here" && bash scripts/build/build-roam.sh )
    local built; built="$(ls -1 "${here}/backend/dist/roam-"* 2>/dev/null | head -1)"
    [ -n "$built" ] || die "源码构建未产出二进制"
    cp "$built" "$dest"; chmod +x "$dest"
    info "roam 已从源码构建并安装到 $dest"
    return 0
  fi
  die "无法安装 roam：下载失败且非源码环境（需 clone 仓库 + go/npm，或先发布 release）"
}

# ── tmux（会话基座）：roam 内嵌 ttmux，但会话/蜂群仍需宿主机的 tmux ─────
ensure_tmux() {
  command -v tmux >/dev/null && { info "tmux 已就绪"; return 0; }
  local sudo=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && sudo=sudo
  step "未检测到 tmux，尝试自动安装（可能需要 sudo 口令）..."
  if   command -v apt-get >/dev/null; then $sudo apt-get update -qq && $sudo apt-get install -y -qq tmux
  elif command -v dnf     >/dev/null; then $sudo dnf install -y tmux
  elif command -v yum     >/dev/null; then $sudo yum install -y tmux
  elif command -v pacman  >/dev/null; then $sudo pacman -Sy --noconfirm tmux
  elif command -v zypper  >/dev/null; then $sudo zypper -n install tmux
  elif command -v apk     >/dev/null; then $sudo apk add tmux
  elif command -v brew    >/dev/null; then brew install tmux
  fi
  command -v tmux >/dev/null && info "tmux 已安装" || warn "tmux 未安装：会话/蜂群功能需要它，请手动安装后重试"
}

# ── Chromium（「浏览器」镜像页需要一台 Chrome/Chromium 才能投屏）─────
# roam 后端按 google-chrome → chromium → chromium-browser 的顺序在 PATH 里探测，
# 都没有就会「拉起 Chrome 失败」。ROAM_NO_CHROME=1 可跳过（则浏览器镜像页不可用）。
ensure_chrome() {
  [ "${ROAM_NO_CHROME:-0}" = 1 ] && { step "ROAM_NO_CHROME=1：跳过 Chromium（浏览器镜像页将不可用）"; return 0; }
  if command -v google-chrome >/dev/null || command -v chromium >/dev/null || command -v chromium-browser >/dev/null; then
    info "Chrome/Chromium 已就绪（浏览器镜像可用）"; return 0
  fi
  local sudo=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && sudo=sudo
  step "未检测到 Chrome/Chromium，尝试安装 Chromium（较大；ROAM_NO_CHROME=1 可跳过）..."
  if   command -v apt-get >/dev/null; then
    $sudo apt-get install -y -qq chromium 2>/dev/null \
      || $sudo apt-get install -y -qq chromium-browser 2>/dev/null \
      || { command -v snap >/dev/null && $sudo snap install chromium; }
  elif command -v dnf    >/dev/null; then $sudo dnf install -y chromium
  elif command -v pacman >/dev/null; then $sudo pacman -Sy --noconfirm chromium
  elif command -v zypper >/dev/null; then $sudo zypper -n install chromium
  elif command -v apk    >/dev/null; then $sudo apk add chromium
  elif command -v snap   >/dev/null; then $sudo snap install chromium
  elif command -v brew   >/dev/null; then brew install --cask chromium 2>/dev/null || brew install chromium
  fi
  if command -v google-chrome >/dev/null || command -v chromium >/dev/null || command -v chromium-browser >/dev/null; then
    info "Chromium 已安装（浏览器镜像可用）"
  else
    warn "未能自动安装 Chromium：浏览器镜像页不可用。装好后 roam 会自动探测，或设 CHROME_BIN 指向可执行文件；重启：systemctl --user restart roam"
  fi
}

# ── adb（「手机」镜像页需要 adb 才能连 Android 设备）─────────────────
# ROAM_NO_ADB=1 可跳过（则手机镜像页不可用）。
ensure_adb() {
  [ "${ROAM_NO_ADB:-0}" = 1 ] && { step "ROAM_NO_ADB=1：跳过 adb（手机镜像页将不可用）"; return 0; }
  command -v adb >/dev/null && { info "adb 已就绪（手机镜像可用）"; return 0; }
  local sudo=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && sudo=sudo
  step "未检测到 adb，尝试安装（手机镜像页用）..."
  if   command -v apt-get >/dev/null; then $sudo apt-get install -y -qq adb 2>/dev/null || $sudo apt-get install -y -qq android-tools-adb 2>/dev/null
  elif command -v dnf     >/dev/null; then $sudo dnf install -y android-tools
  elif command -v yum     >/dev/null; then $sudo yum install -y android-tools
  elif command -v pacman  >/dev/null; then $sudo pacman -Sy --noconfirm android-tools
  elif command -v zypper  >/dev/null; then $sudo zypper -n install android-tools
  elif command -v apk     >/dev/null; then $sudo apk add android-tools
  elif command -v brew    >/dev/null; then brew install --cask android-platform-tools 2>/dev/null || brew install android-platform-tools
  fi
  command -v adb >/dev/null && info "adb 已安装（手机镜像可用）" \
    || warn "未能自动安装 adb：手机镜像页不可用，装好后重启：systemctl --user restart roam"
}

# ── systemd 常驻服务 ─────────────────────────────────────────────
install_service_user() {
  command -v systemctl >/dev/null || { warn "无 systemd，跳过服务注册；手动运行：${BIN_DIR}/roam"; return 0; }
  local unit_dir="${HOME}/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat > "${unit_dir}/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Roam web console
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${BIN_DIR}/roam
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service"
  # 让用户级服务在未登录时也常驻（服务器场景必需）
  if command -v loginctl >/dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || warn "loginctl enable-linger 失败：注销后服务可能停止（可 sudo loginctl enable-linger $USER）"
  fi
  info "已注册用户级 systemd 服务：systemctl --user status ${SERVICE_NAME}"
}

install_service_system() {
  command -v systemctl >/dev/null || die "无 systemd，无法注册系统级服务"
  local sudo=""; [ "$(id -u)" -ne 0 ] && sudo="sudo"
  local user="${SUDO_USER:-$USER}" home
  home="$(eval echo "~${user}")"
  $sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Roam web console
After=network-online.target
Wants=network-online.target

[Service]
User=${user}
Environment=HOME=${home}
ExecStart=${BIN_DIR}/roam
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $sudo systemctl daemon-reload
  $sudo systemctl enable --now "${SERVICE_NAME}.service"
  info "已注册系统级 systemd 服务：sudo systemctl status ${SERVICE_NAME}"
}

# ── 主流程 ───────────────────────────────────────────────────────
echo ""
echo -e "  ${bold}Roam${reset} ${dim}— 常驻安装（下载二进制 + systemd 常驻）${reset}"
echo ""

detect_asset
install_binary
ensure_tmux
ensure_chrome
ensure_adb

if [ "${ROAM_NO_SERVICE:-0}" = 1 ]; then
  step "ROAM_NO_SERVICE=1：跳过服务注册"
elif [ "${ROAM_SYSTEM:-0}" = 1 ]; then
  install_service_system
elif [ "$OS" = darwin ]; then
  warn "macOS 无 systemd，跳过服务注册；手动运行：${BIN_DIR}/roam（或用 launchd 自建）"
else
  install_service_user
fi

# PATH 提示
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  echo ""; warn "${BIN_DIR} 不在 PATH，请追加： export PATH=\"${BIN_DIR}:\$PATH\""
fi

PORT="13579"
echo ""
echo -e "  ${bold}完成!${reset}"
echo -e "  ${dim}控制台:${reset} https://<本机IP>:${PORT}  ${dim}(默认自签 HTTPS；设 web.tls: false 退回 http)${reset}"
echo -e "  ${dim}首次打开网页需设置登录口令；配置在 ~/.roam/config.yaml${reset}"
if [ "${ROAM_NO_SERVICE:-0}" != 1 ] && [ "$OS" != darwin ]; then
  echo -e "  ${dim}服务:${reset} systemctl --user {status|restart|stop} ${SERVICE_NAME}   ${dim}(或系统级 sudo systemctl …)${reset}"
fi
echo ""
