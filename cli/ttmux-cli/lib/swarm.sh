# ══════════════════════════════════════════
# ── swarm: 蜂群编排 ──
# ══════════════════════════════════════════
#
# 蜂群 = 一个有目标的任务组 + 元数据边车(goal/status/supervisor/deps)。
# 成员就是底层任务组 <swarm> 的会话(<swarm>-<member>)，
# 因此复用 _spawn_one / _status / _collect / _kill_group / _group_* 全套机制。
#
# 存储已迁 SQLite（地基在 lib/store.sh，详见 cli/ttmux-cli/README.md）：
#   ${TTMUX_HOME}/meta.db                全局: swarms(id,name,goal,status,supervisor,created)
#   ${TTMUX_HOME}/swarms/<id>/swarm.db    每群: members(含 deps/done/pending 列)/posts/cards
#   ${TTMUX_HOME}/swarms/<id>/logs/        成员终端日志(文件)
# 成员仍是 tmux 会话 <name>-<member>（运行时走组机器）；下列 helper 对外以「蜂群名」为接口，内部 name→id。

# name 或 id -> id（查 meta.db；查不到回空）
_swarm_id() { _swarm_resolve "$1"; }
# 蜂群目录 / 是否存在（基于 meta.db）
_swarm_dir()    { local id; id=$(_swarm_id "$1"); [[ -n "$id" ]] && _swarm_home "$id"; }
_swarm_exists() { [[ -n "$(_swarm_id "$1")" ]]; }
# 规范蜂群名（运行时会话/组用名，不用 id）
_swarm_name() { _meta_init; sqlite3 "$(_meta_db)" "SELECT name FROM swarms WHERE name='$(_sqe "$1")' OR id='$(_sqe "$1")' LIMIT 1;"; }
# 当前蜂群的 swarm.db（确保已建表）
_swarm_db_of() { local id; id=$(_swarm_id "$1"); [[ -n "$id" ]] || return 1; _swarm_db_init "$id"; _swarm_db "$id"; }

# 蜂群级元数据 <-> meta.db 列（key 为内部常量 goal/status/supervisor/created）
_swarm_meta_get() {
    _meta_init
    sqlite3 "$(_meta_db)" "SELECT IFNULL(${2},'') FROM swarms WHERE name='$(_sqe "$1")' OR id='$(_sqe "$1")' LIMIT 1;"
}
_swarm_meta_set() {
    _meta_init
    sqlite3 "$(_meta_db)" "UPDATE swarms SET ${2}='$(_sqe "$3")' WHERE name='$(_sqe "$1")' OR id='$(_sqe "$1")';"
}

_read_first_file() {
    local f="$1"
    [[ -f "$f" ]] || return 0
    IFS= read -r line < "$f" || true
    printf '%s' "${line:-}"
}

_swarm_migrate_one() {
    local name="$1" created="${2:-}" goal="${3:-}" status="${4:-}" supervisor="${5:-}"
    [[ -n "$name" ]] || return 0
    local id; id=$(_swarm_id "$name")
    if [[ -z "$id" ]]; then
        id=$(_id_new)
        [[ -n "$created" ]] || created="$(date '+%Y-%m-%d %H:%M:%S')"
        [[ -n "$status" ]] || status="planning"
        sqlite3 "$(_meta_db)" "INSERT INTO swarms(id,name,goal,status,supervisor,created)
            VALUES('$(_sqe "$id")','$(_sqe "$name")','$(_sqe "$goal")','$(_sqe "$status")','$(_sqe "$supervisor")','$(_sqe "$created")');"
        msg_ok "迁移蜂群索引 ${bold}${name}${reset} ${dim}(${id})${reset}"
    else
        local set_sql=""
        if [[ -n "$goal" && -z "$(_swarm_meta_get "$name" goal)" ]]; then set_sql="${set_sql}goal='$(_sqe "$goal")',"; fi
        if [[ -n "$status" && -z "$(_swarm_meta_get "$name" status)" ]]; then set_sql="${set_sql}status='$(_sqe "$status")',"; fi
        if [[ -n "$supervisor" && -z "$(_swarm_meta_get "$name" supervisor)" ]]; then set_sql="${set_sql}supervisor='$(_sqe "$supervisor")',"; fi
        if [[ -n "$created" && -z "$(_swarm_meta_get "$name" created)" ]]; then set_sql="${set_sql}created='$(_sqe "$created")',"; fi
        if [[ -n "$set_sql" ]]; then
            set_sql="${set_sql%,}"
            sqlite3 "$(_meta_db)" "UPDATE swarms SET ${set_sql} WHERE name='$(_sqe "$name")';"
        fi
    fi
    _swarm_db_init "$id"
}

_swarm_migrate_members() {
    local name="$1" db gf sess member type task workdir role supervisor
    db=$(_swarm_db_of "$name") || return 0
    gf="$(_group_file "$name")"
    if [[ -f "$gf" ]]; then
        supervisor=$(_swarm_meta_get "$name" supervisor)
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            member=$(_swarm_member_name "$name" "$sess")
            type=$(_task_type "$sess")
            task=$(_task_desc "$sess")
            workdir=$(_read_first_file "$(_task_meta_dir "$sess")/workdir.txt")
            role="member"
            [[ -n "$supervisor" && "$sess" == "$supervisor" ]] && role="leader"
            sqlite3 "$db" "INSERT INTO members(name,type,task,workdir,role,pending,done)
                VALUES('$(_sqe "$member")','$(_sqe "$type")','$(_sqe "$task")','$(_sqe "$workdir")','$(_sqe "$role")',0,0)
                ON CONFLICT(name) DO UPDATE SET
                    type=COALESCE(NULLIF(members.type,''), excluded.type),
                    task=COALESCE(NULLIF(members.task,''), excluded.task),
                    workdir=COALESCE(NULLIF(members.workdir,''), excluded.workdir);"
        done < "$gf"
    elif [[ -n "$db" ]]; then
        mkdir -p "$TTMUX_GROUPS"
        while IFS= read -r member; do
            [[ -n "$member" ]] || continue
            printf '%s\n' "${name}-${member}" >> "$gf"
        done < <(sqlite3 "$db" "SELECT name FROM members WHERE IFNULL(pending,0)=0 ORDER BY name;" 2>/dev/null || true)
    fi
}

