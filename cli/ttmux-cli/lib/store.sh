# ══════════════════════════════════════════
# ── store: 蜂群 SQLite 存储地基 ──
# ══════════════════════════════════════════
#
# 混合拓扑（详见 cli/ttmux-cli/README.md「落盘布局」）：
#   ${TTMUX_HOME}/meta.db                 全局索引: swarms 注册表(name→id/状态)
#   ${TTMUX_HOME}/swarms/<id>/swarm.db     每群库: members / posts(广场) / cards(看板)
#   ${TTMUX_HOME}/swarms/<id>/logs/        成员终端日志(文件)
#
# 本模块只提供地基(id/转义/schema/解析/查询封装)，不实现业务命令——那些在 swarm.sh。
# 命名上用 _meta_* / _swarm_db* / _swarm_home / _swarm_resolve，与 swarm.sh 既有函数不冲突。

# 依赖守卫：用到蜂群存储时才检查 sqlite3
_need_sqlite() {
    command -v sqlite3 >/dev/null 2>&1 && return 0
    msg_err "蜂群存储需要 ${bold}sqlite3${reset}：apt install sqlite3 / brew install sqlite3"
    return 1
}

# 生成实例 id: YYYY-MMDD-HHMM-<随机4位小写字母数字>，如 2026-0616-1356-aqzq
_id_new() {
    local rnd
    rnd=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c4) || true
    [[ ${#rnd} -eq 4 ]] || rnd=$(printf '%04x' $(( (RANDOM * 31 + RANDOM) & 0xffff )))
    printf '%s-%s\n' "$(date +%Y-%m%d-%H%M)" "$rnd"
}

# 是否 id 形态(用于 name/id 二义解析)
_is_id() { [[ "$1" =~ ^[0-9]{4}-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$ ]]; }

# SQL 单引号转义(防注入)：单引号翻倍。用法: '$(_sqe "$v")'
_sqe() { printf '%s' "${1:-}" | sed "s/'/''/g"; }

# JSON 字符串转义：手拼 JSON 时给字符串值用（转 \ " 换行 制表，无 jq/python 依赖）。
# 用法: "\"goal\":\"$(_jesc "$v")\""
_jesc() {
    local s="${1:-}"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# 查询封装
_sql()  { sqlite3 "$1" "$2"; }            # 文本输出
_sqlj() { sqlite3 -json "$1" "$2"; }      # JSON 输出(空结果回空串)

# ── 全局索引库 meta.db ──
_meta_db() { echo "${TTMUX_HOME}/meta.db"; }
_meta_init() {
    local db; db=$(_meta_db)
    [[ -f "$db" ]] && return 0
    mkdir -p "${TTMUX_HOME}"
    sqlite3 "$db" "CREATE TABLE IF NOT EXISTS swarms(
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        goal TEXT,
        status TEXT,
        supervisor TEXT,
        created TEXT);"
}

# ── 每群库 swarm.db ──（$1 = 蜂群 id）
_swarm_home()    { echo "${TTMUX_HOME}/swarms/${1}"; }
_swarm_db()      { echo "$(_swarm_home "$1")/swarm.db"; }
_swarm_logsdir() { echo "$(_swarm_home "$1")/logs"; }
_swarm_db_init() {
    local id="$1" db; db=$(_swarm_db "$id")
    [[ -f "$db" ]] && return 0
    mkdir -p "$(_swarm_logsdir "$id")"
    sqlite3 "$db" >/dev/null "
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS members(
            name TEXT PRIMARY KEY, type TEXT, task TEXT, workdir TEXT,
            status TEXT, deps TEXT, done INT DEFAULT 0, pending INT DEFAULT 0,
            model TEXT, perm TEXT);
        CREATE TABLE IF NOT EXISTS posts(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, author TEXT, kind TEXT, re INTEGER, text TEXT);
        CREATE TABLE IF NOT EXISTS cards(
            id TEXT PRIMARY KEY, title TEXT, descr TEXT, assignee TEXT,
            col TEXT DEFAULT 'backlog', deps TEXT, created TEXT, updated TEXT);
    "
}

# name 或 id -> id（id 直接返回；name 查 meta.db；查不到回空串）
_swarm_resolve() {
    if _is_id "$1"; then echo "$1"; return 0; fi
    [[ -f "$(_meta_db)" ]] || return 0
    sqlite3 "$(_meta_db)" "SELECT id FROM swarms WHERE name='$(_sqe "$1")' LIMIT 1;"
}
