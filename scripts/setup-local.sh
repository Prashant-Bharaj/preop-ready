#!/usr/bin/env bash
# One-command LOCAL setup (plain host-local — no devcontainer/Codespaces).
#
# Git has no "run automatically after clone" hook, so plain-local setup is one
# command you run once after cloning:
#
#     bash scripts/setup-local.sh
#
# It installs the git hooks (pre-commit + pre-push) and registers the per-dev
# .claude audit Stop hook + /audit command. Idempotent — safe to re-run (e.g.
# after a template update to refresh the installed hooks). Cross-platform:
# works in Git Bash on Windows (hooks install as copies there) and on macOS/Linux.
#
# (In Codespaces / a Dev Container this runs automatically via postStartCommand,
# so you never need this script there.)
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || { echo "setup-local: not a git repo"; exit 1; }

echo "== Local setup: installing git hooks + audit registration =="
bash scripts/install-hooks.sh
bash scripts/audit/install-claude-hooks.sh

echo ""
echo "✅ Done."
echo "   • Git hooks installed: pre-commit (security) + pre-push (audit gate)."
echo "   • Audit Stop hook + /audit command registered in .claude/ (per-dev)."
echo "   If Claude Code is already running, open /hooks once (or reload the window)"
echo "   to arm the Stop hook."
