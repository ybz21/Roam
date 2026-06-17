# ══════════════════════════════════════════
# ── 交互模式 ──
# ══════════════════════════════════════════

_clear_line() { printf '\033[2K\r'; }

_interactive_header() {
    clear
    echo ""
    echo -e "  ${bold}ttmux${reset} ${dim}v${TTMUX_VERSION}${reset}  ${dim}— 交互模式 (q 退出)${reset}"
    echo -e "  ${dim}$(printf '─%.0s' {1..44})${reset}"
    # 快速概览
    local sess_count=0 group_count=0
    sess_count=$("$TMUX_BIN" list-sessions 2>/dev/null | wc -l || echo 0)
    shopt -s nullglob
    local gfiles=("${TTMUX_GROUPS}"/*.group)
    group_count=${#gfiles[@]}
    local sdirs=("${TTMUX_SWARMS}"/*/)
    local swarm_count=${#sdirs[@]}
    echo -e "  ${dim}会话: ${reset}${bold}${sess_count}${reset}${dim}  任务组: ${reset}${bold}${group_count}${reset}${dim}  蜂群: ${reset}${bold}${swarm_count}${reset}"
    echo ""
}

_interactive_menu() {
    echo -e "  ${bold}会话${reset}"
    echo -e "    ${cyan}1${reset}) 列出会话          ${cyan}2${reset}) 新建会话"
    echo -e "    ${cyan}3${reset}) 附加会话          ${cyan}4${reset}) 关闭会话"
    echo ""
    echo -e "  ${bold}任务编排 ${magenta}(蜂群 / swarm)${reset}"
    echo -e "    ${cyan}5${reset}) 蜂群编排 ▸        ${cyan}6${reset}) 状态总览"
    echo -e "    ${cyan}7${reset}) 等待并收集        ${cyan}8${reset}) 追加指令"
    echo -e "    ${cyan}9${reset}) 清理任务组"
    echo ""
    echo -e "  ${bold}其他${reset}"
    echo -e "    ${cyan}s${reset}) 发送命令          ${cyan}h${reset}) 帮助"
    echo ""
}

_interactive_pause() {
    echo ""
    read -r -p "  按回车继续..." _ </dev/tty
}

# 创建任务：先选类型（命令 / Agent），再分流
_interactive_create() {
    read -r -p "  任务组名称: " group_name </dev/tty
    [[ -n "$group_name" ]] || return
    echo ""
    echo -e "  ${bold}任务类型:${reset}  ${cyan}1${reset}) shell 命令   ${cyan}2${reset}) Claude Agent"
    read -r -p "  选择 [1]: " ttype </dev/tty
    case "${ttype:-1}" in
        2) _interactive_agent_spawn "$group_name" ;;
        *) _interactive_cmd_spawn "$group_name" ;;
    esac
}

