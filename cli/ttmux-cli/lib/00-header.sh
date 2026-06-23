#!/usr/bin/env bash
#
# ttmux - AI-native tmux wrapper
# https://github.com/ybz21/ttmux
#
# ⚠ 本文件由 cli/ttmux-cli/build.sh 自动生成，请勿直接编辑。
#   改 cli/ttmux-cli/lib/*.sh 后运行 cli/ttmux-cli/build.sh 重新生成。
#

set -euo pipefail

TTMUX_VERSION="0.4.1"
TMUX_BIN="$(command -v tmux)"
TTMUX_DATA="${TTMUX_DATA:-${HOME}/.local/share/ttmux}"
TTMUX_LOGS="${TTMUX_DATA}/logs"
TTMUX_GROUPS="${TTMUX_DATA}/groups"
TTMUX_ENV="${TTMUX_DATA}/env"
TTMUX_META="${TTMUX_DATA}/meta"
TTMUX_SWARMS="${TTMUX_DATA}/swarms"
# 蜂群 SQLite 存储新家（meta.db + swarms/<id>/swarm.db）；普通会话暂留 TTMUX_DATA
TTMUX_HOME="${TTMUX_HOME:-${HOME}/.ttmux}"

mkdir -p "$TTMUX_LOGS" "$TTMUX_GROUPS" "$TTMUX_META" "$TTMUX_SWARMS"

# 保证 locale 为 UTF-8：tmux 按客户端 LC_*/LANG 是否含 UTF-8 决定能否渲染中文，
# pane 里的 ls 也依赖它正确输出文件名。非 UTF-8(如 C/POSIX)时补 C.UTF-8 并导出给 tmux 子进程，
# 避免中文乱码；已是 UTF-8 则尊重现有设置。
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*UTF8*|*utf-8*|*utf8*) : ;;
    *) export LC_ALL=C.UTF-8 ;;
esac