_swarm_migrate() {
    _need_sqlite || return 1
    _meta_init
    mkdir -p "$TTMUX_GROUPS"

    local d name created goal status supervisor
    shopt -s nullglob
    for d in "${TTMUX_SWARMS}"/*; do
        [[ -d "$d" ]] || continue
        name=$(basename "$d")
        created=$(_read_first_file "$d/created.txt")
        goal=$(_read_first_file "$d/goal.txt")
        status=$(_read_first_file "$d/status.txt")
        supervisor=$(_read_first_file "$d/supervisor.txt")
        _swarm_migrate_one "$name" "$created" "$goal" "$status" "$supervisor"
    done

    local rows id
    rows=$(sqlite3 -separator $'\x1f' "$(_meta_db)" "SELECT id,name FROM swarms ORDER BY created;" 2>/dev/null || true)
    while IFS=$'\x1f' read -r id name; do
        [[ -n "$id" && -n "$name" ]] || continue
        _swarm_db_init "$id"
        _swarm_migrate_members "$name"
        if [[ -z "$(_swarm_meta_get "$name" supervisor)" ]] && _session_exists "cc-${name}"; then
            _swarm_meta_set "$name" supervisor "cc-${name}"
        fi
    done <<< "$rows"
    msg_ok "蜂群历史数据迁移完成"
}

# 成员显示名: 去掉 "<swarm>-" 前缀
_swarm_member_name() {
    local swarm="$1" sess="$2"
    echo "${sess#"${swarm}"-}"
}

# 成员依赖读写 <-> members.deps 列（行不存在则 upsert）
_swarm_dep_get() {
    local db; db=$(_swarm_db_of "$1") || return 0
    sqlite3 "$db" "SELECT IFNULL(deps,'') FROM members WHERE name='$(_sqe "$2")';"
}
_swarm_dep_set() {
    local db; db=$(_swarm_db_of "$1") || return 1
    sqlite3 "$db" "INSERT INTO members(name,deps) VALUES('$(_sqe "$2")','$(_sqe "$3")')
        ON CONFLICT(name) DO UPDATE SET deps=excluded.deps;"
}

# ── 完成标记 <-> members.done 列 ──
# agent 成员长驻(claude 不退出)，pane_dead 永不触发；由指挥 `swarm done <群> <成员>` 打标记 done=1，
# _swarm_member_done 优先认它，于是下游依赖随之解锁。
_swarm_member_marked_done() {
    local db; db=$(_swarm_db_of "$1") || return 1
    [[ "$(sqlite3 "$db" "SELECT IFNULL(done,0) FROM members WHERE name='$(_sqe "$2")';")" == "1" ]]
}
_swarm_member_mark_done() {
    local db; db=$(_swarm_db_of "$1") || return 1
    sqlite3 "$db" "INSERT INTO members(name,done) VALUES('$(_sqe "$2")',1)
        ON CONFLICT(name) DO UPDATE SET done=1;"
}
# 列出已显式标记完成的成员名(每行一个)
_swarm_done_list() {
    local db; db=$(_swarm_db_of "$1") || return 0
    sqlite3 "$db" "SELECT name FROM members WHERE done=1 ORDER BY name;"
}

_swarm_session_live_status() {
    local sess="$1" kind="${2:-claude}" dead scr tail recent flat low
    if ! _session_exists "$sess"; then
        [[ -f "${TTMUX_LOGS}/${sess}.log" ]] && echo "done" || echo "exited"
        return 0
    fi
    dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo 0)
    if [[ "$dead" == "1" ]]; then
        echo "done"
        return 0
    fi

    scr=$("$TMUX_BIN" capture-pane -t "$sess" -p -J -S -80 2>/dev/null || true)
    tail=$(printf '%s\n' "$scr" | tail -n 18)
    recent=$(printf '%s\n' "$tail" | tail -n 8)
    flat=$(printf '%s' "$recent" | tr -d '[:space:]')
    low="${flat,,}"
    if [[ "$low" == *"pressenter"* || "$low" == *"pressente"* || "$low" == *"1.yes"* || "$low" == *"doyouwant"* || "$low" == *"allow"* || "$low" == *"approval"* ]]; then
        echo "waiting"
        return 0
    fi
    if [[ "$recent" == *"Cooking"* || "$recent" == *"Puzzling"* || "$recent" == *"Thinking"* || "$recent" == *"Working"* || "$recent" == *"Running"* || "$recent" == *"Executing"* ]]; then
        echo "running"
        return 0
    fi
    if [[ "$recent" == *"✻"* && "$recent" != *"Worked for"* ]]; then
        echo "running"
        return 0
    fi
    if [[ "$recent" == *"❯"* || "$recent" == *"›"* || "$recent" == *"⏵⏵"* ]]; then
        echo "idle"
        return 0
    fi
    if [[ "$kind" == "codex" ]]; then
        echo "idle"
        return 0
    fi
    echo "running"
}

# ── 依赖门控：pending 成员 <-> members.pending 列 + 规格列(type/task/workdir/model/perm) ──
# 有依赖且未满足的成员 pending=1 不 spawn；满足后 _swarm_activate 取规格真正 spawn、置 pending=0。

# _swarm_pending_set <群> <成员> <type> <payload> <workdir> <model> <perm>
_swarm_pending_set() {
    local db; db=$(_swarm_db_of "$1") || return 1
    sqlite3 "$db" "INSERT INTO members(name,type,task,workdir,model,perm,kind,role,pending)
        VALUES('$(_sqe "$2")','$(_sqe "$3")','$(_sqe "$4")','$(_sqe "$5")','$(_sqe "$6")','$(_sqe "$7")','$(_sqe "${8:-claude}")','$(_sqe "$(_swarm_role_norm "${9:-member}")")',1)
        ON CONFLICT(name) DO UPDATE SET type=excluded.type,task=excluded.task,
            workdir=excluded.workdir,model=excluded.model,perm=excluded.perm,kind=excluded.kind,role=excluded.role,pending=1;"
}

# 蜂群里是否已有 leader 成员
_swarm_has_master() {
    local db; db=$(_swarm_db_of "$1" 2>/dev/null) || return 1
    [[ -n "$db" ]] || return 1
    local n; n=$(sqlite3 "$db" "SELECT COUNT(*) FROM members WHERE role IN ('leader','master');" 2>/dev/null || echo 0)
    [[ "${n:-0}" -gt 0 ]]
}
_swarm_pending_clear() {
    local db; db=$(_swarm_db_of "$1") || return 1
    sqlite3 "$db" "UPDATE members SET pending=0 WHERE name='$(_sqe "$2")';"
}
# 列出 pending 成员名（每行一个）
_swarm_pending_list() {
    local db; db=$(_swarm_db_of "$1") || return 0
    sqlite3 "$db" "SELECT name FROM members WHERE pending=1 ORDER BY name;"
}

# 成员是否已完成（用于依赖解锁）：
#   1) 指挥显式标记完成(done 标记) —— agent 成员主要靠这条；
#   2) 会话已退出(pane_dead)；
#   3) 会话已消失但跑过(有日志)。
# 仍 pending（从未 spawn、无日志）的成员 -> 未完成。
_swarm_member_done() {
    _swarm_member_marked_done "$1" "$2" && return 0
    local sess="${1}-${2}"
    if _session_exists "$sess"; then
        local dead
        dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo 0)
        [[ "$dead" == "1" ]]
    else
        [[ -f "${TTMUX_LOGS}/${sess}.log" ]]
    fi
}

# 某成员的依赖是否全部满足（空依赖视为满足）
_swarm_deps_satisfied() {
    local swarm="$1" member="$2" deps d
    deps=$(_swarm_dep_get "$swarm" "$member")
    [[ -n "$deps" ]] || return 0
    local IFS=','
    for d in $deps; do
        d="${d#"${d%%[![:space:]]*}"}"; d="${d%"${d##*[![:space:]]}"}"   # trim
        [[ -n "$d" ]] || continue
        _swarm_member_done "$swarm" "$d" || return 1
    done
    return 0
}

# 取出 pending 成员规格(members 行)并真正 spawn
_swarm_spawn_pending() {
    local swarm="$1" member="$2"
    local db; db=$(_swarm_db_of "$swarm") || return 1
    local type task workdir model perm kind
    type=$(sqlite3 "$db" "SELECT IFNULL(type,'agent') FROM members WHERE name='$(_sqe "$member")';")
    task=$(sqlite3 "$db" "SELECT IFNULL(task,'') FROM members WHERE name='$(_sqe "$member")';")
    workdir=$(sqlite3 "$db" "SELECT IFNULL(workdir,'') FROM members WHERE name='$(_sqe "$member")';")
    model=$(sqlite3 "$db" "SELECT IFNULL(model,'') FROM members WHERE name='$(_sqe "$member")';")
    perm=$(sqlite3 "$db" "SELECT IFNULL(perm,'') FROM members WHERE name='$(_sqe "$member")';")
    kind=$(sqlite3 "$db" "SELECT IFNULL(kind,'claude') FROM members WHERE name='$(_sqe "$member")';")
    if [[ "$type" == "agent" ]]; then
        _agent_defaults
        AGENT_WORKDIR="$workdir"
        AGENT_KIND="${kind:-claude}"
        AGENT_INTERACTIVE=1
        [[ -n "$model" ]] && AGENT_MODEL="$model"
        [[ -n "$perm" ]]  && AGENT_PERMISSION="$perm"
    fi
    _spawn_one "$swarm" "$member" "$type" "$task" "$workdir"
}

# ttmux swarm activate <群> [成员] [--quiet] [--force]
# 扫描 pending 成员，依赖已满足的真正启动；级联解锁直到无新增。
# --force: 无视依赖强制解锁(配合指定成员用，逃生口；如依赖成员失败但仍要继续)。
_swarm_activate() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local only="" quiet="" force=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quiet) quiet=1; shift ;;
            --force) force=1; shift ;;
            *) only="$1"; shift ;;
        esac
    done
    local total_launched=0 changed=1
    while (( changed )); do
        changed=0
        local m
        while IFS= read -r m; do
            [[ -n "$m" ]] || continue
            [[ -n "$only" && "$m" != "$only" ]] && continue
            if [[ -n "$force" ]] || _swarm_deps_satisfied "$swarm" "$m"; then
                if _swarm_spawn_pending "$swarm" "$m"; then
                    _swarm_pending_clear "$swarm" "$m"
                    ((total_launched++)) || true
                    changed=1
                    local why="(依赖已满足)"; [[ -n "$force" ]] && why="(强制解锁, 无视依赖)"
                    [[ -z "$quiet" ]] && msg_ok "解锁成员 ${bold}${m}${reset} ${dim}${why}${reset}"
                fi
            fi
        done < <(_swarm_pending_list "$swarm")
        [[ -n "$only" ]] && break   # 指定单成员时不级联
    done
    if [[ -z "$quiet" ]]; then
        if (( total_launched > 0 )); then
            _swarm_meta_set "$swarm" status "running"
        else
            local rest; rest=$(_swarm_pending_list "$swarm" | grep -c . || true)
            if (( rest > 0 )); then
                msg_info "无可解锁成员 ${dim}(还有 ${rest} 个在等依赖)${reset}"
            else
                msg_info "没有挂起的成员"
            fi
        fi
    fi
    return 0
}

# ── 命令 ──

# ttmux swarm new <名> [--goal "..."]
_swarm_new() {
    local name="$1"; shift || true
    [[ -n "$name" ]] || { msg_err "用法: ttmux swarm new <名> [--goal \"...\"]"; return 1; }
    if _swarm_exists "$name"; then
        msg_warn "蜂群 ${bold}${name}${reset} 已存在"
        return 1
    fi
    _need_sqlite || return 1
    local goal="" no_master=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --goal)      goal="$2"; shift 2 ;;
            --no-master) no_master=1; shift ;;
            *) shift ;;
        esac
    done
    _meta_init
    local id; id=$(_id_new)
    sqlite3 "$(_meta_db)" "INSERT INTO swarms(id,name,goal,status,supervisor,created)
        VALUES('$(_sqe "$id")','$(_sqe "$name")','$(_sqe "$goal")','planning','','$(date '+%Y-%m-%d %H:%M:%S')');"
    _swarm_db_init "$id"
    msg_ok "蜂群 ${bold}${name}${reset} 已创建 ${dim}(${id})${reset}"
    [[ -n "$goal" ]] && echo -e "   ${dim}目标: ${goal}${reset}"
    echo -e "   ${dim}加成员: ttmux swarm add ${name} <名> --type agent \"<任务>\"${reset}"
    # 自带 leader：建群即拉起一个加载了 cc-swarm skill 的 Leader 会话(cc-<群>)，它已被告知如何操作 swarm CLI。
    # --no-master 跳过(纯元数据/测试)；缺 claude/tmux 时降级为提示，不中断。
    if [[ -z "$no_master" ]]; then
        if command -v claude >/dev/null 2>&1 && [[ -n "${TMUX_BIN}" ]]; then
            echo -e "   ${dim}拉起 Leader cc-${name} …${reset}"
            _swarm_adopt "$name" || msg_warn "Leader 拉起失败，可稍后手动: ${dim}ttmux swarm adopt ${name}${reset}"
        else
            msg_info "未检测到 claude/tmux，未拉起 Leader；装好后手动接管: ${dim}ttmux swarm adopt ${name}${reset}"
        fi
    fi
}

# ttmux swarm add <群> <成员> [--type task|agent] [--dir/--perm/--model] [--depends-on a,b] <payload...>
_swarm_add() {
    local swarm="$1" member="$2"
    shift 2 2>/dev/null || { msg_err "用法: ttmux swarm add <群> <成员> [--type task|agent] <命令或任务>"; return 1; }
    if ! _swarm_exists "$swarm"; then
        msg_err "蜂群不存在: ${swarm}  ${dim}(先 ttmux swarm new ${swarm})${reset}"
        return 1
    fi
    [[ -n "$member" ]] || { msg_err "成员名不能为空"; return 1; }

    local type="agent" workdir model="" perm="" deps="" kind="claude" role="" payload_parts=()
    _agent_defaults
    workdir="$AGENT_WORKDIR"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --type)       type="$2"; shift 2 ;;
            --dir)        workdir="$2"; shift 2 ;;
            --model)      model="$2"; shift 2 ;;
            --perm)       perm="$2"; shift 2 ;;
            --depends-on) deps="$2"; shift 2 ;;
            --kind)       kind="$2"; shift 2 ;;   # 引擎: claude(默认) | codex
            --role)       role="$2"; shift 2 ;;   # 角色: leader | member（兼容 master | worker，空=自动）
            *)            payload_parts+=("$1"); shift ;;
        esac
    done
    local payload="${payload_parts[*]}"
    if [[ -z "$payload" ]]; then
        msg_err "缺少${type}内容: ${dim}命令(task) 或 任务描述(agent)${reset}"
        return 1
    fi
    if [[ "$type" != "task" && "$type" != "agent" ]]; then
        msg_err "--type 只能是 task 或 agent"
        return 1
    fi
    if [[ "$type" == "agent" && "$kind" != "claude" && "$kind" != "codex" ]]; then
        msg_err "--kind 只能是 claude 或 codex"
        return 1
    fi
    role=$(_swarm_role_norm "$role")
    # 角色默认: 首个 agent 成员 → leader，其余 member（task 类成员一律 member）
    if [[ -z "$role" ]]; then
        if [[ "$type" == "agent" ]] && ! _swarm_has_master "$swarm"; then role="leader"; else role="member"; fi
    fi

    # 记录依赖（供 status 展示 + 门控判断）
    [[ -n "$deps" ]] && _swarm_dep_set "$swarm" "$member" "$deps"

    # 依赖门控：有依赖且未满足 -> 挂起为 pending，不立即 spawn
    if [[ -n "$deps" ]] && ! _swarm_deps_satisfied "$swarm" "$member"; then
        _swarm_pending_set "$swarm" "$member" "$type" "$payload" "$workdir" "$model" "$perm" "$kind" "$role"
        _swarm_meta_set "$swarm" status "running"
        local suffix=""; (( ${#payload} > 60 )) && suffix="..."
        msg_info "成员 ${bold}${member}${reset} (${type}/${role}) ${yellow}已挂起${reset}: ${dim}${payload:0:60}${suffix}${reset}"
        echo -e "   ${dim}等待依赖完成: ${deps}  (依赖满足后自动解锁，或 ttmux swarm activate ${swarm})${reset}"
        return 0
    fi

    # agent 成员: 设置 AGENT_* 供 _agent_cmd 使用（含引擎 kind）
    # 蜂群成员走交互式常驻 claude/codex（可从前端进入；完成靠 swarm done，不靠退出）
    if [[ "$type" == "agent" ]]; then
        AGENT_WORKDIR="$workdir"
        AGENT_KIND="$kind"
        AGENT_INTERACTIVE=1
        [[ -n "$model" ]] && AGENT_MODEL="$model"
        [[ -n "$perm" ]]  && AGENT_PERMISSION="$perm"
    fi

    # 成员 = 任务组 <swarm> 的会话；底层类型 agent 走 claude/codex，task 走 shell
    if _spawn_one "$swarm" "$member" "$type" "$payload" "$workdir"; then
        # 登记成员行(非挂起)，供 done/状态追踪
        local mdb; mdb=$(_swarm_db_of "$swarm") || true
        [[ -n "$mdb" ]] && sqlite3 "$mdb" "INSERT INTO members(name,type,task,workdir,model,perm,kind,role,pending,done)
            VALUES('$(_sqe "$member")','$(_sqe "$type")','$(_sqe "$payload")','$(_sqe "$workdir")','$(_sqe "$model")','$(_sqe "$perm")','$(_sqe "$kind")','$(_sqe "$role")',0,0)
            ON CONFLICT(name) DO UPDATE SET type=excluded.type,task=excluded.task,
                workdir=excluded.workdir,model=excluded.model,perm=excluded.perm,kind=excluded.kind,role=excluded.role,pending=0;"
        _swarm_meta_set "$swarm" status "running"
        local suffix=""; (( ${#payload} > 60 )) && suffix="..."
        msg_ok "成员 ${bold}${member}${reset} (${type}/${kind}/${role}): ${dim}${payload:0:60}${suffix}${reset}"
        [[ -n "$deps" ]] && echo -e "   ${dim}依赖: ${deps} (已满足)${reset}"
        return 0
    fi
    return 1
}

# ttmux swarm ls [--json]
_swarm_ls() {
    _meta_init
    local json=""
    [[ "${1:-}" == "--json" ]] && json=1
    # 用 \x1f 而非 \t 分隔：tab 属空白类 IFS，空字段(如无 goal)会折叠致串列
    if [[ -n "$json" ]]; then
        local jrows; jrows=$(sqlite3 -separator $'\x1f' "$(_meta_db)" \
            "SELECT id,name,IFNULL(goal,''),IFNULL(status,''),IFNULL(supervisor,''),IFNULL(created,'') FROM swarms ORDER BY created;")
        echo "["
        local jfirst=1 jid jname jgoal jstatus jsup jcreated
        while IFS=$'\x1f' read -r jid jname jgoal jstatus jsup jcreated; do
            [[ -n "$jname" ]] || continue
            local jt=0 ja=0 jsess
            while IFS= read -r jsess; do
                [[ -n "$jsess" ]] || continue
                ((jt++)) || true
                _session_exists "$jsess" && ((ja++)) || true
            done < <(_group_sessions "$jname")
            local jp; jp=$(_swarm_pending_list "$jname" | grep -c . || true)
            (( jfirst )) || echo ","
            jfirst=0
            printf '  {"id":"%s","name":"%s","goal":"%s","status":"%s","supervisor":"%s","created":"%s","total":%d,"alive":%d,"pending":%d}' \
                "$(_jesc "$jid")" "$(_jesc "$jname")" "$(_jesc "$jgoal")" "$(_jesc "$jstatus")" "$(_jesc "$jsup")" "$(_jesc "$jcreated")" "$jt" "$ja" "$jp"
        done <<< "$jrows"
        echo ""
        echo "]"
        return 0
    fi
    local rows; rows=$(sqlite3 -separator $'\x1f' "$(_meta_db)" \
        "SELECT name,IFNULL(goal,''),IFNULL(status,''),IFNULL(supervisor,'') FROM swarms ORDER BY created;")
    if [[ -z "$rows" ]]; then
        msg_info "没有蜂群  ${dim}(ttmux swarm new <名> 创建)${reset}"
        return
    fi
    echo ""
    local name goal status sup
    while IFS=$'\x1f' read -r name goal status sup; do
        [[ -n "$name" ]] || continue
        local total=0 alive=0
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            ((total++)) || true
            _session_exists "$sess" && ((alive++)) || true
        done < <(_group_sessions "$name")
        # 状态着色
        local st_str
        case "$status" in
            running)     st_str="${yellow}running${reset}" ;;
            done)        st_str="${green}done${reset}" ;;
            integrating) st_str="${cyan}integrating${reset}" ;;
            archived)    st_str="${dim}archived${reset}" ;;
            *)           st_str="${dim}${status:-planning}${reset}" ;;
        esac
        local pend; pend=$(_swarm_pending_list "$name" | grep -c . || true)
        local pend_str=""; (( pend > 0 )) && pend_str="  ${yellow}+${pend}待解锁${reset}"
        echo -e "   ${icon_group} ${bold}${name}${reset}  ${dim}${alive}/${total} 活跃${reset}${pend_str}  ${st_str}$( [[ -n "$sup" ]] && echo "  ${magenta}◆${sup}${reset}" )"
        [[ -n "$goal" ]] && echo -e "       ${dim}${goal}${reset}"
    done <<< "$rows"
    echo -e "  ${dim}钻取: ttmux swarm status <群>(含看板/广场) · board <群> · feed <群>${reset}"
    echo ""
}

# ttmux swarm status <群> --json — 结构化输出(给 web/巡检)
# {name,goal,status,supervisor,created,leader_last_post, members:[{name,type,task,deps,done,status,session}], pending:[{name,deps}], done_marked:[...]}
_swarm_status_json() {
    local name="$1"
    _swarm_activate "$name" --quiet >/dev/null 2>&1 || true
    local goal status sup created db leader_last
    goal=$(_swarm_meta_get "$name" goal)
    status=$(_swarm_meta_get "$name" status)
    sup=$(_swarm_meta_get "$name" supervisor)
    created=$(_swarm_meta_get "$name" created)
    db=$(_swarm_db_of "$name" 2>/dev/null || true)
    leader_last=$(_listener_last_get "$name" leader 2>/dev/null || echo 0)
    [[ "$leader_last" =~ ^[0-9]+$ ]] || leader_last=0
    printf '{"name":"%s","goal":"%s","status":"%s","supervisor":"%s","created":"%s","leader_last_post":%s,"members":[' \
        "$(_jesc "$name")" "$(_jesc "$goal")" "$(_jesc "$status")" "$(_jesc "$sup")" "$(_jesc "$created")" "$leader_last"
    local first=1
    if [[ -n "$db" ]]; then
        local rows mname mtype mtask mdeps mdone mkind mrole
        # task 可能含多行(渲染后的提示词)：用 \x1e 作记录分隔、read -d 按它读，
        # 否则 task 里的换行会把一行记录拆成多行、字段错位、JSON 崩。
        rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$db" \
            "SELECT name,IFNULL(type,'agent'),IFNULL(task,''),IFNULL(deps,''),IFNULL(done,0),IFNULL(kind,'claude'),CASE IFNULL(role,'member') WHEN 'master' THEN 'leader' WHEN 'worker' THEN 'member' ELSE IFNULL(role,'member') END FROM members WHERE IFNULL(pending,0)=0 ORDER BY name;")
        while IFS=$'\x1f' read -r -d $'\x1e' mname mtype mtask mdeps mdone mkind mrole; do
            [[ -n "$mname" ]] || continue
            local sess="${name}-${mname}" lst="exited"
            if [[ "${mdone:-0}" == "1" ]]; then
                lst="done"
            else
                lst=$(_swarm_session_live_status "$sess" "$mkind")
            fi
            (( first )) || printf ','
            first=0
            printf '{"name":"%s","type":"%s","task":"%s","deps":"%s","done":%s,"kind":"%s","role":"%s","status":"%s","session":"%s"}' \
                "$(_jesc "$mname")" "$(_jesc "$mtype")" "$(_jesc "$mtask")" "$(_jesc "$mdeps")" "${mdone:-0}" "$(_jesc "$mkind")" "$(_jesc "$mrole")" "$lst" "$(_jesc "$sess")"
        done <<< "$rows"
    fi
    printf '],"pending":['
    first=1
    if [[ -n "$db" ]]; then
        local prows pn pd
        prows=$(sqlite3 -separator $'\x1f' "$db" "SELECT name,IFNULL(deps,'') FROM members WHERE pending=1 ORDER BY name;")
        while IFS=$'\x1f' read -r pn pd; do
            [[ -n "$pn" ]] || continue
            (( first )) || printf ','
            first=0
            printf '{"name":"%s","deps":"%s"}' "$(_jesc "$pn")" "$(_jesc "$pd")"
        done <<< "$prows"
    fi
    printf '],"done_marked":['
    first=1
    local dn
    while IFS= read -r dn; do
        [[ -n "$dn" ]] || continue
        (( first )) || printf ','
        first=0
        printf '"%s"' "$(_jesc "$dn")"
    done < <(_swarm_done_list "$name")
    printf ']}\n'
}

# ttmux swarm status <群> [--json]
_swarm_status() {
    local name="" json=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --json) json=1; shift ;;
            *)      name="$1"; shift ;;
        esac
    done
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if [[ -n "$json" ]]; then _swarm_status_json "$name"; return $?; fi
    # 巡检/查看顺手解锁依赖已满足的 pending 成员（静默）
    _swarm_activate "$name" --quiet >/dev/null 2>&1 || true
    local goal status sup created
    goal=$(_swarm_meta_get "$name" goal)
    status=$(_swarm_meta_get "$name" status)
    sup=$(_swarm_meta_get "$name" supervisor)
    created=$(_swarm_meta_get "$name" created)
    echo ""
    echo -e "  ${magenta}◆${reset} ${bold}蜂群: ${name}${reset}   ${dim}[${status:-planning}]${reset}"
    [[ -n "$goal" ]]    && echo -e "    ${dim}目标:${reset} ${goal}"
    [[ -n "$sup" ]]     && echo -e "    ${dim}指挥:${reset} ${magenta}${sup}${reset}"
    [[ -n "$created" ]] && echo -e "    ${dim}创建:${reset} ${dim}${created}${reset}"
    # 成员状态 + 依赖
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        local m dep
        m=$(_swarm_member_name "$name" "$sess")
        dep=$(_swarm_dep_get "$name" "$m")
        [[ -n "$dep" ]] && echo -e "    ${dim}└ ${m} 依赖→ ${dep}${reset}"
    done < <(_group_sessions "$name")
    # 复用任务组状态(逐会话 running/done)；还没有成员时不报错
    if _group_exists "$name"; then
        _status "$name" || true
    elif [[ -z "$(_swarm_pending_list "$name")" ]]; then
        echo -e "    ${dim}(还没有成员，用 a) 加成员)${reset}"
    fi
    # 挂起(pending)成员：等依赖解锁
    local p first=1
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if (( first )); then
            echo -e "  ${dim}── 挂起(等依赖) ──${reset}"
            first=0
        fi
        echo -e "  ${yellow}${icon_run:-⏳}${reset} ${bold}${name}-${p}${reset} ${yellow}挂起${reset}  ${dim}依赖→ $(_swarm_dep_get "$name" "$p")${reset}"
    done < <(_swarm_pending_list "$name")
    # 指挥已显式标记完成的成员(供解锁参考)
    local dm; dm=$(_swarm_done_list "$name" | paste -sd, - 2>/dev/null || true)
    [[ -n "$dm" ]] && echo -e "  ${dim}✔ 已标记完成: ${dm}${reset}"

    # ── 看板摘要（按列计数）──
    local db; db=$(_swarm_db_of "$name" 2>/dev/null || true)
    if [[ -n "$db" ]]; then
        local ncards; ncards=$(sqlite3 "$db" "SELECT count(*) FROM cards;" 2>/dev/null || echo 0)
        if (( ncards > 0 )); then
            local seg="" c cnt
            for c in $_BOARD_COLS; do
                cnt=$(sqlite3 "$db" "SELECT count(*) FROM cards WHERE col='$c';" 2>/dev/null || echo 0)
                (( cnt > 0 )) && seg="${seg}${seg:+  }$(_board_col_label "$c") ${cnt}"
            done
            echo -e "  ${dim}── 看板 ──${reset}  ${seg}   ${dim}(ttmux swarm board ${name})${reset}"
        fi
        # ── 广场最近 3 条 ──
        local prows; prows=$(sqlite3 -separator $'\x1f' "$db" \
            "SELECT id,ts,author,kind,IFNULL(re,''),text FROM (SELECT * FROM posts ORDER BY id DESC LIMIT 3) ORDER BY id;" 2>/dev/null || true)
        if [[ -n "$prows" ]]; then
            echo -e "  ${dim}── 广场(最近3条) ──${reset}   ${dim}(ttmux swarm feed ${name})${reset}"
            _plaza_render_rows <<< "$prows"
        fi
    fi
    return 0
}

# ttmux swarm collect <群> [--json]
_swarm_collect() {
    local name="$1" fmt="${2:-text}"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if ! _group_exists "$name"; then
        msg_info "蜂群 ${bold}${name}${reset} 还没有成员"
        return 0
    fi
    _collect "$name" "$fmt" || true
    return 0
}

# ttmux swarm adopt <群> [--by <cc会话>] [--dir <目录>]
# cc 接管：写 supervisor + 拉起(或复用)一个交互式 cc 会话并注入 /cc-swarm --swarm <群>
_swarm_adopt() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local cc="" dir; dir="$(pwd)"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --by)  cc="$2"; shift 2 ;;
            --dir) dir="$2"; shift 2 ;;
            *)     shift ;;
        esac
    done
    [[ -n "$cc" ]] || cc="cc-${swarm}"

    _swarm_meta_set "$swarm" supervisor "$cc"
    _swarm_meta_set "$swarm" status "running"

    # 指挥入口：作用域锁定到本蜂群；若蜂群有目标，把目标作为输入 → cc-swarm 直接对目标走全流程
    # (接需求→拆任务→开成员→巡检→集成)，而非仅监护。详见 skills/cc-swarm/SKILL.md「--swarm <名> [目标]」。
    local goal; goal=$(_swarm_meta_get "$swarm" goal)
    local invoke="/cc-swarm --swarm ${swarm}"
    [[ -n "$goal" ]] && invoke="${invoke} ${goal}"
    if _session_exists "$cc"; then
        # 复用已有 cc 会话：直接发指令
        "$TMUX_BIN" send-keys -t "$cc" "$invoke" C-m
        msg_ok "已让现有会话 ${bold}${cc}${reset} 接管蜂群 ${bold}${swarm}${reset}"
    else
        # 新建交互式 claude 会话作为指挥
        local claude_bin; claude_bin="$(command -v claude || echo claude)"
        # 单引号上下文转义：' -> '\''（防目标里含单引号把命令截断）
        local invoke_esc=${invoke//\'/\'\\\'\'}
        "$TMUX_BIN" new-session -d -s "$cc" -x 220 -y 50
        _inject_env "$cc"
        "$TMUX_BIN" pipe-pane -t "$cc" -o "cat >> '${TTMUX_LOGS}/${cc}.log'"
        : > "${TTMUX_LOGS}/${cc}.log"
        # 用初始 prompt 直接拉起 cc-swarm 监护(交互式，便于审批/追加指令)
        "$TMUX_BIN" send-keys -t "$cc" "cd '${dir}' && ${claude_bin} '${invoke_esc}'" C-m
        msg_ok "已拉起指挥会话 ${bold}${cc}${reset} 接管蜂群 ${bold}${swarm}${reset}"
        [[ -n "$goal" ]] && echo -e "   ${dim}目标已交给指挥: ${goal}${reset}"
    fi
    echo -e "   ${dim}附加查看:  ttmux a ${cc}${reset}"
    echo -e "   ${dim}若指挥未自动开始，附加后手动发:  ${invoke}${reset}"
}

# ttmux swarm done <群> [成员]
#   无成员 -> 标记整群完成(不杀会话)。
#   带成员 -> 标记该成员完成(指挥判定后打标)，并级联解锁等它的下游 pending 成员。
_swarm_done() {
    local name="$1" member="${2:-}"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if [[ -n "$member" ]]; then
        _swarm_member_mark_done "$name" "$member"
        msg_ok "成员 ${bold}${name}-${member}${reset} 已标记完成 ${dim}(会话不动)${reset}"
        # 标记后顺手解锁下游(依赖它的挂起成员)
        _swarm_activate "$name" || true
        return 0
    fi
    _swarm_meta_set "$name" status "done"
    msg_ok "蜂群 ${bold}${name}${reset} 已标记完成"
}

# ttmux swarm archive <群> — 杀会话、保留元数据、置 archived
_swarm_archive() {
    local name="$1"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if _group_exists "$name"; then
        _kill_group "$name"   # 优雅退出 agent + 杀会话 + 清任务元数据 + 删 .group 文件
    fi
    _swarm_meta_set "$name" status "archived"
    msg_ok "蜂群 ${bold}${name}${reset} 已归档 ${dim}(会话已清，元数据保留)${reset}"
}

# ttmux swarm rm <群> — 彻底删除(杀会话 + 删全部元数据)
_swarm_rm() {
    local name="$1"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if ! _confirm "确定彻底删除蜂群 ${bold}${name}${reset}(含会话与元数据)?"; then
        msg_info "已取消"; return 0
    fi
    _group_exists "$name" && _kill_group "$name" >/dev/null 2>&1 || true
    local id dir; id=$(_swarm_id "$name"); dir=$(_swarm_dir "$name")
    [[ -n "$id" ]] && sqlite3 "$(_meta_db)" "DELETE FROM swarms WHERE id='$(_sqe "$id")';"
    [[ -n "$dir" ]] && rm -rf "$dir"
    msg_ok "蜂群 ${bold}${name}${reset} 已删除"
}

# ttmux swarm sql <群> [--json] "<SELECT ...>"  — 只读逃生口(给 web/调试查每群 swarm.db)
_swarm_sql() {
    local name="$1"; shift || true
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    local json=""
    [[ "${1:-}" == "--json" ]] && { json=1; shift; }
    local q="${1:-}"
    [[ -n "$q" ]] || { msg_err '用法: ttmux swarm sql <群> [--json] "SELECT ..."'; return 1; }
    # 只读守卫：仅允许查询类语句开头
    local head; head=$(printf '%s' "$q" | sed -E 's/^[[:space:]]*//' | tr 'A-Z' 'a-z')
    case "$head" in
        select*|pragma*|explain*|with*|.tables*|.schema*) : ;;
        *) msg_err "只读逃生口：仅允许 SELECT/PRAGMA/EXPLAIN/WITH/.tables/.schema"; return 1 ;;
    esac
    local db; db=$(_swarm_db_of "$name") || return 1
    if [[ -n "$json" ]]; then sqlite3 -json "$db" "$q"; else sqlite3 -header -column "$db" "$q"; fi
}

