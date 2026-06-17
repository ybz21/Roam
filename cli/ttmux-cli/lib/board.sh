# ══════════════════════════════════════════
# ── board: 蜂群协作看板（任务卡片）──
# ══════════════════════════════════════════
#
# 全群共享的任务卡片，按列流转；存每群 swarms/<id>/swarm.db 的 cards 表。详见 README。
# 卡片 = 要做的事；成员 = 干活的会话(多对一)。只 master 派活(add/assign)，成员只推进自己的卡。
# 列: backlog(待办) assigned(已派) doing(进行) review(待审) done(完成) blocked(受阻)

_BOARD_COLS="backlog assigned doing review done blocked"
_board_col_label() {
    case "$1" in
        backlog) echo "待办" ;; assigned) echo "已派" ;; doing) echo "进行" ;;
        review)  echo "待审" ;; done)     echo "完成" ;; blocked)  echo "受阻" ;;
        *) echo "$1" ;;
    esac
}
_board_col_valid() { case " ${_BOARD_COLS} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

_board_card_exists() { [[ "$(sqlite3 "$1" "SELECT 1 FROM cards WHERE id='$(_sqe "$2")';")" == "1" ]]; }
# 下一个卡 id: t<N>，N 由现有卡 id 的最大数字 +1
_board_next_id() { sqlite3 "$1" "SELECT 't'||(COALESCE(MAX(CAST(SUBSTR(id,2) AS INTEGER)),0)+1) FROM cards;"; }
_board_card_col() { sqlite3 "$1" "SELECT IFNULL(col,'') FROM cards WHERE id='$(_sqe "$2")';"; }

# ttmux swarm task add <群> "<标题>" [--desc ..][--assignee 成员][--deps t1,t2][--col 列]
# 标题打到 stdout(供 t1=$(...) 捕获)，装饰信息打到 stderr。
_board_add() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local desc="" assignee="" deps="" col="" parts=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --desc)     desc="$2"; shift 2 ;;
            --assignee) assignee="$2"; shift 2 ;;
            --deps)     deps="$2"; shift 2 ;;
            --col)      col="$2"; shift 2 ;;
            *) parts+=("$1"); shift ;;
        esac
    done
    local title="${parts[*]}"
    [[ -n "$title" ]] || { msg_err "卡片标题不能为空"; return 1; }
    # 列默认：派了人 -> assigned，否则 backlog
    [[ -z "$col" ]] && { [[ -n "$assignee" ]] && col="assigned" || col="backlog"; }
    _board_col_valid "$col" || { msg_err "列只能是: ${_BOARD_COLS}"; return 1; }
    local db id; db=$(_swarm_db_of "$swarm") || return 1
    id=$(_board_next_id "$db")
    sqlite3 "$db" "INSERT INTO cards(id,title,descr,assignee,col,deps,created,updated)
        VALUES('$(_sqe "$id")','$(_sqe "$title")','$(_sqe "$desc")','$(_sqe "$assignee")','$(_sqe "$col")','$(_sqe "$deps")',
               datetime('now','localtime'),datetime('now','localtime'));"
    echo "$id"
    msg_ok "新卡 ${bold}${id}${reset}  ${title}  ${dim}[${col}]${reset}$([[ -n "$assignee" ]] && echo " ${cyan}→ ${assignee}${reset}")" >&2
}

# ttmux swarm task assign <群> <卡id> <成员>
_board_assign() {
    local swarm="$1" cid="$2" who="$3"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    [[ -n "$cid" && -n "$who" ]] || { msg_err "用法: ttmux swarm task assign <群> <卡id> <成员>"; return 1; }
    local db; db=$(_swarm_db_of "$swarm") || return 1
    _board_card_exists "$db" "$cid" || { msg_err "卡片不存在: ${cid}"; return 1; }
    sqlite3 "$db" "UPDATE cards SET assignee='$(_sqe "$who")',
        col=CASE WHEN col='backlog' THEN 'assigned' ELSE col END,
        updated=datetime('now','localtime') WHERE id='$(_sqe "$cid")';"
    msg_ok "${bold}${cid}${reset} ${cyan}→ ${who}${reset}  ${dim}[已派]${reset}"
}

# ttmux swarm task move <群> <卡id> <列>
_board_move() {
    local swarm="$1" cid="$2" col="$3"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    [[ -n "$cid" && -n "$col" ]] || { msg_err "用法: ttmux swarm task move <群> <卡id> <列>"; return 1; }
    _board_col_valid "$col" || { msg_err "列只能是: ${_BOARD_COLS}"; return 1; }
    local db; db=$(_swarm_db_of "$swarm") || return 1
    _board_card_exists "$db" "$cid" || { msg_err "卡片不存在: ${cid}"; return 1; }
    local old; old=$(_board_card_col "$db" "$cid")
    sqlite3 "$db" "UPDATE cards SET col='$(_sqe "$col")', updated=datetime('now','localtime') WHERE id='$(_sqe "$cid")';"
    msg_ok "${bold}${cid}${reset}  ${dim}[${old} → ${col}]${reset}"
}

_board_done() { _board_move "$1" "$2" done; }

# ttmux swarm task rm <群> <卡id>
_board_rm() {
    local swarm="$1" cid="$2"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    [[ -n "$cid" ]] || { msg_err "用法: ttmux swarm task rm <群> <卡id>"; return 1; }
    local db; db=$(_swarm_db_of "$swarm") || return 1
    _board_card_exists "$db" "$cid" || { msg_err "卡片不存在: ${cid}"; return 1; }
    sqlite3 "$db" "DELETE FROM cards WHERE id='$(_sqe "$cid")';"
    msg_ok "卡片 ${bold}${cid}${reset} 已删除"
}

