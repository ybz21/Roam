#!/usr/bin/env bash
#
# skills/sync-skills.sh — 把仓库 skills/ 安装到 Claude Code skills 目录。
#
# 单一真源：install.sh(本地分支) 与 start-all.sh(开发模式) 共用这套合并逻辑，
# 避免两处重复。curl|bash 安装(无本地文件)时 install.sh 走自己的 GitHub 下载分支。
#
#   用法: bash skills/sync-skills.sh [目标目录]    # 默认 ~/.claude/skills
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 仓库 skills/ 目录
DEST="${1:-${HOME}/.claude/skills}"
mkdir -p "$DEST"

# cc-swarm 子文档拼接顺序(生命周期)；与 install.sh 的 GitHub 下载分支保持一致。
CC_SWARM_DOCS="intake decompose spawn patrol approve test-push review concurrency integrate memory"

# ttmux skill：单文件（chrome CLI 不单独建技能，由 cc-swarm 的 CLI 列表引用）
[[ -f "${SRC}/ttmux/SKILL.md" ]] && cp "${SRC}/ttmux/SKILL.md" "${DEST}/ttmux.md"

# cc-swarm skill：SKILL.md + docs/*.md 合并成一个文件
if [[ -f "${SRC}/cc-swarm/SKILL.md" ]]; then
    dest="${DEST}/cc-swarm.md"
    cat "${SRC}/cc-swarm/SKILL.md" > "$dest"
    for doc in $CC_SWARM_DOCS; do
        f="${SRC}/cc-swarm/docs/${doc}.md"; [[ -f "$f" ]] || f="${SRC}/cc-swarm/${doc}.md"
        [[ -f "$f" ]] && { printf '\n\n' >> "$dest"; cat "$f" >> "$dest"; }
    done
fi

echo "✔ skills 已同步到 ${DEST} (ttmux.md, cc-swarm.md)"