# ══════════════════════════════════════════
# ── 交互式：两层蜂群界面 ──
# ══════════════════════════════════════════

# 选一个蜂群（提示打到 stderr，选中名打到 stdout）
_pick_swarm() {
    local prompt="${1:-选择蜂群}"
    local swarms=()
    _meta_init
    while IFS= read -r s; do
        [[ -n "$s" ]] && swarms+=("$s")
    done < <(sqlite3 "$(_meta_db)" "SELECT name FROM swarms ORDER BY created;")
    if [[ ${#swarms[@]} -eq 0 ]]; then
        msg_info "没有蜂群" >&2
        return 1
    fi
    if [[ ${#swarms[@]} -eq 1 ]]; then
        echo "${swarms[0]}"; return 0
    fi
    echo "" >&2
    echo -e "  ${bold}${prompt}:${reset}" >&2
    local i=1
    for s in "${swarms[@]}"; do
        echo -e "    ${cyan}${i}${reset}) ${s}  ${dim}[$(_swarm_meta_get "$s" status)]${reset}" >&2
        ((i++)) || true
    done
    echo "" >&2
    read -r -p "  编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#swarms[@]} )); then
        echo "${swarms[$((choice-1))]}"
    else
        return 1
    fi
}

# 第一层：新建蜂群
_interactive_swarm_new() {
    read -r -p "  蜂群名称: " sname </dev/tty
    [[ -n "$sname" ]] || return
    read -r -p "  目标 (可空): " sgoal </dev/tty
    echo ""
    if [[ -n "$sgoal" ]]; then
        _swarm_new "$sname" --goal "$sgoal"
    else
        _swarm_new "$sname"
    fi
    # 顺手问要不要进去加成员
    echo ""
    read -r -p "  现在进入该蜂群加成员? [Y/n]: " yn </dev/tty
    case "${yn:-y}" in
        n|N) ;;
        *) _interactive_swarm_detail "$sname" ;;
    esac
}

# 第二层：加成员
_interactive_swarm_add_member() {
    local swarm="$1"
    read -r -p "  成员名称: " mname </dev/tty
    [[ -n "$mname" ]] || return
    echo -e "  ${bold}类型:${reset}  ${cyan}1${reset}) shell 命令   ${cyan}2${reset}) Claude Agent"
    read -r -p "  选择 [2]: " mt </dev/tty
    echo ""
    if [[ "${mt:-2}" == "1" ]]; then
        read -r -p "  命令: " mcmd </dev/tty
        [[ -n "$mcmd" ]] || { msg_warn "命令为空，取消"; return; }
        read -r -p "  依赖成员 (逗号分隔, 可空): " mdep </dev/tty
        if [[ -n "$mdep" ]]; then
            _swarm_add "$swarm" "$mname" --type task --depends-on "$mdep" "$mcmd"
        else
            _swarm_add "$swarm" "$mname" --type task "$mcmd"
        fi
    else
        read -r -p "  任务描述: " mtask </dev/tty
        [[ -n "$mtask" ]] || { msg_warn "任务为空，取消"; return; }
        read -r -p "  工作目录 [$(pwd)]: " mdir </dev/tty
        mdir="${mdir:-$(pwd)}"
        read -r -p "  权限 (auto/plan/default) [auto]: " mperm </dev/tty
        mperm="${mperm:-auto}"
        read -r -p "  依赖成员 (逗号分隔, 可空): " mdep </dev/tty
        local args=("$swarm" "$mname" --type agent --dir "$mdir" --perm "$mperm")
        [[ -n "$mdep" ]] && args+=(--depends-on "$mdep")
        args+=("$mtask")
        _swarm_add "${args[@]}"
    fi
}

# 第二层：对某成员追加指令
_interactive_swarm_send() {
    local swarm="$1"
    local members=()
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        members+=("$sess")
    done < <(_group_sessions "$swarm")
    if [[ ${#members[@]} -eq 0 ]]; then msg_info "该蜂群还没有成员"; return; fi
    echo ""
    echo -e "  ${bold}成员:${reset}"
    local i=1
    for m in "${members[@]}"; do
        local run; _session_exists "$m" && run=" ${yellow}运行中${reset}" || run=" ${dim}已结束${reset}"
        echo -e "    ${cyan}${i}${reset}) $(_swarm_member_name "$swarm" "$m")${run}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  选择成员编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#members[@]} )); then
        read -r -p "  追加指令: " msg </dev/tty
        [[ -n "$msg" ]] && _task_send "${members[$((choice-1))]}" "$msg"
    else
        msg_err "无效选择"
    fi
}

# 选一个成员标记完成 -> 解锁下游
_interactive_swarm_mark_done() {
    local swarm="$1"
    local members=()
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        members+=("$(_swarm_member_name "$swarm" "$sess")")
    done < <(_group_sessions "$swarm")
    if [[ ${#members[@]} -eq 0 ]]; then msg_info "该蜂群还没有成员"; return; fi
    echo ""
    echo -e "  ${bold}成员:${reset}"
    local i=1
    for m in "${members[@]}"; do
        local mk=""; _swarm_member_marked_done "$swarm" "$m" && mk=" ${dim}✔已标记${reset}"
        echo -e "    ${cyan}${i}${reset}) ${m}${mk}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  标记哪个成员完成(编号): " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#members[@]} )); then
        _swarm_done "$swarm" "${members[$((choice-1))]}"
    else
        msg_err "无效选择"
    fi
}

# 第二层子界面：广场（看 + 发）
_interactive_swarm_plaza() {
    local swarm="$1"
    while true; do
        clear
        _plaza_feed "$swarm"
        echo -e "  ${bold}广场 ${swarm}${reset}    ${cyan}s${reset}) 发言   ${cyan}r${reset}) 刷新   ${cyan}b${reset}) 返回"
        read -r -p "  选择: " a </dev/tty
        case "$a" in
            s)
                read -r -p "  消息: " msg </dev/tty
                if [[ -n "$msg" ]]; then
                    read -r -p "  类型(回车=note, 可: ask/block/decide/done/broadcast): " k </dev/tty
                    _plaza_say "$swarm" --kind "${k:-note}" "$msg" || true; _interactive_pause
                fi ;;
            b|q|"") return ;;
            *) : ;;
        esac
    done
}

# 第二层子界面：看板（看 + 建卡/派活/流转）
_interactive_swarm_board() {
    local swarm="$1"
    while true; do
        clear
        _board_render "$swarm"
        echo -e "  ${bold}看板 ${swarm}${reset}  ${cyan}n${reset}) 建卡  ${cyan}g${reset}) 派活  ${cyan}v${reset}) 移动  ${cyan}r${reset}) 刷新  ${cyan}b${reset}) 返回"
        read -r -p "  选择: " a </dev/tty
        case "$a" in
            n)  read -r -p "  卡片标题: " title </dev/tty
                [[ -n "$title" ]] && { _board_add "$swarm" "$title" >/dev/null || true; _interactive_pause; } ;;
            g)  read -r -p "  卡id: " cid </dev/tty; read -r -p "  派给成员: " who </dev/tty
                [[ -n "$cid" && -n "$who" ]] && { _board_assign "$swarm" "$cid" "$who" || true; _interactive_pause; } ;;
            v)  read -r -p "  卡id: " cid </dev/tty
                read -r -p "  移到列(backlog/assigned/doing/review/done/blocked): " col </dev/tty
                [[ -n "$cid" && -n "$col" ]] && { _board_move "$swarm" "$cid" "$col" || true; _interactive_pause; } ;;
            b|q|"") return ;;
            *) : ;;
        esac
    done
}

# 第二层主循环：蜂群详情 / 成员管理
_interactive_swarm_detail() {
    local swarm="$1"
    while true; do
        clear
        _swarm_status "$swarm"
        echo ""
        echo -e "  ${bold}蜂群 ${swarm} ─ 成员管理${reset}"
        echo -e "    ${cyan}a${reset}) 加成员            ${cyan}m${reset}) 追加指令"
        echo -e "    ${cyan}p${reset}) 广场 ▸            ${cyan}t${reset}) 看板 ▸"
        echo -e "    ${cyan}f${reset}) 标记成员完成      ${cyan}u${reset}) 解锁挂起成员"
        echo -e "    ${cyan}c${reset}) 等待并收集        ${cyan}d${reset}) cc 接管"
        echo -e "    ${cyan}k${reset}) 清理整群          ${cyan}b${reset}) 返回上层"
        echo ""
        read -r -p "  选择: " act </dev/tty
        echo ""
        case "$act" in
            a) _interactive_swarm_add_member "$swarm" || true; _interactive_pause ;;
            m) _interactive_swarm_send "$swarm" || true; _interactive_pause ;;
            p) _interactive_swarm_plaza "$swarm" || true ;;
            t) _interactive_swarm_board "$swarm" || true ;;
            f) _interactive_swarm_mark_done "$swarm" || true; _interactive_pause ;;
            u) _swarm_activate "$swarm" || true; _interactive_pause ;;
            c) _do_wait_group "$swarm" 300 || true; echo ""; _swarm_collect "$swarm" text || true; _interactive_pause ;;
            k)
                if _confirm "清理整群 ${bold}${swarm}${reset} (杀全部成员会话)?"; then
                    _swarm_archive "$swarm" || true
                fi
                _interactive_pause; return ;;
            d) _swarm_adopt "$swarm" || true; _interactive_pause ;;
            b|q|"") return ;;
            *) msg_warn "无效选择"; _interactive_pause ;;
        esac
    done
}

