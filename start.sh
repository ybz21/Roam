#!/usr/bin/env bash
# start.sh — 启动 ttmux-web（后台守护，关终端/Ctrl-C 不影响）
#
#   bash start.sh            直接启动 install.sh 已构建的产物（不重新编译，最快）
#   bash start.sh --dev      开发模式：每次增量编译前端+后端再启动（并刷新 CLI/skills）
#   bash start.sh stop       停止
#   bash start.sh status     查看状态
#   bash start.sh logs       跟随日志
#   bash start.sh fg         前台运行（调试用，Ctrl-C 即停）；可与 --dev 同用
#
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"

# ── 解析 --dev（与子命令分离）────────────────────────────────────
DEV=0; ARGS=()
for a in "$@"; do
  case "$a" in
    --dev|-dev|dev) DEV=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ ${#ARGS[@]} -gt 0 ]; then set -- "${ARGS[@]}"; else set --; fi

# ── 配置：由后端 ttmux-web 解析 config.yaml（优先级 flag > 环境变量 > 文件 > 默认）─────
# start.sh 不再自己解析配置：调用 `ttmux-web config show` 拿解析后的值，保证「配置解析」只有一处实现。
# 二进制尚未构建时（dev 首次），回退到环境变量/默认，够 stop/status 用；启动前会再 `config ensure` 一次。
BIN=backend/ttmux-web
if [ -x "$BIN" ]; then
  eval "$("$BIN" config show 2>/dev/null || true)"
fi
BIND="${TTMUX_CFG_BIND:-${TTMUX_WEB_BIND:-0.0.0.0:13579}}"
PORT="${BIND##*:}"
export TTMUX_BIN="${TTMUX_BIN:-ttmux}"   # 系统级 ttmux（install.sh 装到 ~/.local/bin，已在 PATH）
# 若 TTMUX_BIN 指向具体路径却不存在（如继承了已删除的仓库根 ./ttmux），回退到 PATH 上的 ttmux，
# 否则后端 exec 不到 ttmux，所有 swarm/会话操作会 500。
if [[ "$TTMUX_BIN" == */* && ! -x "$TTMUX_BIN" ]]; then
  echo "==> TTMUX_BIN=$TTMUX_BIN 不存在，回退用 PATH 上的 ttmux"
  export TTMUX_BIN=ttmux
fi
# 确保 ttmux CLI 可用：找不到时尝试从源码自动编译，失败则报错退出。
if ! command -v "$TTMUX_BIN" &>/dev/null && [[ "$TTMUX_BIN" != */* || ! -x "$TTMUX_BIN" ]]; then
  CLI_SRC="$(pwd)/cli/ttmux-cli-go"
  INSTALL_DIR="${HOME}/.local/bin"
  if [[ -d "$CLI_SRC" ]] && command -v go &>/dev/null; then
    echo "==> ttmux 未安装，从 cli/ttmux-cli-go 自动编译..."
    mkdir -p "$INSTALL_DIR"
    if (cd "$CLI_SRC" && CGO_ENABLED=0 go build -o "${INSTALL_DIR}/ttmux" ./cmd/ttmux-cli-go); then
      chmod +x "${INSTALL_DIR}/ttmux"
      echo "==> ttmux 已编译安装到 ${INSTALL_DIR}/ttmux"
    else
      echo "✘ ttmux 自动编译失败。请手动运行: cd cli/ttmux-cli-go && go build -o ~/.local/bin/ttmux ./cmd/ttmux-cli-go"
      exit 1
    fi
  else
    echo "✘ 找不到 ttmux CLI（$TTMUX_BIN），新建/管理会话将全部失败。"
    echo "  安装方法："
    echo "    1. 运行 bash install.sh 完整安装"
    echo "    2. 或手动编译: cd cli/ttmux-cli-go && go build -o ~/.local/bin/ttmux ./cmd/ttmux-cli-go"
    exit 1
  fi
fi
# 登录口令在子命令(stop/status/logs)处理之后、后端构建之后再 `config ensure` 解析，
# 避免这些操作也触发生成/写口令。
# 自签 HTTPS：默认开启。手机经局域网用麦克风(语音)/剪贴板(一键粘贴)需「安全上下文」，
# 纯 http 会被浏览器禁用这些能力。设 config.yaml 的 web.tls=false（或 TTMUX_WEB_TLS=0）退回 http。
if [ -n "${TTMUX_CFG_SCHEME:-}" ]; then
  SCHEME="$TTMUX_CFG_SCHEME"
else
  case "$(echo "${TTMUX_WEB_TLS:-1}" | tr 'A-Z' 'a-z')" in
    0|off|false|no) SCHEME=http ;;
    *)              SCHEME=https ;;
  esac
