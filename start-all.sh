#!/usr/bin/env bash
# start-all.sh — 编译前端 + 后台守护启动后端（脱离终端，关终端/Ctrl-C 不影响）
#   bash start-all.sh         启动（后台守护，立即返回）
#   bash start-all.sh stop    停止
#   bash start-all.sh status  查看状态
#   bash start-all.sh logs    跟随日志
#   bash start-all.sh fg      前台运行（调试用，Ctrl-C 即停）
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

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
export TTMUX_BIN="${TTMUX_BIN:-$(pwd)/ttmux}"
export TTMUX_WEB_PASSWORD="${TTMUX_WEB_PASSWORD:-BladeAI2026!!}"
LAN=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

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

# ── 子命令：stop / status / logs ────────────────────────────────
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

# ── 开发模式：把仓库 skills/ 同步到 ~/.claude/skills（生产由 install.sh 装）─
#   蜂群成员(claude/codex)靠 ~/.claude/skills 自动加载 cc-swarm 协作规范；
#   开发时没跑 install.sh，这里复用同一套合并逻辑把 skills 拷过去。
if [ -f skills/sync-skills.sh ]; then
  bash skills/sync-skills.sh "${TTMUX_SKILLS_DIR:-$HOME/.claude/skills}" || true
fi

# ── 0. 可选：启动 kanna（Claude Code 精美 UI），并暴露给前端 ─────
KANNA_PORT="${KANNA_PORT:-3210}"
if command -v kanna >/dev/null 2>&1; then
  if lsof -ti tcp:"$KANNA_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "==> kanna 已在运行 :$KANNA_PORT"
  else
    echo "==> 启动 kanna :$KANNA_PORT（守护，关终端不影响）"
    setsid kanna --remote --port "$KANNA_PORT" --password "$TTMUX_WEB_PASSWORD" --no-open </dev/null >/tmp/kanna.log 2>&1 &
    sleep 1
  fi
  export TTMUX_KANNA_URL="${TTMUX_KANNA_URL:-http://${LAN:-127.0.0.1}:$KANNA_PORT}"
fi

# ── 1. 编译前端（有变更才重新构建）──────────────────────────────
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

# ── 2. 杀掉旧进程 ───────────────────────────────────────────────
pids="$(port_pids)"
if [ -n "${pids// /}" ]; then
  echo "==> 杀掉 :$PORT 上的旧进程 ($pids)"
  kill $pids 2>/dev/null || true
  sleep 1
  kill -9 $pids 2>/dev/null || true
fi

# ── 3. 编译后端（增量）──────────────────────────────────────────
BIN=backend/ttmux-web
# 检测 .go 与 go:embed 的资源(*.tmpl/*.html)变更，避免改模板却跳过编译
if [ ! -f "$BIN" ] || [ "$(find backend \( -name '*.go' -o -name '*.tmpl' -o -name '*.html' \) -newer "$BIN" 2>/dev/null | head -1)" ]; then
  echo "==> 编译后端..."
  (cd backend && go build -o ttmux-web ./cmd)
else
  echo "==> 后端无变更，跳过编译"
fi

# ── 4. 启动 ─────────────────────────────────────────────────────
echo "==> 启动 ttmux-web  http://$BIND  （口令: $TTMUX_WEB_PASSWORD）"
[ -n "$LAN" ] && echo "==> 手机/平板（同 WiFi）: http://$LAN:$PORT"

# fg：前台运行（调试，Ctrl-C 即停）
if [ "${1:-}" = "fg" ]; then
  shift
  exec "$BIN" -web "$(pwd)/frontend/dist" -addr "$BIND" "$@"
fi

# 默认：后台守护。setsid 脱离当前终端会话 → 关终端 / Ctrl-C 都不影响
setsid "$BIN" -web "$(pwd)/frontend/dist" -addr "$BIND" "$@" </dev/null >>"$LOG" 2>&1 &
sleep 1
pids="$(port_pids)"
[ -n "${pids// /}" ] && echo "$pids" | tr ' ' '\n' | head -1 > "$PIDFILE"
echo "==> 已后台守护运行（日志: $LOG）"
echo "    停止: bash start-all.sh stop   状态: bash start-all.sh status   日志: bash start-all.sh logs"
