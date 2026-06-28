#!/usr/bin/env bash
#
# scripts/android-redroid.sh — 自适应起停 ttmux「手机」标签的 Android 后端(redroid)。
#
# 「自适应」= 探测宿主机能力,自动挑一套能开机的配置:
#   - binder:  未加载则 sudo modprobe(redroid 必需)
#   - ashmem:  Android 16 的 system_server 硬依赖 /dev/ashmem;主线内核 6.x 已移除该驱动。
#              本机无 ashmem 时,自动把目标版本从 16 回退到 15(15 及以下走 memfd,不需 ashmem)。
#   - GPU:     找到非 NVIDIA 的渲染节点(Intel/AMD)→ gpu_mode=host 走硬件加速(SurfaceFlinger 才稳);
#              否则 gpu_mode=guest(swiftshader 软件渲染,新版本可能崩)。
#   数据挂载到 ~/.ttmux/android/data(bind mount),容器删了数据仍在。
#
# 用法:
#   bash scripts/android-redroid.sh up [版本]   # 自适应起(已在跑则秒级复用);版本默认 16,无 ashmem 自动回退 15
#   bash scripts/android-redroid.sh down         # 只停不删(容器/数据保留,下次 up 秒级 start)
#   bash scripts/android-redroid.sh rm           # 删容器(数据仍在)
#   bash scripts/android-redroid.sh status       # 容器 + adb + 选用的配置
#   bash scripts/android-redroid.sh connect       # 仅重连 adb
#
# 仅 Linux。需 Docker;加载 binder 那步需 sudo。
set -euo pipefail

ADB_ADDR="localhost:5555"
DATA_DIR="${TTMUX_ANDROID_DATA:-$HOME/.ttmux/android}"
GEN_COMPOSE="${DATA_DIR}/docker-compose.yml"   # 自适应生成的有效 compose
CONTAINER="ttmux-redroid"

if [ -t 2 ]; then
    c_b=$'\033[34m'; c_r=$'\033[31m'; c_g=$'\033[32m'; c_y=$'\033[33m'; c_z=$'\033[0m'
else
    c_b=''; c_r=''; c_g=''; c_y=''; c_z=''
