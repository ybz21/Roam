#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks
git config commit.template .gitmessage
chmod +x .githooks/pre-commit .githooks/commit-msg scripts/quality/check.sh scripts/quality/review.sh

echo "Git hooks installed."
echo "  - pre-commit  -> scripts/quality/check.sh quick"
echo "  - commit-msg  -> Conventional Commits 校验 (docs/development/commit-convention.md)"
echo "  - commit.template -> .gitmessage"
