#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Install Git Hooks                                               ║
# ║  Symlinks pre-commit security check into .git/hooks/             ║
# ║  Safe to run multiple times (idempotent).                        ║
# ║  ⛔ AI agents: DO NOT modify this file.                          ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
HOOK_SOURCE="$SCRIPT_DIR/pre-commit-security-check.sh"
HOOK_TARGET="$HOOKS_DIR/pre-commit"

# Ensure .git/hooks directory exists
if [ ! -d "$HOOKS_DIR" ]; then
    echo "⚠️  Not a git repository (no .git/hooks). Skipping hook install."
    exit 0
fi

# Ensure source script exists
if [ ! -f "$HOOK_SOURCE" ]; then
    echo "⚠️  Hook source not found: $HOOK_SOURCE"
    exit 1
fi

# Make source executable
chmod +x "$HOOK_SOURCE"

# Install symlink (or replace existing)
if [ -L "$HOOK_TARGET" ]; then
    # Already a symlink — check if it points to our script
    current_target=$(readlink "$HOOK_TARGET" 2>/dev/null || true)
    if [ "$current_target" = "$HOOK_SOURCE" ] || [ "$current_target" = "../../scripts/pre-commit-security-check.sh" ]; then
        # Already installed correctly
        exit 0
    fi
fi

# If there's an existing pre-commit hook (not ours), back it up
if [ -f "$HOOK_TARGET" ] && [ ! -L "$HOOK_TARGET" ]; then
    mv "$HOOK_TARGET" "$HOOK_TARGET.backup"
    echo "📦 Backed up existing pre-commit hook to pre-commit.backup"
fi

# Create relative symlink
ln -sf "../../scripts/pre-commit-security-check.sh" "$HOOK_TARGET"
echo "✅ Pre-commit security hook installed."
