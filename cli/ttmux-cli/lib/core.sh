# ── 颜色 ──
bold=$'\033[1m'
dim=$'\033[2m'
cyan=$'\033[36m'
green=$'\033[32m'
yellow=$'\033[33m'
red=$'\033[31m'
blue=$'\033[34m'
magenta=$'\033[35m'
reset=$'\033[0m'

# ── 图标 ──
icon_session="▸"
icon_window="◻"
icon_ok="✔"
icon_err="✘"
icon_info="●"
icon_warn="⚠"
icon_run="⟳"
icon_done="■"
icon_group="◆"

msg_ok()   { echo -e " ${green}${icon_ok}${reset} $*"; }
msg_err()  { echo -e " ${red}${icon_err}${reset} $*" >&2; }
msg_info() { echo -e " ${blue}${icon_info}${reset} $*"; }
msg_warn() { echo -e " ${yellow}${icon_warn}${reset} $*"; }

# ── 辅助函数 ──
_sessions() {
    "$TMUX_BIN" list-sessions -F '#{session_name}' 2>/dev/null
}

_session_count() {
    "$TMUX_BIN" list-sessions 2>/dev/null | wc -l
}

_session_exists() {
    "$TMUX_BIN" has-session -t "$1" 2>/dev/null
}

_pretty_sessions() {
    local lines
    lines=$("$TMUX_BIN" list-sessions -F '#{session_name}	#{session_windows}	#{session_created}	#{session_attached}' 2>/dev/null) || true
    if [[ -z "$lines" ]]; then
        msg_info "没有活跃会话"
        return
    fi
    echo ""
    local count=0
    while IFS=$'\t' read -r name windows created attached; do
        local att_str="${dim}[空闲]${reset}"
        [[ "$attached" == "1" ]] && att_str="${green}[已连接]${reset}"
        local time_str
        time_str=$(date -d "@${created}" '+%m-%d %H:%M' 2>/dev/null || date -r "${created}" '+%m-%d %H:%M' 2>/dev/null || echo "${created}")
        echo -e "   ${icon_session} ${bold}${name}${reset}  ${dim}${windows} 个窗口  ${time_str}${reset}  ${att_str}"
        ((count++)) || true
    done <<< "$lines"
    echo ""
    echo -e "   ${dim}共 ${count} 个会话${reset}"
    echo ""
}

_pick_session() {
    local prompt="${1:-选择会话}"
    local sessions
    sessions=$(_sessions)
    if [[ -z "$sessions" ]]; then
        msg_err "没有活跃会话"
        return 1
    fi
    local names=()
    while IFS= read -r s; do
        names+=("$s")
    done <<< "$sessions"
    if [[ ${#names[@]} -eq 1 ]]; then
        echo "${names[0]}"
        return 0
    fi
    echo "" >&2
    echo -e "   ${bold}${prompt}:${reset}" >&2
    echo "" >&2
    local i=1
    for s in "${names[@]}"; do
        local attached=""
        if "$TMUX_BIN" list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null | grep -q "^${s} 1$"; then
            attached=" ${green}[已连接]${reset}"
        fi
        echo -e "   ${cyan}${i})${reset} ${s}${attached}" >&2
        ((i++)) || true
    done
    echo "" >&2
    read -r -p "   输入编号或名称: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#names[@]} )); then
        echo "${names[$((choice-1))]}"
    else
        echo "$choice"
    fi
}

_confirm() {
    local prompt="${1:-确定要继续吗?}"
    read -r -p "   ${prompt} [y/N] " ans </dev/tty
    [[ "$ans" =~ ^[Yy]$ ]]
}

# ── JSON 输出 ──
_json_sessions() {
    echo "["
    local first=true
    while IFS=$'\t' read -r name windows created attached; do
        [[ "$first" == true ]] || echo ","
        first=false
        printf '  {"name":"%s","windows":%s,"created":"%s","attached":%s}' \
            "$name" "$windows" "$created" "$attached"
    done < <("$TMUX_BIN" list-sessions -F '#{session_name}	#{session_windows}	#{session_created}	#{session_attached}' 2>/dev/null)
    echo ""
    echo "]"
}

