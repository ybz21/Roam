# ══════════════════════════════════════════
# ── Task Group 管理 ──
# ══════════════════════════════════════════

_group_file() {
    echo "${TTMUX_GROUPS}/${1}.group"
}

_group_exists() {
    [[ -f "$(_group_file "$1")" ]]
}

_group_sessions() {
    local gf
    gf=$(_group_file "$1")
    [[ -f "$gf" ]] && cat "$gf" || true
}

_group_add_session() {
    local group="$1" session="$2"
    echo "$session" >> "$(_group_file "$group")"
}

# ── 任务元数据 (统一 cmd / agent) ──
# 每个任务 session 一份元数据，记录类型与描述，
# 使 status / collect / kill 对命令任务和 Agent 任务走同一条路径。

_task_meta_dir() {
    echo "${TTMUX_META}/${1}"
}

# $1 sess  $2 type(cmd|agent)  $3 desc(命令或任务)  $4 workdir
_task_write_meta() {
    local dir
    dir=$(_task_meta_dir "$1")
    mkdir -p "$dir"
    echo "$2" > "${dir}/type.txt"
    printf '%s\n' "$3" > "${dir}/desc.txt"
    printf '%s\n' "$4" > "${dir}/workdir.txt"
    date '+%Y-%m-%d %H:%M:%S' > "${dir}/started.txt"
}

_task_type() {
    local f
    f="$(_task_meta_dir "$1")/type.txt"
    if [[ -f "$f" ]]; then head -1 "$f"; else echo "cmd"; fi
}

_task_desc() {
    local f
    f="$(_task_meta_dir "$1")/desc.txt"
    if [[ -f "$f" ]]; then cat "$f"; return 0; fi
    # 向后兼容旧版 agent 元数据
    f="${TTMUX_DATA}/agents/${1}/task.txt"
    if [[ -f "$f" ]]; then cat "$f"; return 0; fi
    return 0
}

_task_clean_meta() {
    rm -rf "$(_task_meta_dir "$1")" "${TTMUX_DATA}/agents/${1}" 2>/dev/null || true
}

_group_list() {
    local groups=()
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        local name
        name=$(basename "$f" .group)
        groups+=("$name")
    done
    if [[ ${#groups[@]} -eq 0 ]]; then
        msg_info "没有任务组"
        return
    fi
    echo ""
    for g in "${groups[@]}"; do
        local total=0 alive=0 dead=0
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            ((total++)) || true
            if _session_exists "$sess"; then
                ((alive++)) || true
            else
                ((dead++)) || true
            fi
        done < <(_group_sessions "$g")
        local status_str
        if [[ $alive -eq 0 && $total -gt 0 ]]; then
            status_str="${green}全部完成${reset}"
        elif [[ $alive -eq $total ]]; then
            status_str="${yellow}运行中${reset}"
        else
            status_str="${cyan}${alive}/${total} 运行中${reset}"
        fi
        echo -e "   ${icon_group} ${bold}${g}${reset}  ${dim}${total} 个任务${reset}  ${status_str}"
    done
    echo ""
}

_group_list_json() {
    echo -n '['
    local first=true
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        local name total=0 alive=0
        name=$(basename "$f" .group)
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            ((total++)) || true
            _session_exists "$sess" && ((alive++)) || true
        done < <(_group_sessions "$name")
        local st="done"
        if [[ $alive -eq $total && $total -gt 0 ]]; then
            st="running"
        elif [[ $alive -gt 0 ]]; then
            st="partial"
        fi
        [[ "$first" == true ]] || echo -n ','
        first=false
        printf '{"group":"%s","total":%d,"alive":%d,"status":"%s"}' "$name" "$total" "$alive" "$st"
    done
    echo ']'
}

