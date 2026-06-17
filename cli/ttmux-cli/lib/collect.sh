# ══════════════════════════════════════════
# ── collect: 收集输出 ──
# ══════════════════════════════════════════

# 统一收集：命令任务与 Agent 任务同一路径，优先读日志，带任务描述
_collect() {
    local group="$1"
    local format="${2:-text}"
    if ! _group_exists "$group"; then
        msg_err "任务组不存在: ${group}"
        return 1
    fi

    if [[ "$format" == "json" ]]; then
        echo '{"group":"'"$group"'","results":['
        local first=true
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            [[ "$first" == true ]] || echo ","
            first=false
            local type task_json output
            type=$(_task_type "$sess")
            task_json=$(_task_desc "$sess" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
            local logfile="${TTMUX_LOGS}/${sess}.log"
            if [[ -f "$logfile" ]]; then
                output=$(tail -200 "$logfile" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
            else
                output=$(_do_capture "$sess" 200 2>/dev/null | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
            fi
            printf '  {"task":"%s","type":"%s","prompt":%s,"output":%s}' "$sess" "$type" "$task_json" "$output"
        done < <(_group_sessions "$group")
        echo ""
        echo ']}'
    else
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            local desc
            desc=$(_task_desc "$sess")
            echo ""
            echo -e "  ${bold}━━━ ${sess} ━━━${reset}"
            [[ -n "$desc" ]] && echo -e "  ${dim}任务: ${desc}${reset}"
            echo -e "  ${dim}$(printf '─%.0s' {1..50})${reset}"
            local logfile="${TTMUX_LOGS}/${sess}.log"
            if [[ -f "$logfile" ]] && [[ -s "$logfile" ]]; then
                tail -50 "$logfile"
            else
                _do_capture "$sess" 50 2>/dev/null || echo "  (无输出)"
            fi
        done < <(_group_sessions "$group")
        echo ""
    fi
}

