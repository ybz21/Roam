#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks
git config commit.template .gitmessage
chmod +x .githooks/pre-commit .githooks/commit-msg scripts/dev/quality/check.sh scripts/dev/quality/review.sh

echo "Git hooks installed."
echo "  - pre-commit  -> scripts/dev/quality/check.sh quick"
echo "  - commit-msg  -> Conventional Commits 校验 (docs/development/commit-convention.md)"
echo "  - commit.template -> .gitmessage"
