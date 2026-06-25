#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit scripts/quality/check.sh scripts/quality/review.sh

echo "Git hooks installed. Pre-commit now runs scripts/quality/check.sh quick."