fi
OS="$(uname -s 2>/dev/null || echo unknown)"

lan_ip() {
  if [ "$OS" = "Darwin" ]; then
    ipconfig getifaddr en0 2>/dev/null \
      || ipconfig getifaddr en1 2>/dev/null \
      || route -n get default 2>/dev/null | awk '/interface:/{print $2}' | xargs -I{} ipconfig getifaddr {} 2>/dev/null \
      || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

daemon_start() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" </dev/null >>"$LOG" 2>&1 &
  else
    nohup "$@" </dev/null >>"$LOG" 2>&1 &
  fi
}

LAN=$(lan_ip)
LOG="${TTMUX_WEB_LOG:-/tmp/ttmux-web.log}"
PIDFILE="${TTMUX_WEB_PID:-/tmp/ttmux-web.pid}"

# 找当前监听 PORT 的进程
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT" 2>/dev/null || true
  fi
}

# ── 子命令：stop / status / logs（不分 dev/非 dev）────────────────
case "${1:-}" in
  stop)
    pids="$(port_pids)"
    [ -f "$PIDFILE" ] && pids="$pids $(cat "$PIDFILE" 2>/dev/null || true)"
    pids="$(echo $pids | tr ' ' '\n' | sort -u | tr '\n' ' ')"
    if [ -z "${pids// /}" ]; then echo "ttmux-web 未在运行"; else
      echo "==> 停止 ttmux-web ($pids)"
      kill $pids 2>/dev/null || true; sleep 1; kill -9 $pids 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
    exit 0 ;;
  status)
    pids="$(port_pids)"
    if [ -n "${pids// /}" ]; then echo "ttmux-web 运行中 :$PORT (pid $pids)"; else echo "ttmux-web 未运行"; fi
    exit 0 ;;
  logs)
    exec tail -n 100 -f "$LOG" ;;
esac

# 登录口令的解析/生成挪到后端构建之后（见下方 `config ensure`），因为要用到 ttmux-web 二进制。
PW_GENERATED=0

# ── dev：刷新 CLI/chrome/skills（跳过后端，交给本脚本增量编译）──────
if [ "$DEV" = 1 ] && [ -f install.sh ]; then
  echo "==> [dev] 刷新 ttmux + chrome + skills (install.sh, 跳过后端构建)..."
  TTMUX_SKIP_BACKEND=1 bash install.sh || { echo "✘ install.sh 失败"; exit 1; }
fi

# ── 前端依赖：仅目录存在不代表依赖完整 ───────────────────────────
# node_modules 可能是旧的：package.json 新增依赖后（如 @monaco-editor/react）
# 若只判断目录是否存在就会跳过安装，vite build 随即因找不到新依赖而失败。
# 因此当 node_modules 缺失，或 package-lock.json/package.json 比 node_modules 新时，重新安装。
ensure_frontend_deps() {
  if [ ! -d node_modules ]; then
    echo "==> 安装前端依赖..."
    npm install
  elif [ package-lock.json -nt node_modules ] || [ package.json -nt node_modules ]; then
    echo "==> 检测到依赖清单变更，重新安装前端依赖..."
    npm install
  fi
}
export -f ensure_frontend_deps  # 供 (cd frontend && ...) 子 shell 调用

# ── 前端：dev 增量编译；非 dev 直接用 install.sh 产物 ─────────────
if [ "$DEV" = 1 ]; then
  cd frontend
  ensure_frontend_deps
  if [ ! -f dist/index.html ] || [ "$(find src index.html vite.config.ts -newer dist/index.html 2>/dev/null | head -1)" ]; then
    echo "==> 编译前端 (frontend/)..."
    npx vite build
    echo "==> 前端编译完成 → frontend/dist/"
  else
    echo "==> 前端无变更，跳过编译"
  fi
  cd ..
