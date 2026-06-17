# ══════════════════════════════════════════
# ── wait: 等待任务完成 ──
# ══════════════════════════════════════════

_do_wait_session() {
    local sess="$1"
    local timeout="${2:-300}"
    local elapsed=0
    while (( elapsed < timeout )); do
        if ! _session_exists "$sess"; then
            return 0
        fi
        local dead
        dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo "1")
        if [[ "$dead" == "1" ]]; then
            return 0
        fi
        sleep 1
        ((elapsed++))
    done
    msg_warn "等待超时 (${timeout}s): ${sess}"
    return 1
}

_do_wait_group() {
    local group="$1"
    local timeout="${2:-300}"
    if ! _group_exists "$group"; then
        msg_err "任务组不存在: ${group}"
        return 1
    fi
    msg_info "等待任务组 ${bold}${group}${reset} 完成... ${dim}(超时 ${timeout}s)${reset}"
    local all_done=true
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        if ! _do_wait_session "$sess" "$timeout"; then
            all_done=false
        fi
    done < <(_group_sessions "$group")
    if [[ "$all_done" == true ]]; then
        msg_ok "任务组 ${bold}${group}${reset} 全部完成"
    else
        msg_warn "任务组 ${bold}${group}${reset} 部分超时"
    fi
}

