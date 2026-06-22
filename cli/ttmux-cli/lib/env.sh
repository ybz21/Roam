# ══════════════════════════════════════════
# ── 全局环境变量 ──
# ══════════════════════════════════════════

# 向指定 session 注入全局 env（两种方式配合确保生效）
_inject_env() {
    local sess="$1"
    [[ -f "$TTMUX_ENV" ]] || return 0
    [[ -s "$TTMUX_ENV" ]] || return 0
    while IFS= read -r line; do
        [[ -n "$line" && ! "$line" =~ ^# ]] || continue
        local key="${line%%=*}"
        local val="${line#*=}"
        # tmux 全局环境（新窗口/窗格自动继承）
        "$TMUX_BIN" set-environment -t "$sess" "$key" "$val" 2>/dev/null || true
        # 当前 pane 立即生效
        "$TMUX_BIN" send-keys -t "$sess" "export ${line}" C-m
    done < "$TTMUX_ENV"
    "$TMUX_BIN" send-keys -t "$sess" "clear" C-m
}

# 设置 tmux 全局环境（新 session 自动继承）
_set_global_env() {
    [[ -f "$TTMUX_ENV" ]] || return 0
    [[ -s "$TTMUX_ENV" ]] || return 0
    while IFS= read -r line; do
        [[ -n "$line" && ! "$line" =~ ^# ]] || continue
        local key="${line%%=*}"
        local val="${line#*=}"
        "$TMUX_BIN" set-environment -g "$key" "$val" 2>/dev/null || true
    done < "$TTMUX_ENV"
}

_env_set() {
    local kv="$1"
    local key="${kv%%=*}"
    local tmp
    tmp="$(mktemp "${TTMUX_DATA}/env.XXXXXX")"
    if [[ -f "$TTMUX_ENV" ]]; then
        # 移除旧的同名变量
        grep -v "^${key}=" "$TTMUX_ENV" 2>/dev/null | grep -v '^$' > "$tmp" || true
    fi
    echo "$kv" >> "$tmp"
    mv "$tmp" "$TTMUX_ENV"
    msg_ok "设置 ${bold}${kv}${reset}"
}

_env_rm() {
    local key="$1"
    if [[ -f "$TTMUX_ENV" ]]; then
        local tmp
        tmp="$(mktemp "${TTMUX_DATA}/env.XXXXXX")"
        grep -v "^${key}=" "$TTMUX_ENV" 2>/dev/null | grep -v '^$' > "$tmp" || true
        mv "$tmp" "$TTMUX_ENV"
        msg_ok "已删除 ${bold}${key}${reset}"
    else
        msg_info "无环境变量配置"
    fi
}

_env_list() {
    if [[ ! -f "$TTMUX_ENV" ]] || [[ ! -s "$TTMUX_ENV" ]]; then
        msg_info "无全局环境变量"
        return
    fi
    echo ""
    echo -e "  ${bold}全局环境变量${reset} ${dim}(${TTMUX_ENV})${reset}"
    echo ""
    while IFS= read -r line; do
        [[ -n "$line" && ! "$line" =~ ^# ]] || continue
        local key="${line%%=*}"
        local val="${line#*=}"
        echo -e "    ${green}${key}${reset}=${dim}${val}${reset}"
    done < "$TTMUX_ENV"
    echo ""
}

_env_clear() {
    rm -f "$TTMUX_ENV"
    msg_ok "全局环境变量已清空"
}

_env_list_json() {
    echo -n '['
    local first=true
    if [[ -f "$TTMUX_ENV" ]] && [[ -s "$TTMUX_ENV" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" && ! "$line" =~ ^# ]] || continue
            local key="${line%%=*}" val="${line#*=}"
            [[ "$first" == true ]] || echo -n ','
            first=false
            printf '{"key":%s,"value":%s}' \
                "$(printf '%s' "$key" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')" \
                "$(printf '%s' "$val" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')"
        done < "$TTMUX_ENV"
    fi
    echo ']'
}

# 向所有已有 session 推送当前 env
_env_push() {
    local sessions
    sessions=$(_sessions)
    if [[ -z "$sessions" ]]; then
        msg_info "没有活跃会话"
        return
    fi
    if [[ ! -f "$TTMUX_ENV" ]] || [[ ! -s "$TTMUX_ENV" ]]; then
        msg_info "无环境变量可推送"
        return
    fi
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        _inject_env "$sess"
        msg_ok "已推送到 ${bold}${sess}${reset}"
    done <<< "$sessions"
}