# ttmux swarm task show <群> <卡id>
_board_show() {
    local swarm="$1" cid="$2"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    [[ -n "$cid" ]] || { msg_err "用法: ttmux swarm task show <群> <卡id>"; return 1; }
    local db; db=$(_swarm_db_of "$swarm") || return 1
    _board_card_exists "$db" "$cid" || { msg_err "卡片不存在: ${cid}"; return 1; }
    local row; row=$(sqlite3 -separator $'\x1f' "$db" \
        "SELECT id,title,IFNULL(descr,''),IFNULL(assignee,''),col,IFNULL(deps,''),created,updated FROM cards WHERE id='$(_sqe "$cid")';")
    local id title descr who col deps created updated
    IFS=$'\x1f' read -r id title descr who col deps created updated <<< "$row"
    echo ""
    echo -e "  ${yellow}${id}${reset}  ${bold}${title}${reset}  ${dim}[${col}]${reset}"
    [[ -n "$who" ]]     && echo -e "    ${dim}负责:${reset} ${cyan}${who}${reset}"
    [[ -n "$deps" ]]    && echo -e "    ${dim}依赖卡:${reset} ${deps}"
    [[ -n "$descr" ]]   && echo -e "    ${dim}描述:${reset} ${descr}"
    echo -e "    ${dim}创建 ${created}  更新 ${updated}${reset}"
    echo ""
}

# ttmux swarm task ls <群> [--col 列][--assignee 成员][--json]
_board_ls() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local col="" who="" json=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --col) col="$2"; shift 2 ;;
            --assignee) who="$2"; shift 2 ;;
            --json) json=1; shift ;;
            *) shift ;;
        esac
    done
    local db where; db=$(_swarm_db_of "$swarm") || return 1
    where="1=1"
    [[ -n "$col" ]] && where="$where AND col='$(_sqe "$col")'"
    [[ -n "$who" ]] && where="$where AND assignee='$(_sqe "$who")'"
    if [[ -n "$json" ]]; then
        sqlite3 -json "$db" "SELECT id,title,descr,assignee,col,deps,created,updated FROM cards WHERE ${where} ORDER BY id;"
        return 0
    fi
    local rows; rows=$(sqlite3 -separator $'\x1f' "$db" \
        "SELECT id,col,IFNULL(assignee,''),title FROM cards WHERE ${where} ORDER BY id;")
    if [[ -z "$rows" ]]; then echo -e "  ${dim}(无卡片)${reset}"; return 0; fi
    local id c a title
    while IFS=$'\x1f' read -r id c a title; do
        [[ -n "$id" ]] || continue
        echo -e "  ${yellow}${id}${reset}  ${dim}[${c}]${reset} ${title}$([[ -n "$a" ]] && echo " ${cyan}→ ${a}${reset}")"
    done <<< "$rows"
}

# ttmux swarm board <群> [--json] — 按列渲染整个看板
_board_render() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    if [[ "${1:-}" == "--json" ]]; then
        local db; db=$(_swarm_db_of "$swarm") || return 1
        sqlite3 -json "$db" "SELECT id,title,descr,assignee,col,deps,created,updated FROM cards ORDER BY id;"
        return 0
    fi
    local db; db=$(_swarm_db_of "$swarm") || return 1
    local goal; goal=$(_swarm_meta_get "$swarm" goal)
    echo ""
    echo -e "  ${icon_group} ${bold}看板: $(_swarm_name "$swarm")${reset}$([[ -n "$goal" ]] && echo "    ${dim}目标: ${goal}${reset}")"
    echo -e "  ${dim}$(printf '─%.0s' {1..50})${reset}"
    local c
    for c in $_BOARD_COLS; do
        local cnt; cnt=$(sqlite3 "$db" "SELECT count(*) FROM cards WHERE col='$c';")
        echo -e "  ${bold}${c}${reset} ${dim}($(_board_col_label "$c") · ${cnt})${reset}"
        local rows; rows=$(sqlite3 -separator $'\x1f' "$db" \
            "SELECT id,title,IFNULL(assignee,''),IFNULL(deps,'') FROM cards WHERE col='$c' ORDER BY id;")
        [[ -z "$rows" ]] && continue
        local id title who deps
        while IFS=$'\x1f' read -r id title who deps; do
            [[ -n "$id" ]] || continue
            local a=""; [[ -n "$who" ]] && a="  ${cyan}→ ${who}${reset}"
            local d=""; [[ -n "$deps" ]] && d="  ${dim}deps: ${deps}${reset}"
            echo -e "    ${yellow}${id}${reset}  ${title}${a}${d}"
        done <<< "$rows"
    done
    # 统计
    local tot; tot=$(sqlite3 "$db" "SELECT count(*) FROM cards;")
    echo ""
    echo -e "  ${dim}共 ${tot} 张卡${reset}"
    echo ""
}

# swarm task <action> 二级分发
_board_task() {
    local action="${1:-}"; shift || true
    case "$action" in
        add)    _board_add "$@" ;;
        ls)     _board_ls "$@" ;;
        show)   _board_show "$@" ;;
        assign) _board_assign "$@" ;;
        move)   _board_move "$@" ;;
        done)   _board_done "$@" ;;
        rm)     _board_rm "$@" ;;
        *) msg_err "未知: swarm task ${action}  ${dim}(add/ls/show/assign/move/done/rm)${reset}"; return 1 ;;
    esac
}
