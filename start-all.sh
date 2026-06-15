#!/usr/bin/env bash
# start-all.sh — 编译前端 + 启动后端（后端从磁盘提供前端静态文件）
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

BIND="${TTMUX_WEB_BIND:-0.0.0.0:8080}"
PORT="${BIND##*:}"
export TTMUX_BIN="${TTMUX_BIN:-$(pwd)/ttmux}"
export TTMUX_WEB_PASSWORD="${TTMUX_WEB_PASSWORD:-BladeAI2026!!}"
LAN=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

# ── 0. 可选：启动 kanna（Claude Code 精美 UI），并暴露给前端 ─────
KANNA_PORT="${KANNA_PORT:-3210}"
if command -v kanna >/dev/null 2>&1; then
  if lsof -ti tcp:"$KANNA_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "==> kanna 已在运行 :$KANNA_PORT"
  else
    echo "==> 启动 kanna :$KANNA_PORT（局域网可达，口令同控制台）"
    nohup kanna --remote --port "$KANNA_PORT" --password "$TTMUX_WEB_PASSWORD" --no-open >/tmp/kanna.log 2>&1 &
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
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
elif command -v fuser >/dev/null 2>&1; then
  pids=$(fuser -n tcp "$PORT" 2>/dev/null || true)
else
  pids=""
fi
if [ -n "$pids" ]; then
  echo "==> 杀掉 :$PORT 上的旧进程 ($pids)"
  kill $pids 2>/dev/null || true
  sleep 1
  kill -9 $pids 2>/dev/null || true
fi

# ── 3. 编译后端（增量）──────────────────────────────────────────
BIN=backend/ttmux-web
if [ ! -f "$BIN" ] || [ "$(find backend -name '*.go' -newer "$BIN" 2>/dev/null | head -1)" ]; then
  echo "==> 编译后端..."
  (cd backend && go build -o ttmux-web ./cmd)
else
  echo "==> 后端无变更，跳过编译"
fi

# ── 4. 启动（后端代理 frontend/dist）────────────────────────────
echo "==> 启动 ttmux-web  http://$BIND  （口令: $TTMUX_WEB_PASSWORD）"
LAN=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -n "$LAN" ] && echo "==> 手机/平板（同 WiFi）: http://$LAN:$PORT"
exec "$BIN" -web "$(pwd)/frontend/dist" -addr "$BIND" "$@"
