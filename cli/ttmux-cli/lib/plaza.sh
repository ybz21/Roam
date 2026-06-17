# ══════════════════════════════════════════
# ── plaza: 蜂群广场（异步消息流）──
# ══════════════════════════════════════════
#
# 全群共享的追加型消息流；成员/master/human 都能发都能读。
# 存每群 swarms/<id>/swarm.db 的 posts 表(WAL 并发安全)。详见 cli/ttmux-cli/README.md。
# kind: note(随手记) ask(提问) block(报阻塞) decide(决策) done(完成播报) broadcast(全员广播)

# 自动署名：按当前 tmux 会话名推断作者
#   <群>-<成员> -> 成员;  cc-<群> 或 supervisor -> master;  否则 human
_plaza_author() {
    local swarm="$1" sname sess sup
    sname=$(_swarm_name "$swarm")
    sess=$("$TMUX_BIN" display-message -p '#{session_name}' 2>/dev/null || true)
    [[ -n "$sess" ]] || { echo "human"; return; }
    sup=$(_swarm_meta_get "$swarm" supervisor 2>/dev/null || true)
    if [[ -n "$sup" && "$sess" == "$sup" ]]; then echo "master"; return; fi
    if [[ "$sess" == "cc-${sname}" ]]; then echo "master"; return; fi
    if [[ -n "$sname" && "$sess" == "${sname}-"* ]]; then echo "${sess#"${sname}"-}"; return; fi
    echo "human"
}

_plaza_kind_icon() {
    case "$1" in
        broadcast) echo "📢" ;;
        done)      echo "${green}✔${reset}" ;;
        ask)       echo "${yellow}?${reset}" ;;
        decide)    echo "${cyan}◎${reset}" ;;
        block)     echo "${red}!${reset}" ;;
        *)         echo "${dim}·${reset}" ;;
    esac
}

# 渲染一批消息行（stdin: 用 US(\x1f) 分隔的 id ts author kind re text）
# 用 \x1f 而非 \t：tab 属空白类 IFS，连续 tab 会折叠致空字段(空 re)串列。
_plaza_render_rows() {
    local id ts author kind re text icon who reref hhmm
    while IFS=$'\x1f' read -r id ts author kind re text; do
        [[ -n "$id" ]] || continue
        icon=$(_plaza_kind_icon "$kind")
        case "$author" in
            master) who="${magenta}◆ ${author}${reset}" ;;
            human)  who="${blue}● ${author}${reset}" ;;
            *)      who="${green}● ${author}${reset}" ;;
        esac
        reref=""; [[ -n "$re" ]] && reref=" ${dim}⤷#${re}${reset}"
        hhmm="${ts:11:5}"
        echo -e "  ${dim}#${id} ${hhmm}${reset}  ${who}  ${icon}${reref} ${text}"
    done
}

# ttmux swarm say <群> [--as <成员>] [--kind <类型>] [--re <id>] <消息...>
_plaza_say() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local as="" kind="note" re="" parts=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --as)   as="$2"; shift 2 ;;
            --kind) kind="$2"; shift 2 ;;
            --re)   re="$2"; shift 2 ;;
            *)      parts+=("$1"); shift ;;
        esac
    done
    local text="${parts[*]}"
    [[ -n "$text" ]] || { msg_err "消息不能为空"; return 1; }
    local author="$as"
    [[ -n "$author" ]] || author=$(_plaza_author "$swarm")
    local reval="NULL"; [[ "$re" =~ ^[0-9]+$ ]] && reval="$re"
    local db id; db=$(_swarm_db_of "$swarm") || return 1
    # 同一连接内 INSERT + 取自增 id（last_insert_rowid 按连接，分两次调用会拿到 0）
    id=$(sqlite3 "$db" "INSERT INTO posts(ts,author,kind,re,text)
        VALUES(datetime('now','localtime'),'$(_sqe "$author")','$(_sqe "$kind")',${reval},'$(_sqe "$text")');
        SELECT last_insert_rowid();")
    msg_ok "#${id} 已发布 ${dim}(${author}/${kind})${reset}"
}

# 构造 feed 的 WHERE 子句（公共）
_plaza_where() {  # <from> <kind> <since>
    local where="1=1"
    [[ -n "$1" ]] && where="$where AND author='$(_sqe "$1")'"
    [[ -n "$2" ]] && where="$where AND kind='$(_sqe "$2")'"
    [[ -n "$3" && "$3" =~ ^[0-9]+$ ]] && where="$where AND id>${3}"
    echo "$where"
}

# ttmux swarm feed <群> [-n N] [--from <成员>] [--kind <类型>] [--since <id>] [--json]
_plaza_feed() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local n=30 from="" kind="" since="" json=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -n|--lines) n="$2"; shift 2 ;;
            --from)  from="$2"; shift 2 ;;
            --kind)  kind="$2"; shift 2 ;;
            --since) since="$2"; shift 2 ;;
            --json)  json=1; shift ;;
            *) shift ;;
        esac
    done
    [[ "$n" =~ ^[0-9]+$ ]] || n=30
    local db where; db=$(_swarm_db_of "$swarm") || return 1
    where=$(_plaza_where "$from" "$kind" "$since")
    if [[ -n "$json" ]]; then
        sqlite3 -json "$db" "SELECT id,ts,author,kind,re,text FROM
            (SELECT * FROM posts WHERE ${where} ORDER BY id DESC LIMIT ${n}) ORDER BY id;"
        return 0
    fi
    local rows; rows=$(sqlite3 -separator $'\x1f' "$db" "SELECT id,ts,author,kind,IFNULL(re,''),text FROM
        (SELECT * FROM posts WHERE ${where} ORDER BY id DESC LIMIT ${n}) ORDER BY id;")
    echo ""
    echo -e "  ${magenta}◆${reset} ${bold}广场: $(_swarm_name "$swarm")${reset}"
    echo -e "  ${dim}$(printf '─%.0s' {1..50})${reset}"
    if [[ -z "$rows" ]]; then
        echo -e "  ${dim}(还没有消息，用 ttmux swarm say ${swarm} \"...\")${reset}"
    else
        _plaza_render_rows <<< "$rows"
    fi
    echo ""
}

# ttmux swarm watch <群> — 实时跟随(轮询 posts 表)
_plaza_watch() {
    local swarm="$1"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local db; db=$(_swarm_db_of "$swarm") || return 1
    _plaza_feed "$swarm" -n 10
    echo -e "  ${dim}── 跟随中（Ctrl-C 退出）──${reset}"
    local last; last=$(sqlite3 "$db" "SELECT IFNULL(MAX(id),0) FROM posts;")
    while true; do
        local rows; rows=$(sqlite3 -separator $'\x1f' "$db" \
            "SELECT id,ts,author,kind,IFNULL(re,''),text FROM posts WHERE id>${last} ORDER BY id;")
        if [[ -n "$rows" ]]; then
            _plaza_render_rows <<< "$rows"
            last=$(sqlite3 "$db" "SELECT IFNULL(MAX(id),0) FROM posts;")
        fi
        sleep 2
    done
}
