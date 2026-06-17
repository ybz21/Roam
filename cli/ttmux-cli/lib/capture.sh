# ══════════════════════════════════════════
# ── capture: 捕获输出 ──
# ══════════════════════════════════════════

_do_capture() {
    local target="$1"
    local lines="${2:-200}"
    if _session_exists "$target"; then
        "$TMUX_BIN" capture-pane -t "$target" -p -S "-${lines}"
    else
        # 回退到日志文件
        local logfile="${TTMUX_LOGS}/${target}.log"
        if [[ -f "$logfile" ]]; then
            tail -n "$lines" "$logfile"
        else
            msg_err "会话不存在且无日志: ${target}"
            return 1
        fi
    fi
}

