#!/usr/bin/env bash
# wait-codex-review.sh — Block until PR needs attention or review is complete
#
# Usage: wait-codex-review.sh <owner/repo> <pr_number>
#
# Stop conditions (either one → exit 1 "review passed"):
#   A. Codex left a 👍 reaction on the PR body
#   B. All Codex review threads are resolved AND Codex is not currently reviewing
#      (no 👀 reaction). Requires Codex to have commented at least once — an empty
#      PR with no icon means Codex hasn't woken up yet; keep waiting.
#
# Exit codes:
#   0 — Unresolved Codex review thread(s) exist (stdout: JSON array of comment IDs)
#   1 — Review passed (condition A or B above)
#   2 — Timeout (max wait exceeded)
#   3 — CI check failure (stdout: JSON array of failed check names)
#   4 — Merge conflict detected
#   5 — Unresolved review thread(s) from other reviewers (stdout: JSON array of comment IDs)
#
# Notes:
#   - "Unresolved" uses GitHub's native `reviewThread.isResolved` flag.
#   - "Codex reviewed" = any Codex review thread exists on this PR (resolved or not).

set -uo pipefail

REPO="${1:?Usage: wait-codex-review.sh <owner/repo> <pr_number>}"
PR="${2:?Usage: wait-codex-review.sh <owner/repo> <pr_number>}"

OWNER="${REPO%/*}"
NAME="${REPO#*/}"

POLL_INTERVAL=60    # seconds between polls
MAX_POLLS=60        # max polls (~60 min)
CODEX_BOT="chatgpt-codex-connector"

poll_count=0

echo "[babysit] Watching PR #${PR} on ${REPO}"

# Single GraphQL call returns both the unresolved thread ids (split by author)
# and a boolean "has_codex_review" indicating Codex has touched this PR at all.
fetch_review_state() {
    gh api graphql \
        -f query='
          query($owner: String!, $repo: String!, $pr: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pr) {
                reviewThreads(first: 100) {
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes { databaseId author { login } }
                    }
                  }
                }
              }
            }
          }' \
        -f owner="$OWNER" -f repo="$NAME" -F pr="$PR" \
        | jq --arg bot "$CODEX_BOT" '
            .data.repository.pullRequest.reviewThreads.nodes as $threads
            | {
                has_codex_review: ([$threads[] | select(.comments.nodes[0].author.login == $bot)] | length > 0),
                codex: [ $threads[] | select(.isResolved == false and .comments.nodes[0].author.login == $bot) | .comments.nodes[0].databaseId ],
                others: [ $threads[] | select(.isResolved == false and .comments.nodes[0].author.login != $bot) | .comments.nodes[0].databaseId ]
              }'
}

while (( poll_count < MAX_POLLS )); do
    (( poll_count++ ))

    # --- Check 1: CI Actions status ---
    failed_checks=$(gh pr checks "$PR" --repo "$REPO" --json name,state \
        --jq '[.[] | select(.state == "FAILURE" or .state == "ERROR")] | [.[].name]' 2>&1) || {
        echo "[babysit] WARNING: Failed to fetch CI checks: $failed_checks" >&2
        failed_checks="[]"
    }

    if [ "$failed_checks" != "[]" ] && [ -n "$failed_checks" ]; then
        echo "[babysit] CI check(s) failed."
        echo "$failed_checks"
        exit 3
    fi

    pending_checks=$(gh pr checks "$PR" --repo "$REPO" --json name,state \
        --jq '[.[] | select(.state == "PENDING" or .state == "QUEUED" or .state == "IN_PROGRESS")] | length' 2>&1) || {
        echo "[babysit] WARNING: Failed to fetch pending checks: $pending_checks" >&2
        pending_checks=0
    }

    if (( pending_checks > 0 )); then
        ci_pending=true
    else
        ci_pending=false
    fi

    # --- Check 2: Merge conflict ---
    mergeable=$(gh pr view "$PR" --repo "$REPO" --json mergeable --jq '.mergeable' 2>&1) || {
        echo "[babysit] WARNING: Failed to fetch mergeable status: $mergeable" >&2
        mergeable="UNKNOWN"
    }

    if [ "$mergeable" = "CONFLICTING" ]; then
        echo "[babysit] Merge conflict detected."
        exit 4
    fi

    # --- Check 3: Unresolved review threads + codex history (single GraphQL call) ---
    state=$(fetch_review_state 2>&1) || {
        echo "[babysit] WARNING: Failed to fetch review threads: $state" >&2
        state='{"has_codex_review":false,"codex":[],"others":[]}'
    }

    has_codex_review=$(echo "$state" | jq -r '.has_codex_review // false')
    codex_unresolved=$(echo "$state" | jq -c '.codex // []')
    others_unresolved=$(echo "$state" | jq -c '.others // []')

    if [ "$codex_unresolved" != "[]" ] && [ -n "$codex_unresolved" ]; then
        echo "[babysit] Unresolved Codex review thread(s) found."
        echo "$codex_unresolved"
        exit 0
    fi

    if [ "$others_unresolved" != "[]" ] && [ -n "$others_unresolved" ]; then
        echo "[babysit] Unresolved review thread(s) from other reviewers found."
        echo "$others_unresolved"
        exit 5
    fi

    # --- Check 4: Codex reactions on PR body (👀 reviewing, 👍 approved) ---
    reactions=$(gh api "repos/${REPO}/issues/${PR}/reactions" \
        --jq "[.[] | select(.user.login == \"${CODEX_BOT}[bot]\") | .content]" 2>&1) || {
        echo "[babysit] WARNING: Failed to fetch reactions: $reactions" >&2
        reactions="[]"
    }

    has_eyes=$(echo "$reactions" | jq 'contains(["eyes"])')
    has_thumbsup=$(echo "$reactions" | jq 'contains(["+1"])')

    if [ "$has_eyes" = "true" ]; then
        echo "[babysit] (${poll_count}/${MAX_POLLS}) Codex is reviewing (👀)..."
        sleep "$POLL_INTERVAL"
        continue
    fi

    # --- Stop condition A: Codex 👍 approval ---
    if [ "$has_thumbsup" = "true" ]; then
        if [ "$ci_pending" = true ]; then
            echo "[babysit] (${poll_count}/${MAX_POLLS}) Codex approved (👍) but CI pending, waiting..."
            sleep "$POLL_INTERVAL"
            continue
        fi
        echo "[babysit] Codex approved (👍). Review complete."
        exit 1
    fi

    # --- Stop condition B: Codex has reviewed + all resolved + no 👀 ---
    if [ "$has_codex_review" = "true" ]; then
        if [ "$ci_pending" = true ]; then
            echo "[babysit] (${poll_count}/${MAX_POLLS}) All Codex threads resolved but CI pending, waiting..."
            sleep "$POLL_INTERVAL"
            continue
        fi
        echo "[babysit] All Codex review threads resolved, no 👀. Review complete."
        exit 1
    fi

    # --- No Codex signal yet: either not woken up, or very early ---
    if [ "$ci_pending" = true ]; then
        echo "[babysit] (${poll_count}/${MAX_POLLS}) CI pending, waiting for CI and Codex..."
    else
        echo "[babysit] (${poll_count}/${MAX_POLLS}) Waiting for Codex review to start..."
    fi
    sleep "$POLL_INTERVAL"
done

echo "[babysit] Timeout after ${MAX_POLLS} polls."
exit 2