_interactive_cmd_spawn() {
    local group_name="$1"
    local tasks=()
    echo -e "  ${dim}逐个输入任务 (名称 + 命令), 空名称结束${reset}"
    while true; do
        echo ""
        read -r -p "  任务名称 (空=结束): " tname </dev/tty
        [[ -n "$tname" ]] || break
        read -r -p "  命令: " tcmd </dev/tty
        [[ -n "$tcmd" ]] || continue
        tasks+=("$tname" "$tcmd")
    done

    if [[ ${#tasks[@]} -lt 2 ]]; then
        msg_warn "未添加任何任务"
        return
    fi
    echo ""
    _do_spawn "$group_name" "${tasks[@]}"
}

_interactive_wait_collect() {
    local groups=()
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        groups+=("$(basename "$f" .group)")
    done

    if [[ ${#groups[@]} -eq 0 ]]; then
        msg_info "没有任务组"
        return
    fi

    echo ""
    echo -e "  ${bold}选择任务组:${reset}"
    local i=1
    for g in "${groups[@]}"; do
        echo -e "    ${cyan}${i}${reset}) ${g}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  编号: " choice </dev/tty
    local target=""
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#groups[@]} )); then
        target="${groups[$((choice-1))]}"
    else
        msg_err "无效选择"
        return
    fi

    echo ""
    _status "$target"

    echo -e "  ${bold}操作:${reset}"
    echo -e "    ${cyan}1${reset}) 等待完成  ${cyan}2${reset}) 收集输出  ${cyan}3${reset}) 两者都做  ${cyan}0${reset}) 返回"
    read -r -p "  选择: " action </dev/tty
    case "$action" in
        1)  _do_wait_group "$target" 300 ;;
        2)  echo ""; _collect "$target" "text" ;;
        3)  _do_wait_group "$target" 300; echo ""; _collect "$target" "text" ;;
        *)  return ;;
    esac
}

_interactive_group_kill() {
    local groups=()
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        groups+=("$(basename "$f" .group)")
    done

    if [[ ${#groups[@]} -eq 0 ]]; then
        msg_info "没有任务组"
        return
    fi

    echo ""
    echo -e "  ${bold}选择要清理的任务组:${reset}"
    echo -e "    ${cyan}0${reset}) ${red}全部清理${reset}"
    local i=1
    for g in "${groups[@]}"; do
        echo -e "    ${cyan}${i}${reset}) ${g}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  编号: " choice </dev/tty

    if [[ "$choice" == "0" ]]; then
        if _confirm "确定清理全部 ${#groups[@]} 个任务组?"; then
            for g in "${groups[@]}"; do
                _kill_group "$g"
            done
        fi
    elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#groups[@]} )); then
        local target="${groups[$((choice-1))]}"
        if _confirm "确定清理任务组 ${bold}${target}${reset}?"; then
            _kill_group "$target"
        fi
    fi
}

_interactive_group_status() {
    local groups=()
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        groups+=("$(basename "$f" .group)")
    done

    if [[ ${#groups[@]} -gt 0 ]]; then
        echo ""
        echo -e "  ${bold}任务组:${reset}"
        for g in "${groups[@]}"; do
            _status "$g"
        done
    fi
    _pretty_sessions
}

_pick_group() {
    local prompt="${1:-选择任务组}"
    local groups=()
    shopt -s nullglob
    for f in "${TTMUX_GROUPS}"/*.group; do
        groups+=("$(basename "$f" .group)")
    done
    if [[ ${#groups[@]} -eq 0 ]]; then
        msg_info "没有任务组"
        return 1
    fi
    if [[ ${#groups[@]} -eq 1 ]]; then
        echo "${groups[0]}"
        return 0
    fi
    echo "" >&2
    echo -e "  ${bold}${prompt}:${reset}" >&2
    local i=1
    for g in "${groups[@]}"; do
        echo -e "    ${cyan}${i}${reset}) ${g}" >&2
        ((i++)) || true
    done
    echo "" >&2
    read -r -p "  编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#groups[@]} )); then
        echo "${groups[$((choice-1))]}"
    else
        return 1
    fi
}

_interactive_agent_spawn() {
    local gname="$1"
    [[ -n "$gname" ]] || return
    read -r -p "  工作目录 [$(pwd)]: " wdir </dev/tty
    wdir="${wdir:-$(pwd)}"
    read -r -p "  权限模式 (auto/plan/default) [auto]: " perm </dev/tty
    perm="${perm:-auto}"
    read -r -p "  模型 (空=默认): " model </dev/tty

    local tasks=()
    echo ""
    echo -e "  ${dim}逐个输入 Agent (名称 + 任务描述), 空名称结束${reset}"
    while true; do
        echo ""
        read -r -p "  Agent 名称 (空=结束): " aname </dev/tty
        [[ -n "$aname" ]] || break
        read -r -p "  任务描述: " atask </dev/tty
        [[ -n "$atask" ]] || continue
        tasks+=("$aname" "$atask")
    done

    if [[ ${#tasks[@]} -lt 2 ]]; then
        msg_warn "未添加任何 Agent"
        return
    fi

    local opts=()
    opts+=("--dir" "$wdir" "--perm" "$perm")
    [[ -n "$model" ]] && opts+=("--model" "$model")

    echo ""
    _agent_spawn "$gname" "${tasks[@]}" "${opts[@]}"
}

# 追加指令：选任务组 → 选任务 session → 发送（命令任务与 Agent 通用）
_interactive_task_send() {
    local g
    g=$(_pick_group "选择任务组") || return
    echo ""
    echo -e "  ${bold}任务列表:${reset}"
    local agents=()
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        agents+=("$sess")
    done < <(_group_sessions "$g")
    local i=1
    for ag in "${agents[@]}"; do
        local running=""
        _session_exists "$ag" && running=" ${yellow}运行中${reset}" || running=" ${dim}已结束${reset}"
        echo -e "    ${cyan}${i}${reset}) ${ag}${running}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  选择任务编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#agents[@]} )); then
        local target="${agents[$((choice-1))]}"
        read -r -p "  追加指令: " msg </dev/tty
        [[ -n "$msg" ]] && _task_send "$target" "$msg"
    else
        msg_err "无效选择"
    fi
}

_interactive() {
    while true; do
        _interactive_header
        _interactive_menu
        read -r -p "  选择操作: " choice </dev/tty
        echo ""

        case "$choice" in
            1)  _pretty_sessions; _interactive_pause ;;
            2)
                read -r -p "  会话名称 (空=自动): " sname </dev/tty
                if [[ -n "$sname" ]]; then
                    if _session_exists "$sname"; then
                        msg_warn "会话 ${bold}${sname}${reset} 已存在，正在附加..."
                        "$TMUX_BIN" attach-session -t "$sname"
                    else
                        msg_info "创建会话 ${bold}${sname}${reset}"
                        _set_global_env
                        "$TMUX_BIN" new-session -s "$sname"
                    fi
                else
                    _set_global_env
                    "$TMUX_BIN" new-session
                fi
                ;;
            3)
                target=$(_pick_session "附加到会话") || { _interactive_pause; continue; }
                msg_info "附加到 ${bold}${target}${reset}"
                "$TMUX_BIN" attach-session -t "$target"
                ;;
            4)
                target=$(_pick_session "关闭会话") || { _interactive_pause; continue; }
                if _confirm "确定关闭会话 ${bold}${target}${reset}?"; then
                    "$TMUX_BIN" kill-session -t "$target"
                    msg_ok "会话 ${bold}${target}${reset} 已关闭"
                fi
                _interactive_pause
                ;;
            5)  _interactive_swarm ;;
            6)  _interactive_group_status; _interactive_pause ;;
            7)  _interactive_wait_collect; _interactive_pause ;;
            8)  _interactive_task_send; _interactive_pause ;;
            9)  _interactive_group_kill; _interactive_pause ;;
            s)
                target=$(_pick_session "发送命令到") || { _interactive_pause; continue; }
                read -r -p "  命令: " icmd </dev/tty
                if [[ -n "$icmd" ]]; then
                    "$TMUX_BIN" send-keys -t "$target" "$icmd" C-m
                    msg_ok "已发送到 ${bold}${target}${reset}: ${dim}${icmd}${reset}"
                fi
                _interactive_pause
                ;;
            h)  show_help; _interactive_pause ;;
            q|0|"")  echo -e "  ${dim}bye${reset}"; echo ""; break ;;
            *)  msg_warn "无效选择"; _interactive_pause ;;
        esac
    done
}