# 第一层主循环：蜂群管理
_interactive_swarm() {
    while true; do
        clear
        echo ""
        echo -e "  ${bold}任务编排 ${magenta}(蜂群 / swarm)${reset}"
        echo -e "  ${dim}$(printf '─%.0s' {1..44})${reset}"
        _swarm_ls
        echo -e "    ${cyan}n${reset}) 新建蜂群          ${cyan}e${reset}) 进入蜂群 ▸"
        echo -e "    ${cyan}d${reset}) cc 接管蜂群       ${cyan}x${reset}) 归档/删除蜂群"
        echo -e "    ${cyan}b${reset}) 返回主菜单"
        echo ""
        read -r -p "  选择: " act </dev/tty
        echo ""
        case "$act" in
            n) _interactive_swarm_new || true; _interactive_pause ;;
            e)
                local s; s=$(_pick_swarm "进入蜂群") || { _interactive_pause; continue; }
                _interactive_swarm_detail "$s" || true ;;
            d)
                local s; s=$(_pick_swarm "cc 接管") || { _interactive_pause; continue; }
                _swarm_adopt "$s" || true; _interactive_pause ;;
            x)
                local s; s=$(_pick_swarm "归档/删除") || { _interactive_pause; continue; }
                echo -e "  ${cyan}1${reset}) 归档(留元数据)  ${cyan}2${reset}) 彻底删除  ${cyan}0${reset}) 取消"
                read -r -p "  选择: " xa </dev/tty
                case "$xa" in
                    1) _swarm_archive "$s" || true ;;
                    2) _swarm_rm "$s" || true ;;
                esac
                _interactive_pause ;;
            b|q|"") return ;;
            *) msg_warn "无效选择"; _interactive_pause ;;
        esac
    done
}
