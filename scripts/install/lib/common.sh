# scripts/install/lib/common.sh — 公共：颜色 + 日志助手。被 install.sh 及各模块 source。
# 纯函数库，无副作用（不要在此 set -e / 跑检测）。
# shellcheck shell=bash

bold=$'\033[1m'; green=$'\033[32m'; cyan=$'\033[36m'; dim=$'\033[2m'; reset=$'\033[0m'

info()  { echo -e " ${green}✔${reset} $*"; }
step()  { echo -e " ${cyan}●${reset} $*"; }
warn()  { echo -e "  ${dim}⚠ $*${reset}"; }
head2() { echo ""; echo -e " ${bold}${cyan}▶ $*${reset}"; }   # 模块标题
die()   { echo -e " ✘ $*" >&2; exit 1; }
