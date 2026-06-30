#!/usr/bin/env bash
# Unified repository quality gate for local hooks and CI.
#
# Usage:
#   scripts/dev/quality/check.sh quick   # pre-commit friendly
#   scripts/dev/quality/check.sh full    # CI / release gate
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-full}"

cd "$ROOT"

section() {
  printf '\n==> %s\n' "$1"
}

changed_files() {
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    git diff --name-only --cached --diff-filter=ACMR
  else
    git diff --name-only --cached --diff-filter=ACMR
  fi
}

tracked_source_files() {
  git ls-files \
    '*.go' '*.sh' '*.bash' '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' \
    ':!:frontend/dist/*' ':!:frontend/node_modules/*'
}

section "Shell syntax"
shell_files="$(git ls-files '*.sh' 'cli/ttmux-cli/build.sh' 'cli/ttmux-cli/lib/*.sh' 'scripts/*.sh')"
if [ -n "$shell_files" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    bash -n "$f"
  done <<< "$shell_files"
fi

section "Go formatting"
go_files="$(git ls-files '*.go')"
if [ -n "$go_files" ]; then
  unformatted="$(gofmt -l $go_files)"
  if [ -n "$unformatted" ]; then
    printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
    exit 1
  fi
fi

section "Go tests"
(cd backend && go test ./...)
(cd cli/ttmux-cli-go && go test ./...)

section "Frontend checks"
if [ ! -d frontend/node_modules ]; then
  echo "frontend/node_modules is missing. Run: cd frontend && npm install" >&2
  exit 1
fi
(cd frontend && npm run i18n:check)
(cd frontend && npm run typecheck)

if [ "$MODE" = "full" ]; then
  section "Frontend build"
  (cd frontend && npm run build)
fi

section "Secret scan"
scan_files="$(tracked_source_files)"
if [ -n "$scan_files" ]; then
  if grep -nEI '(api[_-]?key|secret|token|password|passwd|private[_-]?key)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'']{12,}' $scan_files; then
    echo "Potential hard-coded secret found. Move secrets to .env or documented configuration." >&2
    exit 1
  fi
fi

section "Staged file policy"
staged="$(changed_files || true)"
if [ -n "$staged" ]; then
  if printf '%s\n' "$staged" | grep -Eq '(^|/)(node_modules|dist|coverage)/'; then
    echo "Generated dependency/build output is staged. Remove node_modules, dist, or coverage files from the commit." >&2
    exit 1
  fi
  if printf '%s\n' "$staged" | grep -Eq '(^|/)\.env$'; then
    echo ".env must not be committed. Commit .env.example changes instead." >&2
    exit 1
  fi
fi

section "Quality gate passed"
