#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Install Git Hooks                                               ║
# ║  Symlinks the pre-commit security check AND the pre-push audit   ║
# ║  gate into .git/hooks/. Safe to run multiple times (idempotent). ║
# ║  ⛔ AI agents: DO NOT modify this file.                          ║
# ╚══════════════════════════════════════════════════════════════════╝

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Ensure .git/hooks directory exists (git worktrees keep it in the common dir).
if [ ! -d "$HOOKS_DIR" ]; then
    COMMON="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
    [ -n "$COMMON" ] && HOOKS_DIR="$COMMON/hooks"
fi
if [ ! -d "$HOOKS_DIR" ]; then
    echo "⚠️  Not a git repository (no .git/hooks). Skipping hook install."
    exit 0
fi

# install_hook <hook-name> <source-script> <relative-symlink-target>
install_hook() {
    local name="$1" source="$2" rel="$3"
    local target="$HOOKS_DIR/$name"
    if [ ! -f "$source" ]; then
        echo "⚠️  Hook source not found: $source (skipping $name)"
        return 0
    fi
    chmod +x "$source"
    if [ -L "$target" ]; then
        local cur
        cur="$(readlink "$target" 2>/dev/null || true)"
        if [ "$cur" = "$source" ] || [ "$cur" = "$rel" ]; then
            return 0   # already installed correctly
        fi
    fi
    if [ -f "$target" ] && [ ! -L "$target" ]; then
        mv "$target" "$target.backup"
        echo "📦 Backed up existing $name hook to $name.backup"
    fi
    ln -sf "$rel" "$target"
    echo "✅ $name hook installed."
}

install_hook "pre-commit" "$SCRIPT_DIR/pre-commit-security-check.sh" "../../scripts/pre-commit-security-check.sh"
install_hook "pre-push"   "$SCRIPT_DIR/pre-push-review.sh"           "../../scripts/pre-push-review.sh"