elif [ ! -f frontend/dist/index.html ]; then
  echo "==> 未找到 frontend/dist，自动编译前端..."
  (cd frontend && ensure_frontend_deps && npx vite build)
elif [ "$(find frontend/src frontend/index.html frontend/vite.config.ts -newer frontend/dist/index.html 2>/dev/null | head -1)" ]; then
  echo "==> 检测到前端源码变更，自动重新编译..."
  (cd frontend && ensure_frontend_deps && npx vite build)
fi

# ── 杀掉旧进程 ───────────────────────────────────────────────────
pids="$(port_pids)"
if [ -n "${pids// /}" ]; then
  echo "==> 杀掉 :$PORT 上的旧进程 ($pids)"
  kill $pids 2>/dev/null || true
  sleep 1
  kill -9 $pids 2>/dev/null || true
fi

# ── 后端：dev 增量编译；非 dev 直接用 install.sh 产物 ─────────────
if [ "$DEV" = 1 ]; then
  # 检测 .go 与 go:embed 的资源(*.tmpl/*.html)变更，避免改模板却跳过编译
  if [ ! -f "$BIN" ] || [ "$(find backend \( -name '*.go' -o -name '*.tmpl' -o -name '*.html' \) -newer "$BIN" 2>/dev/null | head -1)" ]; then
    echo "==> 编译后端..."
    (cd backend && go build -o ttmux-web ./cmd)
  else
    echo "==> 后端无变更，跳过编译"
  fi
elif [ ! -x "$BIN" ]; then
  echo "✘ 未找到 $BIN —— 先构建：bash install.sh   或   bash start.sh --dev"; exit 1
fi

# ── 配置最终解析：后端已就位，用 `config ensure` 拿口令（为空则生成并写回 config.yaml）+ 各解析值 ──
eval "$("$BIN" config ensure)"
BIND="${TTMUX_CFG_BIND:-$BIND}"
PORT="${BIND##*:}"
SCHEME="${TTMUX_CFG_SCHEME:-$SCHEME}"
TTMUX_WEB_PASSWORD="${TTMUX_CFG_PASSWORD:-}"
PW_GENERATED="${TTMUX_CFG_PW_GENERATED:-0}"

# ── 启动 ─────────────────────────────────────────────────────────
echo "==> 启动 ttmux-web  $SCHEME://$BIND  （口令: ${TTMUX_WEB_PASSWORD}）"
if [ "$PW_GENERATED" = 1 ]; then
  echo "    ★ 已为你随机生成登录口令并写入 ${TTMUX_CFG_PATH:-config.yaml}：${TTMUX_WEB_PASSWORD}"
  echo "      改密码：编辑 ${TTMUX_CFG_PATH:-config.yaml} 的 web.password（或设 TTMUX_WEB_PASSWORD 环境变量）后重启。"
fi
[ -n "$LAN" ] && echo "==> 手机/平板（同 WiFi）: $SCHEME://$LAN:$PORT"
[ "$SCHEME" = https ] && echo "    （自签证书：手机首次访问点「高级 → 继续前往」即可，之后语音/剪贴板可用；如需 http 设 web.tls=false）"

# fg：前台运行（调试，Ctrl-C 即停）
if [ "${1:-}" = "fg" ]; then
  shift
  exec "$BIN" -web "$(pwd)/frontend/dist" -addr "$BIND" "$@"
fi

# 默认：后台守护。Linux 优先 setsid；macOS 无 setsid 时使用 nohup。
daemon_start "$BIN" -web "$(pwd)/frontend/dist" -addr "$BIND" "$@"
sleep 1
pids="$(port_pids)"
[ -n "${pids// /}" ] && echo "$pids" | tr ' ' '\n' | head -1 > "$PIDFILE"
echo "==> 已后台守护运行（日志: ${LOG}）"
echo "    停止: bash start.sh stop   状态: bash start.sh status   日志: bash start.sh logs"
