#!/usr/bin/env bash
# Lightweight automated PR review. It flags common compliance and maintenance
# risks without requiring external services.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_REF="${1:-${GITHUB_BASE_REF:-main}}"
OUT="${2:-}"

cd "$ROOT"

if git rev-parse --verify "origin/${BASE_REF}" >/dev/null 2>&1; then
  BASE="origin/${BASE_REF}"
elif git rev-parse --verify "${BASE_REF}" >/dev/null 2>&1; then
  BASE="${BASE_REF}"
else
  BASE="$(git rev-list --max-parents=0 HEAD | tail -1)"
fi

tmp="${OUT:-$(mktemp)}"
blockers=0
warnings=0

emit() {
  printf '%s\n' "$*" >> "$tmp"
}

block() {
  blockers=$((blockers + 1))
  emit "- [blocking] $*"
}

warn() {
  warnings=$((warnings + 1))
  emit "- [warning] $*"
}

: > "$tmp"
emit "## Automated Review"
emit ""
emit "Base: \`$BASE\`"
emit ""

changed="$(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD || true)"

emit "### Findings"
if [ -z "$changed" ]; then
  warn "No changed files were detected. Verify the workflow checkout depth and base ref."
else
  if printf '%s\n' "$changed" | grep -Eq '(^|/)\.env$'; then
    block "\`.env\` is included in the change set. Commit sanitized examples only."
  fi

  if printf '%s\n' "$changed" | grep -Eq '(^|/)(node_modules|coverage)/'; then
    block "Dependency or coverage output is included. Keep generated folders out of PRs."
  fi

  if printf '%s\n' "$changed" | grep -Eq '^frontend/src/|^frontend/index.html|^frontend/public/'; then
    if ! printf '%s\n' "$changed" | grep -Eq '^frontend/src/i18n/locales/'; then
      warn "Frontend UI files changed without locale updates. Confirm no new user-facing strings were added."
    fi
  fi

  if printf '%s\n' "$changed" | grep -Eq '^backend/|^frontend/src/|^cli/|^scripts/'; then
    if ! printf '%s\n' "$changed" | grep -Eq '(^|/)(test|tests|_test\.go|\.test\.|\.spec\.)'; then
      warn "Runtime code changed without test changes. Add coverage or explain manual validation in the PR."
    fi
  fi

  if git diff "$BASE"...HEAD -- . ':!frontend/package-lock.json' ':!backend/go.sum' ':!cli/ttmux-cli-go/go.sum' \
    | grep -nEI '(api[_-]?key|secret|token|password|passwd|private[_-]?key)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'']{12,}' >/tmp/ttmux-review-secrets.txt; then
    block "Potential hard-coded secret-like value found in the diff. Review and remove secrets before merge."
    sed 's/^/  - /' /tmp/ttmux-review-secrets.txt >> "$tmp"
  fi
fi

if [ "$blockers" -eq 0 ] && [ "$warnings" -eq 0 ]; then
  emit "No blocking policy findings detected."
fi

emit ""
emit "### Changed Files"
if [ -n "$changed" ]; then
  printf '%s\n' "$changed" | sed 's/^/- `/' | sed 's/$/`/' >> "$tmp"
else
  emit "- none"
fi

cat "$tmp"

if [ "$blockers" -gt 0 ]; then
  exit 1
fi
