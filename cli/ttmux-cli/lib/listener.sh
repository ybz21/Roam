# ══════════════════════════════════════════
# ── listener: 广场监听游标 / @mention 路由摘要 ──
# ══════════════════════════════════════════
#
# ttmux swarm listen <群> --as <leader|成员> [--once] [--mentions] [--no-advance] [--interval N]
# 给 agent loop 使用：读取上次游标之后的广场消息，标注 @xx/#tN 相关性，输出状态/看板摘要。
# 它只递送上下文，不替 agent 做决策。

_listener_dir() {
    local id; id=$(_swarm_id "$1")
    [[ -n "$id" ]] || return 1
    echo "$(_swarm_home "$id")/listeners"
}

_listener_key() {
    local key="${1:-leader}"
    [[ "$key" == "master" || "$key" == "lead" ]] && key="leader"
    key="${key//[^A-Za-z0-9_.-]/_}"
    [[ -n "$key" ]] || key="leader"
    echo "$key"
}

_listener_last_get() {
    local dir key
    dir=$(_listener_dir "$1") || return 0
    key=$(_listener_key "$2")
    if [[ -f "${dir}/${key}.last_post" ]]; then
        local v; v=$(<"${dir}/${key}.last_post")
        [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0
    else
        echo 0
    fi
}

_listener_last_set() {
    local dir key val="${3:-0}"
    [[ "$val" =~ ^[0-9]+$ ]] || val=0
    dir=$(_listener_dir "$1") || return 1
    key=$(_listener_key "$2")
    mkdir -p "$dir"
    printf '%s\n' "$val" > "${dir}/${key}.last_post"
}

_listener_member_cards_pattern() {
    local swarm="$1" who="$2" db rows ids=""
    db=$(_swarm_db_of "$swarm") || return 0
    rows=$(sqlite3 "$db" "SELECT id FROM cards WHERE assignee='$(_sqe "$who")' ORDER BY id;" 2>/dev/null || true)
    local id
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        ids="${ids}${ids:+|}${id}"
    done <<< "$rows"
    echo "$ids"
}

_listener_relevance() {
    local who="$1" author="$2" kind="$3" text="$4" cards_re="${5:-}"
    if [[ "$who" == "leader" || "$who" == "master" ]]; then
        if [[ "$author" == "human" || "$text" =~ (^|[[:space:]])@leader($|[[:space:][:punct:]]) || "$text" =~ (^|[[:space:]])@master($|[[:space:][:punct:]]) || "$text" =~ (^|[[:space:]])@all($|[[:space:][:punct:]]) ]]; then
            echo "HIGH"
        else
            echo "watch"
        fi
        return 0
    fi
    if [[ "$text" =~ (^|[[:space:]])@${who}($|[[:space:][:punct:]]) ]]; then echo "HIGH"; return 0; fi
    if [[ "$text" =~ (^|[[:space:]])@all($|[[:space:][:punct:]]) ]]; then echo "all"; return 0; fi
    if [[ -n "$cards_re" && "$text" =~ (^|[[:space:]#])(${cards_re})($|[[:space:][:punct:]]) ]]; then echo "card"; return 0; fi
    if [[ ( "$author" == "leader" || "$author" == "master" ) && ( "$kind" == "decide" || "$kind" == "broadcast" ) ]]; then echo "leader"; return 0; fi
    echo ""
}

_listener_emit_once() {
    local swarm="$1" who="$2" mentions="$3" advance="$4" n="$5"
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    [[ -n "$who" ]] || who="leader"
    [[ "$who" == "master" || "$who" == "lead" ]] && who="leader"
    [[ "$n" =~ ^[0-9]+$ ]] || n=50

    local db last rows cards_re max_id=0
    db=$(_swarm_db_of "$swarm") || return 1
    last=$(_listener_last_get "$swarm" "$who")
    cards_re=$(_listener_member_cards_pattern "$swarm" "$who")
    rows=$(sqlite3 -separator $'\x1f' "$db" "SELECT id,ts,author,kind,IFNULL(re,''),text FROM
        (SELECT * FROM posts WHERE id>${last} ORDER BY id DESC LIMIT ${n}) ORDER BY id;" 2>/dev/null || true)

    echo ""
    echo -e "  ${magenta}◆${reset} ${bold}监听: $(_swarm_name "$swarm")${reset}  ${dim}as=${who} since=#${last}${reset}"
    echo -e "  ${dim}$(printf '─%.0s' {1..50})${reset}"
    if [[ -z "$rows" ]]; then
        echo -e "  ${dim}(没有新广场消息)${reset}"
    else
        local id ts author kind re text rel shown=0 icon who_label reref hhmm
        while IFS=$'\x1f' read -r id ts author kind re text; do
            [[ -n "$id" ]] || continue
            [[ "$id" =~ ^[0-9]+$ && "$id" -gt "$max_id" ]] && max_id="$id"
            rel=$(_listener_relevance "$who" "$author" "$kind" "$text" "$cards_re")
            [[ -n "$mentions" && -z "$rel" ]] && continue
            icon=$(_plaza_kind_icon "$kind")
            case "$author" in
                leader|master) who_label="${magenta}◆ ${author}${reset}" ;;
                human)  who_label="${blue}● ${author}${reset}" ;;
                *)      who_label="${green}● ${author}${reset}" ;;
            esac
            reref=""; [[ -n "$re" ]] && reref=" ${dim}⤷#${re}${reset}"
            hhmm="${ts:11:5}"
            local tag=""; [[ -n "$rel" ]] && tag=" ${yellow}[${rel}]${reset}"
            echo -e "  ${dim}#${id} ${hhmm}${reset}${tag}  ${who_label}  ${icon}${reref} ${text}"
            ((shown++)) || true
        done <<< "$rows"
        if (( shown == 0 )); then
            echo -e "  ${dim}(有新消息，但没有 @${who}/@all/相关卡片消息)${reset}"
        fi
    fi

    echo ""
    echo -e "  ${dim}── 状态摘要 ──${reset}"
    _swarm_status "$swarm" | sed -n '1,22p'
    echo -e "  ${dim}── 看板摘要 ──${reset}"
    _board_render "$swarm" | sed -n '1,40p'

    if [[ -n "$advance" && "$max_id" =~ ^[0-9]+$ && "$max_id" -gt "$last" ]]; then
        _listener_last_set "$swarm" "$who" "$max_id"
        echo -e "  ${dim}游标已推进到 #${max_id}${reset}"
    fi
    return 0
}

_swarm_listen() {
    local swarm="$1"; shift || true
    local who="leader" once="" mentions="" advance=1 interval=10 n=50
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --as)         who="$2"; shift 2 ;;
            --once)       once=1; shift ;;
            --mentions)   mentions=1; shift ;;
            --no-advance) advance=""; shift ;;
            --interval)   interval="$2"; shift 2 ;;
            -n|--lines)   n="$2"; shift 2 ;;
            *)            shift ;;
        esac
    done
    if [[ -n "$once" ]]; then
        _listener_emit_once "$swarm" "$who" "$mentions" "$advance" "$n"
        return $?
    fi
    [[ "$interval" =~ ^[0-9]+$ ]] || interval=10
    while true; do
        _listener_emit_once "$swarm" "$who" "$mentions" "$advance" "$n"
        sleep "$interval"
    done
}
