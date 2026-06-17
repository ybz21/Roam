_info_json() {
    local sess_count group_count tmux_ver
    sess_count=$(_session_count | tr -d '[:space:]')
    shopt -s nullglob
    local gf=("${TTMUX_GROUPS}"/*.group)
    group_count=${#gf[@]}
    tmux_ver=$("$TMUX_BIN" -V 2>/dev/null | awk '{print $2}')
    printf '{"version":"%s","tmux_version":"%s","data_dir":"%s","sessions":%s,"groups":%d}\n' \
        "$TTMUX_VERSION" "$tmux_ver" "$TTMUX_DATA" "${sess_count:-0}" "$group_count"
}

# 统一状态：命令任务与 Agent 任务同一渲染路径，Agent 行额外标注类型与任务摘要
_status() {
    local group="$1"
    if ! _group_exists "$group"; then
        msg_err "任务组 ${bold}${group}${reset} 不存在"
        return 1
    fi
    echo ""
    echo -e "  ${icon_group} ${bold}${group}${reset} 状态"
    echo -e "  ${dim}$(printf '─%.0s' {1..50})${reset}"
    echo ""
    local running=0 n_done=0 failed=0 total=0
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        ((total++)) || true
        local type desc tag
        type=$(_task_type "$sess")
        desc=$(_task_desc "$sess")
        desc="${desc%%$'\n'*}"   # 仅取首行，避免 pipefail 下的 SIGPIPE
        desc="${desc:0:50}"
        if [[ "$type" == "agent" ]]; then tag="${magenta}[agent]${reset}"; else tag="${dim}[cmd]${reset}"; fi
        if _session_exists "$sess"; then
            local proc dead
            proc=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_current_command}' 2>/dev/null || echo "?")
            dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo "0")
            if [[ "$dead" == "1" ]]; then
                local exit_code
                exit_code=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead_status}' 2>/dev/null || echo "?")
                if [[ "$exit_code" == "0" ]]; then
                    echo -e "  ${green}${icon_ok}${reset} ${bold}${sess}${reset} ${tag} ${green}完成${reset} (exit 0)"
                    ((n_done++)) || true
                else
                    echo -e "  ${red}${icon_err}${reset} ${bold}${sess}${reset} ${tag} ${red}失败${reset} (exit ${exit_code})"
                    ((failed++)) || true
                fi
            else
                echo -e "  ${yellow}${icon_run}${reset} ${bold}${sess}${reset} ${tag} ${yellow}运行中${reset}  ${dim}[${proc}]${reset}"
                ((running++)) || true
            fi
        else
            local logfile="${TTMUX_LOGS}/${sess}.log"
            if [[ -f "$logfile" ]]; then
                echo -e "  ${green}${icon_done}${reset} ${bold}${sess}${reset} ${tag} ${dim}已结束 (日志可用)${reset}"
            else
                echo -e "  ${dim}${icon_done}${reset} ${bold}${sess}${reset} ${tag} ${dim}已结束${reset}"
            fi
            ((n_done++)) || true
        fi
        [[ -n "$desc" ]] && echo -e "     ${dim}↳ ${desc}${reset}"
    done < <(_group_sessions "$group")
    echo ""
    echo -e "  ${dim}共 ${total} 个任务:  ${green}完成 ${n_done}${reset}  ${yellow}运行 ${running}${reset}  ${red}失败 ${failed}${reset}"
    echo ""
}

_status_json() {
    local group="$1"
    if ! _group_exists "$group"; then
        echo '{"error":"group not found"}'
        return 1
    fi
    echo '{"group":"'"$group"'","tasks":['
    local first=true
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        [[ "$first" == true ]] || echo ","
        first=false
        local status="exited" proc="" exit_code="" type desc_json
        type=$(_task_type "$sess")
        desc_json=$(_task_desc "$sess" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')
        if _session_exists "$sess"; then
            proc=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_current_command}' 2>/dev/null || echo "")
            local dead
            dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo "0")
            if [[ "$dead" == "1" ]]; then
                exit_code=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead_status}' 2>/dev/null || echo "")
                status="done"
            else
                status="running"
            fi
        fi
        printf '  {"name":"%s","type":"%s","status":"%s","process":"%s","exit_code":"%s","task":%s}' \
            "$sess" "$type" "$status" "$proc" "$exit_code" "$desc_json"
    done < <(_group_sessions "$group")
    echo ""
    echo ']}'
}

