# ══════════════════════════════════════════
# ── 补全安装 ──
# ══════════════════════════════════════════

_install_completion() {
    local comp_dir="${HOME}/.bash_completion.d"
    local comp_file="${comp_dir}/ttmux"
    mkdir -p "$comp_dir"
    cat > "$comp_file" << 'COMP'
_ttmux_completions() {
    local cur prev cmds
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmds="ls new a attach d detach kill killall rename nw lw kw sp split kp send info source help spawn group capture wait collect status completion agent swarm"

    case "$prev" in
        ttmux)
            COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
            return ;;
        a|attach|kill|rename|send|d|detach|capture|status)
            local sessions
            sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null)
            COMPREPLY=($(compgen -W "$sessions" -- "$cur"))
            return ;;
        group)
            COMPREPLY=($(compgen -W "new ls status kill" -- "$cur"))
            return ;;
        agent)
            COMPREPLY=($(compgen -W "spawn status send collect kill" -- "$cur"))
            return ;;
        swarm)
            COMPREPLY=($(compgen -W "new add ls status activate collect adopt done say feed watch board task sql archive rm" -- "$cur"))
            return ;;
        adopt|activate|done|archive|status|collect|say|feed|watch|sql|add|board)
            local swarms
            swarms=$(sqlite3 ~/.ttmux/meta.db "SELECT name FROM swarms;" 2>/dev/null)
            COMPREPLY=($(compgen -W "$swarms" -- "$cur"))
            return ;;
        sp|split)
            COMPREPLY=($(compgen -W "-h -v" -- "$cur"))
            return ;;
        kw)
            local windows
            windows=$(tmux list-windows -F '#{window_index}' 2>/dev/null)
            COMPREPLY=($(compgen -W "$windows" -- "$cur"))
            return ;;
        wait|collect)
            local groups
            groups=$(ls ~/.local/share/ttmux/groups/*.group 2>/dev/null | xargs -I{} basename {} .group)
            COMPREPLY=($(compgen -W "$groups" -- "$cur"))
            return ;;
    esac
}
complete -F _ttmux_completions ttmux
COMP
    local source_line="[[ -f ~/.bash_completion.d/ttmux ]] && source ~/.bash_completion.d/ttmux"
    if ! grep -qF "bash_completion.d/ttmux" ~/.bashrc 2>/dev/null; then
        echo "" >> ~/.bashrc
        echo "# ttmux tab 补全" >> ~/.bashrc
        echo "$source_line" >> ~/.bashrc
    fi
    msg_ok "Tab 补全已安装"
    msg_info "运行 ${cyan}source ~/.bashrc${reset} 或重开终端生效"
}

