# ══════════════════════════════════════════
# ── 主入口 ──
# ══════════════════════════════════════════

if [[ $# -eq 0 ]]; then
    _interactive
    exit 0
fi

cmd="$1"
shift

case "$cmd" in
    -h|--help|help)
        show_help
        ;;
    -i|--interactive)
        _interactive
        ;;
    -v|--version)
        echo "ttmux v${TTMUX_VERSION}"
        ;;

    # ── 会话管理 ──
    ls)
        if [[ "${1:-}" == "--json" ]]; then
            _json_sessions
        else
            _pretty_sessions
        fi
        ;;
    new)
        if [[ $# -ge 1 ]]; then
            name="$1"
            if _session_exists "$name"; then
                msg_warn "会话 ${bold}${name}${reset} 已存在，正在附加..."
                "$TMUX_BIN" attach-session -t "$name"
            else
                msg_info "创建会话 ${bold}${name}${reset}"
                _set_global_env
                "$TMUX_BIN" new-session -s "$name" "${@:2}"
            fi
        else
            _set_global_env
            "$TMUX_BIN" new-session
        fi
        ;;
    a|attach)
        if [[ $# -ge 1 ]]; then
            target="$1"
        else
            target=$(_pick_session "附加到会话") || exit 1
        fi
        if _session_exists "$target"; then
            msg_info "附加到 ${bold}${target}${reset}"
            "$TMUX_BIN" attach-session -t "$target"
        else
            msg_err "会话 ${bold}${target}${reset} 不存在"
            echo ""
            echo -e "   可用会话:"
            _sessions | sed 's/^/     /'
            exit 1
        fi
        ;;
    d|detach)
        "$TMUX_BIN" detach-client "$@"
        msg_ok "已分离"
        ;;
    kill)
        if [[ $# -ge 1 ]]; then
            target="$1"
        else
            target=$(_pick_session "关闭会话") || exit 1
        fi
        if _session_exists "$target"; then
            if _confirm "确定关闭会话 ${bold}${target}${reset}?"; then
                "$TMUX_BIN" kill-session -t "$target"
                msg_ok "会话 ${bold}${target}${reset} 已关闭"
            else
                msg_info "已取消"
            fi
        else
            msg_err "会话 ${bold}${target}${reset} 不存在"
            exit 1
        fi
        ;;
    killall)
        local_count=$(_session_count)
        if [[ "$local_count" -eq 0 ]]; then
            msg_info "没有活跃会话"
            exit 0
        fi
        if _confirm "确定关闭全部 ${local_count} 个会话?"; then
            "$TMUX_BIN" kill-server
            msg_ok "所有会话已关闭"
        else
            msg_info "已取消"
        fi
        ;;
    rename)
        if [[ $# -lt 2 ]]; then
            if [[ $# -eq 0 ]]; then
                old=$(_pick_session "重命名会话") || exit 1
            else
                old="$1"
            fi
            read -r -p "   新名称: " new </dev/tty
            if [[ -z "$new" ]]; then
                msg_err "名称不能为空"
                exit 1
            fi
        else
            old="$1"
            new="$2"
        fi
        "$TMUX_BIN" rename-session -t "$old" "$new"
        msg_ok "${bold}${old}${reset} → ${bold}${new}${reset}"
        ;;

    # ── 任务编排 ──
    spawn)
        # 命令任务与 Agent 任务统一入口；--agent 走 Claude，默认走 shell 命令
        if [[ "${1:-}" == "--agent" ]]; then
            shift
            if [[ "${1:-}" == "--file" ]]; then
                shift
                if [[ $# -lt 2 ]]; then
                    msg_err "用法: ttmux spawn --agent --file <组名> <文件> [选项]"
                    exit 1
                fi
                _agent_spawn_file "$@"
            else
                if [[ $# -lt 3 ]]; then
                    msg_err "用法: ttmux spawn --agent <组名> <名称> <任务> [<名称> <任务> ...] [选项]"
                    exit 1
                fi
                _agent_spawn "$@"
            fi
        elif [[ "${1:-}" == "--file" ]]; then
            shift
            if [[ $# -lt 2 ]]; then
                msg_err "用法: ttmux spawn --file <组名> <文件>"
                exit 1
            fi
            _do_spawn_file "$1" "$2"
        else
            if [[ $# -lt 3 ]]; then
                msg_err "用法: ttmux spawn <组名> <任务名> <命令> [<任务名> <命令> ...]"
                exit 1
            fi
            _do_spawn "$@"
        fi
        ;;
    group)
        subcmd="${1:-ls}"
        shift || true
        case "$subcmd" in
            ls|list)
                if [[ "${1:-}" == "--json" ]]; then
                    _group_list_json
                else
                    _group_list
                fi
                ;;
            status)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux group status <组名>"
                    exit 1
                fi
                if [[ "${2:-}" == "--json" ]]; then
                    _status_json "$1"
                else
                    _status "$1"
                fi
                ;;
            kill)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux group kill <组名>"
                    exit 1
                fi
                _kill_group "$1"
                ;;
            *)
                msg_err "未知子命令: group ${subcmd}"
                echo -e "   可用: ls, status, kill"
                exit 1
                ;;
        esac
        ;;
    status)
        if [[ $# -lt 1 ]]; then
            _pretty_sessions
            echo ""
            _group_list
        elif [[ "${2:-}" == "--json" ]]; then
            _status_json "$1"
        else
            _status "$1"
        fi
        ;;
    wait)
        timeout=300
        group=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --timeout) timeout="$2"; shift 2 ;;
                *) group="$1"; shift ;;
            esac
        done
        if [[ -z "$group" ]]; then
            msg_err "用法: ttmux wait <组名> [--timeout N]"
            exit 1
        fi
        _do_wait_group "$group" "$timeout"
        ;;
    capture)
        if [[ $# -lt 1 ]]; then
            msg_err "用法: ttmux capture <会话名> [--lines N]"
            exit 1
        fi
        target="$1"; shift
        lines=200
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --lines|-n) lines="$2"; shift 2 ;;
                *) shift ;;
            esac
        done
        _do_capture "$target" "$lines"
        ;;
    collect)
        if [[ $# -lt 1 ]]; then
            msg_err "用法: ttmux collect <组名> [--json]"
            exit 1
        fi
        group="$1"; shift
        fmt="text"
        [[ "${1:-}" == "--json" ]] && fmt="json"
        _collect "$group" "$fmt"
        ;;

    # ── 蜂群编排 (swarm) ──
    swarm)
        subcmd="${1:-ls}"
        shift || true
        case "$subcmd" in
            new|create)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux swarm new <名> [--goal \"...\"]"
                    exit 1
                fi
                _swarm_new "$@"
                ;;
            add)
                if [[ $# -lt 2 ]]; then
                    msg_err "用法: ttmux swarm add <群> <成员> [--type task|agent] <命令或任务>"
                    exit 1
                fi
                _swarm_add "$@"
                ;;
            ls|list)
                _swarm_ls "$@"
                ;;
            status)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux swarm status <群> [--json]"
                    exit 1
                fi
                _swarm_status "$@"
                ;;
            collect)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux swarm collect <群> [--json]"
                    exit 1
                fi
                local_swarm="$1"; shift
                fmt="text"
                [[ "${1:-}" == "--json" ]] && fmt="json"
                _swarm_collect "$local_swarm" "$fmt"
                ;;
            activate)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux swarm activate <群> [成员] [--force]"
                    exit 1
                fi
                _swarm_activate "$@"
                ;;
            adopt)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux swarm adopt <群> [--by <cc会话>]"
                    exit 1
                fi
                _swarm_adopt "$@"
                ;;
            done)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm done <群> [成员]"; exit 1; }
                _swarm_done "$1" "${2:-}"
                ;;
            sql)
                [[ $# -ge 1 ]] || { msg_err '用法: ttmux swarm sql <群> [--json] "SELECT ..."'; exit 1; }
                _swarm_sql "$@"
                ;;
            say)
                [[ $# -ge 2 ]] || { msg_err '用法: ttmux swarm say <群> [--as 成员] [--kind 类型] <消息>'; exit 1; }
                _plaza_say "$@"
                ;;
            feed)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm feed <群> [-n N] [--from 成员] [--kind 类型] [--since id] [--json]"; exit 1; }
                _plaza_feed "$@"
                ;;
            watch)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm watch <群>"; exit 1; }
                _plaza_watch "$@"
                ;;
            board)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm board <群> [--json]"; exit 1; }
                _board_render "$@"
                ;;
            task)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm task <add|ls|show|assign|move|done|rm> <群> ..."; exit 1; }
                _board_task "$@"
                ;;
            archive)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm archive <群>"; exit 1; }
                _swarm_archive "$1"
                ;;
            rm|delete)
                [[ $# -ge 1 ]] || { msg_err "用法: ttmux swarm rm <群>"; exit 1; }
                _swarm_rm "$1"
                ;;
            *)
                msg_err "未知子命令: swarm ${subcmd}"
                echo -e "   可用: new, add, ls, status, activate, collect, adopt, done, say, feed, watch, board, task, sql, archive, rm"
                exit 1
                ;;
        esac
        ;;

    # ── 窗口 / 窗格 ──
    nw)
        if [[ $# -ge 1 ]]; then
            "$TMUX_BIN" new-window -n "$1"
            msg_ok "新窗口 ${bold}$1${reset}"
        else
            "$TMUX_BIN" new-window
            msg_ok "新窗口已创建"
        fi
        ;;
    lw)
        echo ""
        local wlines
        wlines=$("$TMUX_BIN" list-windows -F '#{window_index}	#{window_name}	#{window_active}' "$@" 2>/dev/null) || { msg_err "无法列出窗口"; }
        if [[ -n "${wlines:-}" ]]; then
            while IFS=$'\t' read -r widx wname wactive; do
                local act_str=""
                [[ "$wactive" == "1" ]] && act_str=" ${green}[活跃]${reset}"
                echo -e "   ${icon_window} ${bold}${widx}${reset}  ${wname}${act_str}"
            done <<< "$wlines"
        fi
        echo ""
        ;;
    kw)
        if [[ $# -ge 1 ]]; then
            "$TMUX_BIN" kill-window -t "$1"
        else
            "$TMUX_BIN" kill-window
        fi
        msg_ok "窗口已关闭"
        ;;
    sp|split)
        if [[ "${1:-}" == "-h" ]]; then
            "$TMUX_BIN" split-window -h "${@:2}"
            msg_ok "水平分割"
        else
            "$TMUX_BIN" split-window -v "$@"
            msg_ok "垂直分割"
        fi
        ;;
    kp)
        "$TMUX_BIN" kill-pane "$@"
        msg_ok "窗格已关闭"
        ;;

    # ── 全局环境变量 ──
    env)
        subcmd="${1:-list}"
        shift || true
        case "$subcmd" in
            ls|list)
                if [[ "${1:-}" == "--json" ]]; then _env_list_json; else _env_list; fi
                ;;
            --json)
                _env_list_json
                ;;
            set)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux env set KEY=VALUE"
                    exit 1
                fi
                _env_set "$1"
                ;;
            rm|del|delete)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux env rm KEY"
                    exit 1
                fi
                _env_rm "$1"
                ;;
            clear)
                _env_clear
                ;;
            push)
                _env_push
                ;;
            *)
                # ttmux env KEY=VALUE 简写
                if [[ "$subcmd" == *"="* ]]; then
                    _env_set "$subcmd"
                else
                    msg_err "未知子命令: env ${subcmd}"
                    echo -e "   可用: set, rm, clear, push, list"
                    exit 1
                fi
                ;;
        esac
        ;;

    # ── 其他 ──
    send)
        if [[ $# -lt 1 ]]; then
            msg_err "用法: ttmux send [会话名] <命令>"
            exit 1
        fi
        if [[ $# -eq 1 ]]; then
            target=$(_pick_session "发送命令到") || exit 1
            cmd_str="$1"
        else
            target="$1"
            shift
            cmd_str="$*"
        fi
        if _session_exists "$target"; then
            "$TMUX_BIN" send-keys -t "$target" "$cmd_str" C-m
            msg_ok "已发送到 ${bold}${target}${reset}: ${dim}${cmd_str}${reset}"
        else
            msg_err "会话 ${bold}${target}${reset} 不存在"
            exit 1
        fi
        ;;
    info)
        if [[ "${1:-}" == "--json" ]]; then
            _info_json
        else
            "$TMUX_BIN" info
        fi
        ;;
    source)
        if [[ -f ~/.tmux.conf ]]; then
            "$TMUX_BIN" source-file ~/.tmux.conf
            msg_ok "配置已重载"
        else
            msg_err "未找到 ~/.tmux.conf"
        fi
        ;;
    completion)
        _install_completion
        ;;

    # ── 多 Agent 编排（向后兼容别名，底层与任务编排统一） ──
    agent)
        subcmd="${1:-help}"
        shift || true
        case "$subcmd" in
            spawn)
                if [[ "${1:-}" == "--file" ]]; then
                    shift
                    if [[ $# -lt 2 ]]; then
                        msg_err "用法: ttmux agent spawn --file <组名> <文件> [选项]"
                        exit 1
                    fi
                    _agent_spawn_file "$@"
                else
                    if [[ $# -lt 3 ]]; then
                        msg_err "用法: ttmux agent spawn <组名> <名称> <任务> [<名称> <任务> ...] [选项]"
                        exit 1
                    fi
                    _agent_spawn "$@"
                fi
                ;;
            status)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux agent status <组名>"
                    exit 1
                fi
                if [[ "${2:-}" == "--json" ]]; then
                    _status_json "$1"
                else
                    _status "$1"
                fi
                ;;
            send)
                if [[ $# -lt 2 ]]; then
                    msg_err "用法: ttmux agent send <会话名> <指令>"
                    exit 1
                fi
                _task_send "$@"
                ;;
            collect)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux agent collect <组名> [--json]"
                    exit 1
                fi
                local_group="$1"; shift
                fmt="text"
                [[ "${1:-}" == "--json" ]] && fmt="json"
                _collect "$local_group" "$fmt"
                ;;
            kill)
                if [[ $# -lt 1 ]]; then
                    msg_err "用法: ttmux agent kill <组名>"
                    exit 1
                fi
                _kill_group "$1"
                ;;
            *)
                msg_err "未知子命令: agent ${subcmd}"
                echo -e "   可用: spawn, status, send, collect, kill"
                exit 1
                ;;
        esac
        ;;

    *)
        "$TMUX_BIN" "$cmd" "$@"
        ;;
esac
