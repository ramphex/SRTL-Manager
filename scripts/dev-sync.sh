#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${SRTL_REMOTE:-}" ]]; then
    REMOTE="$SRTL_REMOTE"
elif [[ -n "${SRTL_REMOTE_HOST:-}" ]]; then
    REMOTE="${SRTL_REMOTE_USER:-root}@$SRTL_REMOTE_HOST"
else
    printf 'Set SRTL_REMOTE or SRTL_REMOTE_HOST before running the development sync.\n' >&2
    exit 2
fi
REMOTE_DIR="${SRTL_REMOTE_DIR:-dev/srtlmanager}"

if [[ "$REMOTE" == -* || "$REMOTE" == *$'\n'* ]]; then
    printf 'Unsafe remote target: %s\n' "$REMOTE" >&2
    exit 2
fi
if [[ ! "$REMOTE_DIR" =~ ^[A-Za-z0-9._/-]+$ || "$REMOTE_DIR" == /* || "/$REMOTE_DIR/" == */../* ]]; then
    printf 'SRTL_REMOTE_DIR must be a safe relative path: %s\n' "$REMOTE_DIR" >&2
    exit 2
fi

printf 'Syncing %s -> %s:%s/\n' "$ROOT_DIR" "$REMOTE" "$REMOTE_DIR"

# The path is expanded locally only after the strict relative-path validation above.
# shellcheck disable=SC2029
ssh "$REMOTE" "mkdir -p -- '$REMOTE_DIR'"

rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude data \
    --exclude .env \
    --exclude coverage \
    --exclude .cache \
    --exclude test-results \
    --exclude playwright-report \
    --exclude verification_logs \
    --exclude '*.log' \
    -- \
    "$ROOT_DIR/" \
    "$REMOTE:$REMOTE_DIR/"

printf 'Sync complete.\n'
