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
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        _is_swarm_session "$name" && continue
        echo "$name"
    done < <("$TMUX_BIN" list-sessions -F '#{session_name}' 2>/dev/null)
}

_session_count() {
    _sessions | wc -l
}

_session_exists() {
    "$TMUX_BIN" has-session -t "$1" 2>/dev/null
}

_tmux_send_prompt_submit() {
    local target="$1" message="$2"
    if "$TMUX_BIN" set-buffer -b ttmux-prompt "$message" 2>/dev/null \
        && "$TMUX_BIN" paste-buffer -d -b ttmux-prompt -t "$target" 2>/dev/null; then
        :
    else
        "$TMUX_BIN" send-keys -t "$target" "$message" 2>/dev/null || return 1
    fi

    # Claude/Codex TUI inputs can accept pasted text while staying in edit mode.
    # Submit as separate key events, with a second Enter as a conservative fallback.
    "$TMUX_BIN" send-keys -t "$target" Enter 2>/dev/null \
        || "$TMUX_BIN" send-keys -t "$target" C-m 2>/dev/null \
        || return 1
    if [[ "${TTMUX_FORCE_PROMPT_SUBMIT:-1}" != "0" ]]; then
        sleep "${TTMUX_PROMPT_SUBMIT_DELAY:-0.05}"
        "$TMUX_BIN" send-keys -t "$target" Enter 2>/dev/null || true
    fi
}

_swarm_names() {
    local db="${TTMUX_HOME}/meta.db"
    if [[ -f "$db" ]] && command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$db" "SELECT name FROM swarms;" 2>/dev/null || true
    fi
    local d
    shopt -s nullglob
    for d in "${TTMUX_SWARMS}"/*; do
        [[ -d "$d" ]] || continue
        basename "$d"
    done
}

_swarm_supervisors() {
    local db="${TTMUX_HOME}/meta.db"
    [[ -f "$db" ]] || return 0
    command -v sqlite3 >/dev/null 2>&1 || return 0
    sqlite3 "$db" "SELECT supervisor FROM swarms WHERE IFNULL(supervisor,'')<>'';" 2>/dev/null || true
}

_is_swarm_session() {
    local sess="${1:-}" swarm gf member supervisor
    [[ -n "$sess" ]] || return 1
    while IFS= read -r supervisor; do
        [[ -n "$supervisor" && "$sess" == "$supervisor" ]] && return 0
    done < <(_swarm_supervisors)
    while IFS= read -r swarm; do
        [[ -n "$swarm" ]] || continue
        gf="${TTMUX_GROUPS}/${swarm}.group"
        [[ -f "$gf" ]] || continue
        while IFS= read -r member; do
            [[ -n "$member" && "$sess" == "$member" ]] && return 0
        done < "$gf"
    done < <(_swarm_names)
    return 1
}

_pretty_sessions() {
    local lines
    lines=$("$TMUX_BIN" list-sessions -F '#{session_name}	#{session_windows}	#{session_created}	#{session_attached}' 2>/dev/null) || true
    echo ""
    local count=0
    while IFS=$'\t' read -r name windows created attached; do
        [[ -n "$name" ]] || continue
        _is_swarm_session "$name" && continue
        local att_str="${dim}[空闲]${reset}"
        [[ "$attached" == "1" ]] && att_str="${green}[已连接]${reset}"
        local time_str
        time_str=$(date -d "@${created}" '+%m-%d %H:%M' 2>/dev/null || date -r "${created}" '+%m-%d %H:%M' 2>/dev/null || echo "${created}")
        echo -e "   ${icon_session} ${bold}${name}${reset}  ${dim}${windows} 个窗口  ${time_str}${reset}  ${att_str}"
        ((count++)) || true
    done <<< "$lines"
    if [[ "$count" -eq 0 ]]; then
        msg_info "没有活跃会话"
        return
    fi
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
        [[ -n "$name" ]] || continue
        _is_swarm_session "$name" && continue
        [[ "$first" == true ]] || echo ","
        first=false
        printf '  {"name":"%s","windows":%s,"created":"%s","attached":%s}' \
            "$name" "$windows" "$created" "$attached"
    done < <("$TMUX_BIN" list-sessions -F '#{session_name}	#{session_windows}	#{session_created}	#{session_attached}' 2>/dev/null)
    echo ""
    echo "]"
}
