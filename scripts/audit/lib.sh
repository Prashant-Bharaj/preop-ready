#!/usr/bin/env bash
# Shared helpers for the audit attestation flow (sourced by pre-push-review.sh
# and the on-demand runner). No side effects on source.
#
# The model: the deep audit runs DURING development (Stop-hook-triggered,
# in-session) and records an attestation for the exact tree it reviewed. The
# push then just checks that attestation instead of re-auditing.

# State lives in the git dir (never committed, worktree-scoped) so there are no
# .gitignore concerns and each worktree keeps its own attestation.
audit_state_dir() {
  local gd
  # --absolute-git-dir so downstream paths are absolute (a relative ".git"
  # breaks node's require()/path resolution and is worktree-fragile).
  gd="$(git rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  printf '%s/audit' "$gd"
}
audit_state_file()  { printf '%s/state.json' "$(audit_state_dir)"; }
audit_report_file() { printf '%s/report.md'  "$(audit_state_dir)"; }

# Deterministic fingerprint of "what a push would carry, plus local edits":
# the committed HEAD tree + staged + unstaged tracked changes. Computed
# identically by the audit writer and the pre-push reader, so a tree that
# hasn't changed since its audit matches its own attestation. Docs/markdown
# churn is included (harmless: it just triggers a quick re-audit that passes).
audit_tree_hash() {
  {
    git rev-parse 'HEAD^{tree}' 2>/dev/null || printf 'no-head'
    git diff --cached 2>/dev/null
    git diff 2>/dev/null
  } | shasum -a 256 | awk '{ print $1 }'
}

# Read a top-level string/number field from a flat JSON file without a jq
# dependency (node is always present in this repo). Prints empty on any error.
audit_json_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  # readFileSync (not require) so relative paths resolve against cwd and a
  # ".git/..." path isn't mistaken for a node_modules package.
  node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const v = s[process.argv[2]];
      process.stdout.write(v == null ? "" : String(v));
    } catch { /* missing/malformed → empty */ }
  ' "$file" "$key" 2>/dev/null
}

# Write the attestation atomically. Args: <verdict> <critical> <high> [note]
# Uses printf (not node) to write the JSON — a multi-line `node -e` script is
# mangled by Git Bash → node.exe on Windows ("stdout is not a tty", empty file),
# whereas printf is pure-bash and cross-platform.
audit_write_state() {
  local verdict="$1" critical="${2:-0}" high="${3:-0}" note="${4:-}"
  local dir; dir="$(audit_state_dir)" || return 1
  mkdir -p "$dir"
  local hash ts tmp
  hash="$(audit_tree_hash)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # JSON-escape backslashes and double-quotes in the free-text note.
  note="${note//\\/\\\\}"; note="${note//\"/\\\"}"
  tmp="$dir/state.json.tmp.$$"
  printf '{\n  "verdict": "%s",\n  "critical": %s,\n  "high": %s,\n  "treeHash": "%s",\n  "note": "%s",\n  "timestamp": "%s"\n}\n' \
    "$verdict" "$critical" "$high" "$hash" "$note" "$ts" > "$tmp" && mv "$tmp" "$dir/state.json"
}
