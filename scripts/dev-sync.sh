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
if [[ ! "$REMOTE_DIR" =~ ^[A-Za-z0-9._/-]+$ || "$REMOTE_DIR" == -* || "$REMOTE_DIR" == /* || "$REMOTE_DIR" == "." || "/$REMOTE_DIR/" == */../* || "/$REMOTE_DIR/" == */./* ]]; then
    printf 'SRTL_REMOTE_DIR must be a safe relative path: %s\n' "$REMOTE_DIR" >&2
    exit 2
fi
SYNC_DRY_RUN="${SRTL_SYNC_DRY_RUN:-0}"
if [[ "$SYNC_DRY_RUN" != "0" && "$SYNC_DRY_RUN" != "1" ]]; then
    printf 'SRTL_SYNC_DRY_RUN must be 0 or 1.\n' >&2
    exit 2
fi

printf 'Syncing %s -> %s:%s/\n' "$ROOT_DIR" "$REMOTE" "$REMOTE_DIR"

ssh "$REMOTE" sh -s -- "$REMOTE_DIR" "$SYNC_DRY_RUN" <<'REMOTE_SCRIPT'
set -eu
remote_dir=$1
dry_run=$2
sentinel="$remote_dir/.srtl-dev-workspace"
if [ -e "$remote_dir" ] && [ ! -d "$remote_dir" ]; then
    printf 'Remote development target is not a directory: %s\n' "$remote_dir" >&2
    exit 2
fi
if [ ! -e "$remote_dir" ]; then
    if [ "$dry_run" = 1 ]; then
        printf 'Remote development target does not exist; run a normal sync once to initialize it: %s\n' "$remote_dir" >&2
        exit 2
    fi
    mkdir -p -- "$remote_dir"
fi
if [ ! -f "$sentinel" ]; then
    if [ -f "$remote_dir/package.json" ]; then
        if ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"srtl-manager"' "$remote_dir/package.json"; then
            printf 'Refusing to adopt a remote directory that is not SRTL Manager: %s\n' "$remote_dir" >&2
            exit 2
        fi
    else
        existing_entry=$(find "$remote_dir" -mindepth 1 -maxdepth 1 -print -quit)
    fi
    if [ ! -f "$remote_dir/package.json" ] && [ -n "$existing_entry" ]; then
        printf 'Refusing to delete into a non-empty remote directory without an SRTL Manager package: %s\n' "$remote_dir" >&2
        exit 2
    fi
    if [ "$dry_run" = 0 ]; then
        : > "$sentinel"
    fi
fi
REMOTE_SCRIPT

rsync_args=(
    -az
    --delete
    --exclude .git
    --exclude node_modules
    --exclude dist
    --exclude data
    --exclude .env
    --exclude coverage
    --exclude .cache
    --exclude test-results
    --exclude playwright-report
    --exclude verification_logs
    --exclude '*.log'
    --exclude .srtl-dev-workspace
)
if [[ "$SYNC_DRY_RUN" == "1" ]]; then
    rsync_args+=(--dry-run --itemize-changes)
fi

rsync "${rsync_args[@]}" -- "$ROOT_DIR/" "$REMOTE:$REMOTE_DIR/"

if [[ "$SYNC_DRY_RUN" == "1" ]]; then
    printf 'Dry run complete; no files were changed.\n'
else
    printf 'Sync complete.\n'
fi
