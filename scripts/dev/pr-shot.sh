#!/usr/bin/env bash
# 把 PR 截图推到 pr-shots 分支，并打印可直接粘进 PR 正文的 markdown。
#
# 用法：scripts/dev/pr-shot.sh <PR号> <图片> [图片...]
#
# 为什么单独存一条孤儿分支：截图是 PR 的一次性产物，提交进 main 就是往仓库里堆垃圾；
# 而 GitHub 的 PR 正文引不了相对路径，只能给它一个 raw 链接。
# 为什么用 plumbing 而不是 checkout：截图不该逼你把手里的活停下来切分支。
set -euo pipefail

PR="${1:-}"; shift || true
[ -n "$PR" ] && [ "$#" -gt 0 ] || { echo "用法: $0 <PR号> <图片> [图片...]" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
REMOTE="${PR_SHOT_REMOTE:-origin}"
BRANCH="${PR_SHOT_BRANCH:-pr-shots}"
SLUG="$(git remote get-url "$REMOTE" | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')"

INDEX="$(mktemp -u "${TMPDIR:-/tmp}/pr-shot-index.XXXXXX")"
trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE="$INDEX"

# 已有的图必须保住：这条分支是攒下来的，不是每次覆盖。
# 拉不到时**不许**默默从空开始——那样推上去的是一个没有父提交的树，轻则被拒，
# 重则一个 --force 就把之前所有 PR 的图全抹了。只有明说 PR_SHOT_INIT=1 才从空建。
base=""
if git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then
  base="$(git rev-parse FETCH_HEAD)"
  git read-tree "$base"
elif [ "${PR_SHOT_INIT:-0}" = "1" ]; then
  git read-tree --empty
else
  echo "拉不到 $REMOTE/$BRANCH（网络？分支不存在？）。确认要新建这条分支就 PR_SHOT_INIT=1 再跑。" >&2
  exit 1
fi

names=()
for f in "$@"; do
  [ -f "$f" ] || { echo "找不到文件: $f" >&2; exit 1; }
  name="$(basename "$f")"
  blob="$(git hash-object -w "$f")"
  git update-index --add --cacheinfo "100644,$blob,pr-$PR/$name"
  names+=("$name")
done

tree="$(git write-tree)"
[ -n "$tree" ] || { echo "write-tree 失败" >&2; exit 1; }
if [ -n "$base" ]; then
  commit="$(git commit-tree "$tree" -p "$base" -m "shots: PR #$PR")"
else
  commit="$(git commit-tree "$tree" -m "shots: PR #$PR")"
fi
# 空的 commit 变量会让下面这条 push 变成「删除远端分支」——这一步不能省
[ -n "$commit" ] || { echo "commit-tree 失败，已中止（空 sha 会删掉远端分支）" >&2; exit 1; }

git push "$REMOTE" "$commit:refs/heads/$BRANCH"

echo
echo "粘进 PR 正文："
for n in "${names[@]}"; do
  echo "![说明](https://raw.githubusercontent.com/$SLUG/$BRANCH/pr-$PR/$n)"
done
