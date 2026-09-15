#!/usr/bin/env bash
# Shared helpers for the audit attestation flow (sourced by pre-push-review.sh
# and the on-demand runner). No side effects on source.
#
# The model: the deep audit runs BEFORE A PUSH (pre-push-triggered, or on
# demand), fixes and re-audits until only Low findings remain, and records an
# attestation for the exact tree it reviewed. The push then just checks that
# attestation instead of re-auditing.

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

# Write the attestation atomically. Args: <verdict> <critical> <high> [medium] [note]
# (a numeric 4th argument is the medium count; a non-numeric one is the note —
# older callers passed the note as the 4th argument)
# Uses printf (not node) to write the JSON — a multi-line `node -e` script is
# mangled by Git Bash → node.exe on Windows ("stdout is not a tty", empty file),
# whereas printf is pure-bash and cross-platform.
audit_write_state() {
  local verdict="$1" critical="${2:-0}" high="${3:-0}" medium=0 note=""
  if [ "${4:-}" != "" ] && [ "${4}" -eq "${4}" ] 2>/dev/null; then medium="$4"; note="${5:-}"; else note="${4:-}"; fi
  local dir; dir="$(audit_state_dir)" || return 1
  mkdir -p "$dir"
  local hash ts tmp
  hash="$(audit_tree_hash)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # JSON-escape backslashes and double-quotes in the free-text note.
  note="${note//\\/\\\\}"; note="${note//\"/\\\"}"
  tmp="$dir/state.json.tmp.$$"
  printf '{\n  "verdict": "%s",\n  "critical": %s,\n  "high": %s,\n  "medium": %s,\n  "treeHash": "%s",\n  "note": "%s",\n  "timestamp": "%s"\n}\n' \
    "$verdict" "$critical" "$high" "$medium" "$hash" "$note" "$ts" > "$tmp" && mv "$tmp" "$dir/state.json"
}

# True in the platform template repository itself (where the platform files ARE
# the code under review). Mirrors scripts/check-template-pr.sh.
audit_is_template_repo() {
  case "$(git remote get-url origin 2>/dev/null || true)" in
    *bayer-int/dd-template-repository*) return 0 ;;
  esac
  return 1
}

# Filter a file list (stdin) down to what the audit reviews in THIS repo:
# drops docs/** and markdown, and — outside the template repo — every
# platform-owned path (synced from the template per .template-manifest.yml,
# including the version/manifest files). Those files are audited where they
# are written; a project's gate must only cover the project's own code, or a
# platform update commit would be re-audited in every project on the fleet.
audit_reviewable() {
  local patterns=""
  if ! audit_is_template_repo && [ -f .template-manifest.yml ]; then
    patterns=$(awk '
      /^auto_update:|^auto_update_major:|^merge_update:/ { in_section=1; next }
      /^[a-zA-Z_]+:/ && !/^auto_update:|^auto_update_major:|^merge_update:/ { in_section=0 }
      in_section && /^  - path:/ {
        line=$0
        sub(/^  - path:[[:space:]]*/, "", line); gsub(/"/, "", line); sub(/[[:space:]]*#.*$/, "", line)
        print line
      }' .template-manifest.yml 2>/dev/null || true)
  fi
  local f pat owned
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in docs/*|*.md) continue ;; esac
    owned=0
    if [ -n "$patterns" ]; then
      case "$f" in .template-version|.template-manifest.yml) owned=1 ;; esac
      while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        case "$pat" in
          */) [ "${f#$pat}" != "$f" ] && { owned=1; break; } ;;
          *)  [ "$f" = "$pat" ] && { owned=1; break; } ;;
        esac
      done <<< "$patterns"
    fi
    [ "$owned" = "1" ] || printf '%s\n' "$f"
  done
}
