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

# ── 配置：加载 .env（已存在的环境变量优先）──────────────────────
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    [ "${line#*=}" = "$line" ] && continue
    key="${line%%=*}"; key="$(echo "$key" | tr -d '[:space:]')"
    [ -z "$(eval "echo \${$key:-}")" ] && export "$key=${line#*=}"
  done < .env
fi

BIND="${TTMUX_WEB_BIND:-0.0.0.0:13579}"
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
# 登录口令在子命令(stop/status/logs)处理之后再解析，避免这些操作也触发生成/写 .env。
# 自签 HTTPS：默认开启。手机经局域网用麦克风(语音)/剪贴板(一键粘贴)需「安全上下文」，
# 纯 http 会被浏览器禁用这些能力。设 TTMUX_WEB_TLS=0 可退回 http。证书由后端就地生成。
export TTMUX_WEB_TLS="${TTMUX_WEB_TLS:-1}"
case "$(echo "${TTMUX_WEB_TLS}" | tr 'A-Z' 'a-z')" in
  0|off|false|no) export TTMUX_WEB_TLS=0; SCHEME=http ;;
  *)              export TTMUX_WEB_TLS=1; SCHEME=https ;;
esac
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

# ── 登录口令：用户可通过环境变量或 .env 自定义；未配置时首次启动随机生成并写回 .env ──
# 改密码：编辑 .env 里的 TTMUX_WEB_PASSWORD（或导出同名环境变量）后重启即可。
PW_GENERATED=0
if [ -z "${TTMUX_WEB_PASSWORD:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    TTMUX_WEB_PASSWORD="ttmux-$(openssl rand -hex 4)"
  else
    TTMUX_WEB_PASSWORD="ttmux-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8)"
  fi
  # 持久化到 .env（gitignored），让用户能查看/修改：已有键则替换其值，否则追加。
  touch .env
  if grep -qE '^[[:space:]]*TTMUX_WEB_PASSWORD=' .env; then
    tmp="$(mktemp)"
    sed -E "s|^[[:space:]]*TTMUX_WEB_PASSWORD=.*|TTMUX_WEB_PASSWORD=${TTMUX_WEB_PASSWORD}|" .env > "$tmp" && mv "$tmp" .env
  else
    printf '\n# 自动生成的登录口令（可在本文件修改后重启生效）\nTTMUX_WEB_PASSWORD=%s\n' "$TTMUX_WEB_PASSWORD" >> .env
  fi
  PW_GENERATED=1
fi
export TTMUX_WEB_PASSWORD

BIN=backend/ttmux-web

# ── dev：刷新 CLI/chrome/skills（跳过后端，交给本脚本增量编译）──────
if [ "$DEV" = 1 ] && [ -f install.sh ]; then
  echo "==> [dev] 刷新 ttmux + chrome + skills (install.sh, 跳过后端构建)..."
  TTMUX_SKIP_BACKEND=1 bash install.sh || { echo "✘ install.sh 失败"; exit 1; }
fi

# ── 前端：dev 增量编译；非 dev 直接用 install.sh 产物 ─────────────
if [ "$DEV" = 1 ]; then
  cd frontend
  if [ ! -d node_modules ]; then
    echo "==> 安装前端依赖..."
    npm install
  fi
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
  (cd frontend && [ -d node_modules ] || npm install && npx vite build)
elif [ "$(find frontend/src frontend/index.html frontend/vite.config.ts -newer frontend/dist/index.html 2>/dev/null | head -1)" ]; then
  echo "==> 检测到前端源码变更，自动重新编译..."
  (cd frontend && npx vite build)
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

# ── 启动 ─────────────────────────────────────────────────────────
echo "==> 启动 ttmux-web  $SCHEME://$BIND  （口令: ${TTMUX_WEB_PASSWORD}）"
if [ "$PW_GENERATED" = 1 ]; then
  echo "    ★ 已为你随机生成登录口令并写入 .env：${TTMUX_WEB_PASSWORD}"
  echo "      改密码：编辑 .env 的 TTMUX_WEB_PASSWORD（或设同名环境变量）后重启。"
fi
[ -n "$LAN" ] && echo "==> 手机/平板（同 WiFi）: $SCHEME://$LAN:$PORT"
[ "$SCHEME" = https ] && echo "    （自签证书：手机首次访问点「高级 → 继续前往」即可，之后语音/剪贴板可用；如需 http 设 TTMUX_WEB_TLS=0）"

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
