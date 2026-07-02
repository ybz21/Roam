#!/usr/bin/env bash
# scripts/phone/install-phone.sh [android|ios|auto] — 按需(插件化)安装手机后端依赖。
#
# 不在 install.sh 主流程预装;由设置页「手机」的平台开关触发(后端 POST /phone/install),
# 或手动 `bash scripts/phone/install-phone.sh android`。
#   android → 确保 adb(platform-tools)
#   ios     → 确保 idb(idb-companion + fb-idb，仅 macOS)
#
# 非交互运行:Linux 装包用 sudo -n(无免密 sudo 则跳过并给手动指引,不卡住后端)。
set -uo pipefail

target="${1:-auto}"
OS="$(uname -s 2>/dev/null || echo unknown)"
say()  { echo "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# brew_install <cask|formula...>：跑 brew install 并透传真实退出码/输出。
# 撞下载锁（上次安装的孤儿进程残留）时，清掉陈旧的 .incomplete 半成品后重试一次，
# 避免反复报“已被另一个 brew install 进程锁定”而永远装不上。
brew_install() {
    local out rc
    out="$(brew install "$@" 2>&1)"; rc=$?
    echo "$out"
    if [ $rc -ne 0 ] && echo "$out" | grep -q "has already locked"; then
        say "↳ 撞到陈旧下载锁，清理半成品后重试…"
        find "$(brew --cache 2>/dev/null || echo "$HOME/Library/Caches/Homebrew")/downloads" \
            -name '*.incomplete' -mmin +1 -delete 2>/dev/null || true
        out="$(brew install "$@" 2>&1)"; rc=$?
        echo "$out"
    fi
    return $rc
}

install_adb() {
    have adb && { say "✔ adb 已就绪（$(adb version 2>/dev/null | head -1)）"; return 0; }
    case "$OS" in
        Darwin)
            if have brew; then say "brew install android-platform-tools…"; brew_install android-platform-tools || true
            else say "需先装 Homebrew(https://brew.sh)再 brew install android-platform-tools"; fi ;;
        Linux)
            if have apt-get; then say "apt 安装 adb…"; sudo -n apt-get install -y adb 2>&1 || say "↳ 需 sudo:sudo apt-get install -y adb"
            elif have dnf; then say "dnf 安装 android-tools…"; sudo -n dnf install -y android-tools 2>&1 || say "↳ 需 sudo:sudo dnf install -y android-tools"
            elif have pacman; then say "pacman 安装 android-tools…"; sudo -n pacman -S --noconfirm android-tools 2>&1 || say "↳ 需 sudo:sudo pacman -S android-tools"
            else say "未知包管理器,请手动安装 Android SDK platform-tools"; fi ;;
        *) say "未知系统,请手动安装 adb" ;;
    esac
    have adb && say "✔ adb 安装完成" || say "✘ adb 仍未就绪"
}

install_idb() {
    [ "$OS" = Darwin ] || { say "✘ idb 仅 macOS(iOS 模拟器);当前 $OS"; return 1; }
    have xcrun || say "⚠ 需 Xcode 命令行工具:xcode-select --install"
    have idb && { say "✔ idb 已就绪"; return 0; }
    if have brew; then say "brew install idb-companion…"; brew_install idb-companion || true
    else say "需先装 Homebrew(https://brew.sh)"; fi
    if have pip3; then say "pip3 install fb-idb…"; pip3 install --user fb-idb 2>&1 || true
    else say "需 pip3 再 pip3 install fb-idb"; fi
    have idb && say "✔ idb 安装完成" || say "✘ idb 仍未就绪(手动:brew install idb-companion && pip3 install fb-idb)"
}

case "$target" in
    android) install_adb ;;
    ios)     install_idb ;;
    auto)    if [ "$OS" = Darwin ]; then install_idb; install_adb; else install_adb; fi ;;
    *)       echo "用法: $0 android|ios|auto"; exit 2 ;;
esac
