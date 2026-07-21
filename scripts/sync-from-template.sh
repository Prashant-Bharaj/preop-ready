#!/bin/bash
# =============================================================================
# Template Sync Script (manual)
# =============================================================================
# Thin wrapper around the shared update engine (scripts/apply-updates.sh).
# Creates a safety branch, runs the engine, and leaves the changes in your
# worktree for review — nothing is committed.
#
# Usage:
#   ./scripts/sync-from-template.sh [--dry-run]
# =============================================================================

set -e

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Error: not in a git repository"
  exit 1
fi

if [ "${1:-}" = "--dry-run" ]; then
  exec bash "$(dirname "$0")/apply-updates.sh" --dry-run
fi

BACKUP_BRANCH="backup/pre-sync-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP_BRANCH"
echo "Safety branch created: $BACKUP_BRANCH"
echo ""

bash "$(dirname "$0")/apply-updates.sh" --ci

echo ""
echo "Review the changes (git status / git diff), then commit them."
echo "To undo everything: git checkout $BACKUP_BRANCH -- . && git branch -D $BACKUP_BRANCH"