fi
info() { echo -e " ${c_b}●${c_z} $*" >&2; }
ok()   { echo -e " ${c_g}✔${c_z} $*" >&2; }
warn() { echo -e " ${c_y}!${c_z} $*" >&2; }
err()  { echo -e " ${c_r}✘${c_z} $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { err "需要 $1"; exit 1; }; }

compose() {
    if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

# ── 探测：binder ──
ensure_binder() {
    grep -qi binder /proc/filesystems 2>/dev/null && return 0
    info "加载 binder 内核模块(需 sudo)..."
    sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
    grep -qi binder /proc/filesystems 2>/dev/null && { ok "binder 就绪"; return 0; }
    err "binder 加载失败(内核需 CONFIG_ANDROID_BINDERFS)。redroid 无法启动。"; exit 1
}

# ── 探测：ashmem(决定能否上 Android 16) ──
has_ashmem() { grep -qi ashmem /proc/filesystems 2>/dev/null || [ -e /dev/ashmem ]; }

# ── 探测：GPU 渲染节点。回显 "mode|node"。优先 Intel(0x8086)/AMD(0x1002);跳过 NVIDIA(0x10de) ──
detect_gpu() {
    local n v base
    for n in /sys/class/drm/renderD*; do
        [ -e "$n/device/vendor" ] || continue
        v=$(cat "$n/device/vendor" 2>/dev/null)
        base=$(basename "$n")
        case "$v" in
            0x8086|0x1002) echo "host|/dev/dri/${base}"; return 0 ;;   # Intel / AMD → host 加速
        esac
    done
    echo "guest|"   # 无可用硬件 GPU → 软件渲染
}

# ── 选版本：默认 16;无 ashmem 自动回退 15 ──
pick_version() {
    local want="${1:-${TTMUX_ANDROID_VERSION:-16}}"
    if [ "$want" -ge 16 ] && ! has_ashmem; then
        warn "Android ${want} 需 ashmem,本内核(已移除 ashmem)不支持 → 回退 Android 15" >&2
        echo 15; return 0
    fi
    echo "$want"
}

# ── 生成有效 compose 到 ~/.ttmux/android ──
gen_compose() {
    local ver="$1" gpu_mode="$2" gpu_node="$3"
    local image="redroid/redroid:${ver}.0.0_64only-latest"
    local w="${TTMUX_ANDROID_W:-720}" h="${TTMUX_ANDROID_H:-1280}" dpi="${TTMUX_ANDROID_DPI:-320}"
    mkdir -p "${DATA_DIR}/data"
    {
        echo "# 由 scripts/android-redroid.sh 按宿主机能力自适应生成,请勿手改。"
        echo "services:"
        echo "  redroid:"
        echo "    image: ${image}"
        echo "    container_name: ${CONTAINER}"
        echo "    privileged: true"
        echo "    ports: [\"5555:5555\"]"
        echo "    volumes: [\"${DATA_DIR}/data:/data\"]"
        if [ "$gpu_mode" = "host" ]; then
            echo "    devices: [\"/dev/dri:/dev/dri\"]"
        fi
        echo "    command:"
        echo "      - androidboot.redroid_width=${w}"
        echo "      - androidboot.redroid_height=${h}"
        echo "      - androidboot.redroid_dpi=${dpi}"
        echo "      - androidboot.redroid_gpu_mode=${gpu_mode}"
        [ -n "$gpu_node" ] && echo "      - androidboot.redroid_gpu_node=${gpu_node}"
        echo "    restart: unless-stopped"
    } > "$GEN_COMPOSE"
}

connect() {
    need adb
    info "等待 Android 开机完成(首启较慢,最长 ~4 分钟)..."
    local i bc
    for i in $(seq 1 120); do
        adb connect "$ADB_ADDR" >/dev/null 2>&1 || true
        bc=$(adb -s "$ADB_ADDR" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
        [ "$bc" = "1" ] && { ok "Android 已就绪 → ttmux「手机」标签可镜像"; adb devices; return 0; }
        sleep 2
    done
    err "开机超时;看日志: docker logs ${CONTAINER}"; exit 1
}

case "${1:-up}" in
    up)
        need docker
        booted() { [ "$(adb -s "$ADB_ADDR" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }
        # ① 已在运行 → 直接复用,不重拉不重建(全局唯一实例,启停秒级)
        if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
            adb connect "$ADB_ADDR" >/dev/null 2>&1 || true
            if booted; then ok "redroid 已在运行,直接复用"; adb devices; exit 0; fi
            info "redroid 在跑但未就绪,等开机..."; connect; exit 0
        fi
        ensure_binder
        ver=$(pick_version "${2:-}")
        IFS='|' read -r gmode gnode <<< "$(detect_gpu)"
        image="redroid/redroid:${ver}.0.0_64only-latest"
        # ② 容器已存在但停了 → 镜像没变就 docker start(快,不重拉);变了才重建
        if docker inspect "$CONTAINER" >/dev/null 2>&1; then
            if [ "$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)" = "$image" ]; then
                info "复用已有容器(镜像未变),docker start..."; docker start "$CONTAINER" >/dev/null; connect; exit 0
            fi
            info "配置/版本变化 → 重建容器"; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        fi
        # ③ 全新创建
        info "自适应配置 → Android ${ver} · GPU ${gmode}${gnode:+ ($gnode)} · 数据 ${DATA_DIR}/data"
        gen_compose "$ver" "$gmode" "$gnode"
        compose -f "$GEN_COMPOSE" up -d
        connect
        ;;
    down)
        need docker
        # 只停不删 → 下次 up 走 docker start 秒级拉起(容器/数据都在)
        docker stop "$CONTAINER" >/dev/null 2>&1 && ok "已停止(容器保留,up 可秒级拉起)" || warn "容器未在运行"
        ;;
    rm|destroy)
        need docker
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        ok "容器已删除(数据仍在 ${DATA_DIR}/data;删数据: rm -rf ${DATA_DIR}/data)"
        ;;
    connect) connect ;;
    status)
        docker ps --filter "name=${CONTAINER}" --format '镜像 {{.Image}}  状态 {{.Status}}' || true
        command -v adb >/dev/null 2>&1 && adb devices || true
        [ -f "$GEN_COMPOSE" ] && { echo "--- 生成的配置 ---"; grep -E 'image:|gpu_mode|gpu_node|/data' "$GEN_COMPOSE"; }
        ;;
    *) err "用法: $0 up [版本]|down|rm|connect|status"; exit 2 ;;
esac
