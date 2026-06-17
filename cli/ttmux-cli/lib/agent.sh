# ══════════════════════════════════════════
# ── agent: 多 Claude 编排 ──
# ══════════════════════════════════════════

TTMUX_AGENT_MARKER=".ttmux-agent"  # 标记文件，放在 session 数据里

_agent_defaults() {
    AGENT_CLAUDE_BIN="${AGENT_CLAUDE_BIN:-$(command -v claude)}"
    AGENT_PERMISSION="${AGENT_PERMISSION:-dangerously-skip-permissions}"
    AGENT_MODEL="${AGENT_MODEL:-}"
    AGENT_WORKDIR="${AGENT_WORKDIR:-$(pwd)}"
    AGENT_MAX_TURNS="${AGENT_MAX_TURNS:-}"
}

# 构建 claude 启动命令
_agent_claude_cmd() {
    local task="$1"
    _agent_defaults
    local cmd="cd '${AGENT_WORKDIR}' && ${AGENT_CLAUDE_BIN} -p"
    [[ -n "$AGENT_MODEL" ]] && cmd+=" --model ${AGENT_MODEL}"
    if [[ "$AGENT_PERMISSION" == "dangerously-skip-permissions" ]]; then
        cmd+=" --dangerously-skip-permissions"
    else
        cmd+=" --permission-mode ${AGENT_PERMISSION}"
    fi
    [[ -n "$AGENT_MAX_TURNS" ]] && cmd+=" --max-turns ${AGENT_MAX_TURNS}"
    cmd+=" --output-format text"
    # 使用 heredoc 传入任务，避免引号转义问题
    cmd+=" <<'TTMUX_TASK_EOF'
${task}
TTMUX_TASK_EOF"
    echo "$cmd"
}

# 启动一组 agent
_agent_spawn() {
    local group="$1"
    shift
    _agent_defaults

    if _group_exists "$group"; then
        msg_warn "Agent 组 ${bold}${group}${reset} 已存在"
        return 1
    fi

    # 解析选项
    local workdir="$AGENT_WORKDIR"
    local model="$AGENT_MODEL"
    local permission="$AGENT_PERMISSION"
    local max_turns="$AGENT_MAX_TURNS"
    local pairs=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir)       workdir="$2"; shift 2 ;;
            --model)     model="$2"; shift 2 ;;
            --perm)      permission="$2"; shift 2 ;;
            --max-turns) max_turns="$2"; shift 2 ;;
            *)           pairs+=("$1"); shift ;;
        esac
    done

    if [[ ${#pairs[@]} -lt 2 ]]; then
        msg_err "用法: ttmux agent spawn <组名> <名称> <任务> [<名称> <任务> ...] [选项]"
        return 1
    fi

    # 导出给 _agent_claude_cmd / _spawn_one 使用
    AGENT_WORKDIR="$workdir"
    AGENT_MODEL="$model"
    AGENT_PERMISSION="$permission"
    AGENT_MAX_TURNS="$max_turns"

    local count=0
    local i=0
    while (( i < ${#pairs[@]} - 1 )); do
        local name="${pairs[$i]}"
        local task="${pairs[$((i+1))]}"
        i=$((i+2))
        if _spawn_one "$group" "$name" "agent" "$task" "$workdir"; then
            ((count++)) || true
            local suffix=""
            (( ${#task} > 60 )) && suffix="..." || true
            msg_ok "Agent ${bold}${name}${reset}: ${dim}${task:0:60}${suffix}${reset}"
        fi
    done

    echo ""
    msg_info "Agent 组 ${bold}${group}${reset} 已启动 ${count} 个 Claude 实例"
    msg_info "工作目录: ${dim}${workdir}${reset}"
    echo ""
    echo -e "  ${dim}查看状态:  ttmux status ${group}${reset}"
    echo -e "  ${dim}附加查看:  ttmux a ${group}-<名称>${reset}"
    echo -e "  ${dim}追加指令:  ttmux send ${group}-<名称> \"补充指令\"${reset}"
}

# 向运行中的任务/agent 追加指令（对任意 session 通用）
_task_send() {
    local sess="$1"
    shift
    local message="$*"

    if ! _session_exists "$sess"; then
        msg_err "会话 ${bold}${sess}${reset} 不存在或已结束"
        return 1
    fi

    # 检查 claude 是否还在运行
    local proc
    proc=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_current_command}' 2>/dev/null || echo "")

    # 发送文本 + 回车
    "$TMUX_BIN" send-keys -t "$sess" "$message" C-m
    msg_ok "已发送到 ${bold}${sess}${reset}: ${dim}${message:0:60}${reset}"
}

# 从文件批量创建 agent
_agent_spawn_file() {
    local group="$1" file="$2"
    shift 2
    if [[ ! -f "$file" ]]; then
        msg_err "文件不存在: ${file}"
        return 1
    fi
    local args=("$group")
    # 额外选项传递
    args+=("$@")
    while IFS= read -r line; do
        [[ -n "$line" && ! "$line" =~ ^# ]] || continue
        local name task
        name=$(echo "$line" | awk '{print $1}')
        task=$(echo "$line" | cut -d' ' -f2-)
        args+=("$name" "$task")
    done < "$file"
    _agent_spawn "${args[@]}"
}

# 统一清理任务组：Agent 任务先发 /exit 优雅退出，命令任务直接杀，最后清理元数据
_kill_group() {
    local group="$1"
    if ! _group_exists "$group"; then
        msg_err "任务组不存在: ${group}"
        return 1
    fi
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        if _session_exists "$sess"; then
            if [[ "$(_task_type "$sess")" == "agent" ]]; then
                # 先尝试优雅退出 claude（发 /exit）
                "$TMUX_BIN" send-keys -t "$sess" "/exit" C-m 2>/dev/null || true
                sleep 0.5
            fi
            if _session_exists "$sess"; then
                "$TMUX_BIN" kill-session -t "$sess" 2>/dev/null || true
            fi
        fi
        _task_clean_meta "$sess"
    done < <(_group_sessions "$group")
    rm -f "$(_group_file "$group")"
    msg_ok "任务组 ${bold}${group}${reset} 已清理"
}

