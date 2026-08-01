#!/bin/bash
# ==============================================================================
# Template Update Engine
#
# The single sync implementation for all update paths:
#   - Codespace start:  .devcontainer/auto-update-template.sh -> --silent
#   - Child workflow:   .github/workflows/template-sync.yml   -> --ci
#   - Manual:           scripts/sync-from-template.sh         -> --ci
#
# Usage: ./scripts/apply-updates.sh [--silent|--ci|--dry-run]
#
#   --silent   (default) Update worktree, then activate Claude Code router.
#   --ci       Update worktree only (no router activation). Caller commits.
#   --dry-run  Print what would change without touching anything.
#
# The engine never stages or commits — callers own the git side.
#
# Output contract (consumed by AI assistants and auto-update-template.sh):
#   - Ends with "UPDATE_COMPLETE|<version>" on success
#   - Ends with "UP_TO_DATE|<version>" when nothing to do
#   - Ends with "UPDATE_FAILED|<reason>" on failure
#
# How it works (state convergence, not patch application):
#   1. Fetch the template repo as a git remote (works where gh-api 403s), then
#      pin the ref to the template-v<version> release TAG — everything below is
#      read AND executed from it, so it must not be a moving branch.
#   2. Self-upgrade: if this script differs from the template's copy, re-exec
#      the template's copy. Every child always runs the CURRENT engine
#      against the CURRENT manifest, no matter how old the child is.
#   3. Read the manifest FROM THE TEMPLATE REF (not the local copy).
#   4. Apply `migrations:` blocks for every version > local, ascending.
#   5. Sync every `auto_update` entry: directories are removed and
#      re-materialized from the template (renames/deletions propagate);
#      files are overwritten. User-modified platform files are backed up
#      to .template-backup/<old-version>/ (gitignored) first.
#   6. Apply `cleanup:` entries (file / directory / gitignore_entry).
#   7. Append missing .gitignore patterns from the template.
#
# User code (frontend/*, backend/*, database/init/*, docs/PROJECT_STATUS.md)
# is NEVER touched — only paths listed in the manifest are written.
# ==============================================================================

set -e

# The entire body is one group command so bash parses the whole file before
# executing any of it. Without this, an engine run that overwrites this very
# file mid-execution (as legacy pre-engine update scripts do when syncing
# scripts/) makes bash read garbage at the old byte offset and crash.
{

TEMPLATE_REPO="bayer-int/dd-template-repository"
# Env overrides exist for the template repo's own test harness only.
TEMPLATE_URL="${TEMPLATE_URL:-https://github.com/${TEMPLATE_REPO}.git}"
TEMPLATE_BRANCH="${TEMPLATE_BRANCH:-master}"
TEMPLATE_BRANCH_REF="template/${TEMPLATE_BRANCH}"
# Provisional — repointed at the release tag in step 1b, before anything is
# read or executed from it.
TEMPLATE_REF="$TEMPLATE_BRANCH_REF"
MANIFEST_FILE=".template-manifest.yml"
BACKUP_ROOT=".template-backup"

extract_version() {
    echo "$1" | grep "^version:" | head -1 | sed 's/version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d '[:space:]'
}

MODE="silent"
case "${1:-}" in
  --ci)      MODE="ci" ;;
  --dry-run) MODE="dry-run" ;;
  --silent|"") MODE="silent" ;;
  *) echo "UPDATE_FAILED|Unknown option: $1"; exit 1 ;;
esac

fail() {
    echo "UPDATE_FAILED|$1"
    exit 1
}

# ------------------------------------------------------------------------------
# 1. Fetch template
# ------------------------------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not in a git repository"

if git remote get-url template >/dev/null 2>&1; then
    git remote set-url template "$TEMPLATE_URL" || true
else
    git remote add template "$TEMPLATE_URL" 2>/dev/null || true
fi
if ! git fetch -q template "+refs/heads/${TEMPLATE_BRANCH}:refs/remotes/${TEMPLATE_BRANCH_REF}" 2>/dev/null; then
    echo "Could not fetch the template repo (${TEMPLATE_REPO})."
    echo "In Codespaces this is expected sometimes: the built-in token only sees THIS"
    echo "repo, and it also OVERRIDES gh logins. Fix (one-time per Codespace) — use"
    echo "your BAYER GitHub account, not a personal one:"
    echo '    unset GITHUB_TOKEN GH_TOKEN'
    echo '    gh auth login --web --hostname github.com'
    echo '    export TEMPLATE_URL="https://x-access-token:$(gh auth token)@github.com/'"${TEMPLATE_REPO}"'.git"'
    echo '    bash scripts/apply-updates.sh'
    fail "Could not fetch template (git)"
fi
# Version tags enable user-modified detection; older templates have none.
git fetch -q template '+refs/tags/template-v*:refs/tags/template-v*' 2>/dev/null || true

# ------------------------------------------------------------------------------
# 1b. Pin the template ref to the release tag
#
# Everything below is READ AND EXECUTED from ${TEMPLATE_REF}: the engine
# re-execs the template's own copy of THIS script, and `run:` migration steps
# are piped straight into bash. Anchoring that on a mutable branch means every
# child repo runs whatever happens to be on ${TEMPLATE_BRANCH} at the moment it
# fires — unattended, and in CI with contents: write.
#
# So: read the target version off the branch manifest (a version string —
# nothing is executed yet), then repoint the ref at the matching
# template-v<version> tag. Same tags version-bump.yml already creates and the
# engine already uses as the user-modification baseline.
#
# LIMITS — this is a speed bump, not a signature check:
#   * The tags are UNSIGNED, and movable by anyone who can push tags.
#   * If the manifest names a version with no tag yet (the window between the
#     bump commit and the tag push, or a template that predates tagging) we
#     fall back to the branch and print it.
#   Branch protection plus mandatory review on the template repo therefore
#   remain a load-bearing security control, not a nice-to-have.
#
# TEMPLATE_ALLOW_UNPINNED=1 disables pinning — template's own test harness only.
# ------------------------------------------------------------------------------
if [ "${TEMPLATE_ALLOW_UNPINNED:-0}" = "1" ]; then
    echo "Note: TEMPLATE_ALLOW_UNPINNED=1 — reading from ${TEMPLATE_BRANCH} (unpinned)."
else
    TARGET_VERSION=$(extract_version "$(git show "${TEMPLATE_BRANCH_REF}:${MANIFEST_FILE}" 2>/dev/null)")
    if [ -n "$TARGET_VERSION" ] && git rev-parse -q --verify "refs/tags/template-v${TARGET_VERSION}" >/dev/null 2>&1; then
        TEMPLATE_REF="template-v${TARGET_VERSION}"
    else
        echo "Note: no template-v${TARGET_VERSION:-?} tag in the template — falling back to the ${TEMPLATE_BRANCH} branch."
    fi
fi

# ------------------------------------------------------------------------------
# 2. Self-upgrade: always run the template's current engine
# ------------------------------------------------------------------------------
if [ -z "${TEMPLATE_ENGINE_FROM_REF:-}" ]; then
    LATEST_ENGINE=$(mktemp)
    if git show "${TEMPLATE_REF}:scripts/apply-updates.sh" > "$LATEST_ENGINE" 2>/dev/null; then
        if ! cmp -s "$LATEST_ENGINE" "${BASH_SOURCE[0]}"; then
            echo "Engine outdated — re-executing the template's current engine..."
            TEMPLATE_ENGINE_FROM_REF=1 exec bash "$LATEST_ENGINE" "--$MODE"
        fi
    fi
    rm -f "$LATEST_ENGINE"
fi

# ------------------------------------------------------------------------------
# 3. Versions
# ------------------------------------------------------------------------------
# Re-read from the PINNED ref so the manifest and the files/scripts we act on
# come from the same commit.
MANIFEST=$(git show "${TEMPLATE_REF}:${MANIFEST_FILE}" 2>/dev/null) \
    || fail "Could not read manifest from template"

LATEST_VERSION=$(extract_version "$MANIFEST")
[ -n "$LATEST_VERSION" ] || fail "Could not determine template version"

if [ -f .template-version ]; then
    LOCAL_VERSION=$(extract_version "$(cat .template-version)")
    # Migration baseline: which migrations this repo has already applied.
    # Absent on repos last updated by a pre-engine script — treated as 0.0.0,
    # which replays all migration blocks (they are idempotent by contract).
    MIG_BASELINE=$(grep "^migrations_applied:" .template-version 2>/dev/null | head -1 | cut -d'"' -f2)
fi
[ -n "${LOCAL_VERSION:-}" ] || LOCAL_VERSION="0.0.0"
[ -n "${MIG_BASELINE:-}" ] || MIG_BASELINE="0.0.0"

# ver_gt A B  ->  true when A > B (semver compare via sort -V)
ver_gt() {
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

MIGRATION_VERSIONS=$(echo "$MANIFEST" | awk '
/^migrations:/ { in_section=1; next }
/^[a-zA-Z_]+:/ && in_section { exit }
in_section && /^  "[0-9]+\.[0-9]+\.[0-9]+":/ {
    gsub(/[":]/, "")
    print $1
}' | sort -V)
# Only migrations already released (key <= manifest version) count as pending —
# a key staged for a future bump must not trigger convergence loops.
LATEST_MIGRATION=""
for MV in $MIGRATION_VERSIONS; do
    ver_gt "$MV" "$LATEST_VERSION" || LATEST_MIGRATION="$MV"
done

# Up to date only when BOTH the version matches AND no migration is pending.
# The second condition rescues repos that were bumped to the latest version
# by a legacy (pre-engine) update script that could not delete or migrate:
# the next run with this engine converges them fully.
PENDING_MIGRATIONS=false
if [ -n "$LATEST_MIGRATION" ] && ver_gt "$LATEST_MIGRATION" "$MIG_BASELINE"; then
    PENDING_MIGRATIONS=true
fi

if ! ver_gt "$LATEST_VERSION" "$LOCAL_VERSION" && [ "$PENDING_MIGRATIONS" = "false" ]; then
    echo "UP_TO_DATE|$LOCAL_VERSION"
    exit 0
fi

if ver_gt "$LATEST_VERSION" "$LOCAL_VERSION"; then
    echo "Updating $LOCAL_VERSION -> $LATEST_VERSION (mode: $MODE)..."
else
    echo "Version current ($LOCAL_VERSION) but migrations pending — converging (mode: $MODE)..."
fi
echo ""

BACKUP_DIR="${BACKUP_ROOT}/${LOCAL_VERSION}"
BACKED_UP=()

# Baseline for "did the user modify this platform file": the version they had.
BASELINE_TAG="template-v${LOCAL_VERSION}"
HAS_BASELINE=false
if git rev-parse -q --verify "refs/tags/${BASELINE_TAG}" >/dev/null 2>&1; then
    HAS_BASELINE=true
fi

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

# backup_file <path> — copy a to-be-overwritten/removed file into the backup
# dir when it looks user-modified (differs from the baseline tag when
# available, otherwise differs from what we are about to write).
backup_file() {
    local path="$1"
    [ -f "$path" ] || return 0
    if $HAS_BASELINE; then
        if git show "${BASELINE_TAG}:${path}" 2>/dev/null | cmp -s - "$path"; then
            return 0  # untouched since it was shipped
        fi
    else
        if git show "${TEMPLATE_REF}:${path}" 2>/dev/null | cmp -s - "$path"; then
            return 0  # identical to incoming — nothing to lose
        fi
    fi
    mkdir -p "$BACKUP_DIR/$(dirname "$path")"
    cp "$path" "$BACKUP_DIR/$path"
    BACKED_UP+=("$path")
}

# write_from_template <path> — overwrite one file with the template's version.
write_from_template() {
    local path="$1"
    mkdir -p "$(dirname "$path")"
    git show "${TEMPLATE_REF}:${path}" > "$path" 2>/dev/null || {
        echo "    Warning: could not fetch $path"
        return 1
    }
    return 0
}

sync_file() {
    local path="$1"
    if ! git cat-file -e "${TEMPLATE_REF}:${path}" 2>/dev/null; then
        echo "  Skipped (not in template): $path"
        return 0
    fi
    if [ -f "$path" ] && git show "${TEMPLATE_REF}:${path}" 2>/dev/null | cmp -s - "$path"; then
        return 0  # already current
    fi
    if [ "$MODE" = "dry-run" ]; then
        echo "  Would update: $path"
        return 0
    fi
    backup_file "$path"
    write_from_template "$path" && echo "  Updated: $path"
}

# sync_directory <dir> — full state convergence: back up user-modified files,
# remove the local copy, re-materialize every file from the template
# (recursive; stale/renamed files disappear).
sync_directory() {
    local dir="${1%/}"
    local files
    files=$(git ls-tree -r --name-only "$TEMPLATE_REF" -- "$dir" 2>/dev/null)
    if [ -z "$files" ]; then
        echo "  Skipped (not in template): $dir/"
        return 0
    fi

    if [ "$MODE" = "dry-run" ]; then
        while IFS= read -r f; do
            if [ ! -f "$f" ]; then
                echo "  Would add:    $f"
            elif ! git show "${TEMPLATE_REF}:${f}" 2>/dev/null | cmp -s - "$f"; then
                echo "  Would update: $f"
            fi
        done <<< "$files"
        if [ -d "$dir" ]; then
            while IFS= read -r existing; do
                echo "$files" | grep -Fxq "$existing" || echo "  Would remove: $existing"
            done < <(find "$dir" -type f)
        fi
        return 0
    fi

    if [ -d "$dir" ]; then
        while IFS= read -r existing; do
            backup_file "$existing"
        done < <(find "$dir" -type f)
        rm -rf "$dir"
    fi
    while IFS= read -r f; do
        write_from_template "$f" >/dev/null || true
    done <<< "$files"
    echo "  Updated: $dir/ ($(echo "$files" | wc -l | tr -d ' ') files)"
}

# remove_gitignore_line <pattern> — drop exact-match lines (portable: no sed -i)
remove_gitignore_line() {
    local pattern="$1"
    [ -f .gitignore ] || return 0
    if grep -Fxq "$pattern" .gitignore || grep -Fxq "${pattern}/" .gitignore; then
        grep -Fxv "$pattern" .gitignore | grep -Fxv "${pattern}/" > .gitignore.tmp
        mv .gitignore.tmp .gitignore
        echo "  Cleaned from .gitignore: $pattern"
    fi
}

add_gitignore_line() {
    local pattern="$1"
    touch .gitignore
    if ! grep -Fxq "$pattern" .gitignore; then
        echo "$pattern" >> .gitignore
        echo "  Added to .gitignore: $pattern"
    fi
}

# ------------------------------------------------------------------------------
# 4. Migrations — one-time, version-gated steps (applied ascending, before sync)
#
# Manifest format (rigid on purpose — parsed by bash):
#   migrations:
#     "1.5.0":
#       description: "..."
#       steps:
#         - delete: "path/to/file"
#         - delete_dir: "path/to/dir"
#         - move: "old/path -> new/path"
#         - gitignore_add: "pattern"
#         - gitignore_remove: "pattern"
#         - run: "scripts/migrations/1.5.0-fixup.sh"
#
# Every op is idempotent; a child jumping several versions replays each block
# in version order. `run:` scripts execute FROM THE TEMPLATE REF and must be
# idempotent themselves.
# ------------------------------------------------------------------------------
apply_migration_step() {
    local op="$1" arg="$2"
    case "$op" in
        delete)
            if [ -f "$arg" ] || [ -L "$arg" ]; then
                [ "$MODE" = "dry-run" ] && { echo "  Would delete: $arg"; return 0; }
                backup_file "$arg"
                rm -f "$arg"
                echo "  Deleted: $arg"
            fi
            ;;
        delete_dir)
            if [ -d "$arg" ]; then
                [ "$MODE" = "dry-run" ] && { echo "  Would delete dir: $arg/"; return 0; }
                while IFS= read -r existing; do
                    backup_file "$existing"
                done < <(find "$arg" -type f)
                rm -rf "$arg"
                echo "  Deleted: $arg/"
            fi
            ;;
        move)
            local from="${arg%% -> *}" to="${arg##* -> }"
            if [ -e "$from" ] && [ ! -e "$to" ]; then
                [ "$MODE" = "dry-run" ] && { echo "  Would move: $from -> $to"; return 0; }
                mkdir -p "$(dirname "$to")"
                mv "$from" "$to"
                echo "  Moved: $from -> $to"
            fi
            ;;
        gitignore_add)
            [ "$MODE" = "dry-run" ] && { echo "  Would ensure in .gitignore: $arg"; return 0; }
            add_gitignore_line "$arg"
            ;;
        gitignore_remove)
            [ "$MODE" = "dry-run" ] && { echo "  Would remove from .gitignore: $arg"; return 0; }
            remove_gitignore_line "$arg"
            ;;
        run)
            if git cat-file -e "${TEMPLATE_REF}:${arg}" 2>/dev/null; then
                [ "$MODE" = "dry-run" ] && { echo "  Would run: $arg (from template)"; return 0; }
                echo "  Running migration script: $arg"
                git show "${TEMPLATE_REF}:${arg}" | bash || echo "    Warning: $arg exited non-zero"
            else
                echo "    Warning: migration script $arg not found in template"
            fi
            ;;
        *)
            echo "    Warning: unknown migration op '$op' (manifest newer than engine?)"
            ;;
    esac
}

echo "Checking migrations..."
for MV in $MIGRATION_VERSIONS; do
    if ver_gt "$MV" "$MIG_BASELINE" && ! ver_gt "$MV" "$LATEST_VERSION"; then
        echo "Applying migration $MV..."
        while IFS=$'\t' read -r OP ARG; do
            [ -n "$OP" ] && apply_migration_step "$OP" "$ARG"
        done < <(echo "$MANIFEST" | awk -v ver="$MV" '
        /^migrations:/ { in_mig=1; next }
        /^[a-zA-Z_]+:/ && in_mig { exit }
        in_mig && $0 ~ "^  \"" ver "\":" { in_ver=1; next }
        in_mig && /^  "[0-9]+\.[0-9]+\.[0-9]+":/ { in_ver=0; next }
        in_ver && /^      - [a-z_]+:/ {
            line=$0
            sub(/^      - /, "", line)
            op=line
            sub(/:.*/, "", op)
            arg=line
            sub(/^[a-z_]+:[[:space:]]*/, "", arg)
            gsub(/^"|"$/, "", arg)
            print op "\t" arg
        }')
    fi
done

# ------------------------------------------------------------------------------
# 5. Sync auto_update entries
# ------------------------------------------------------------------------------
echo ""
echo "Syncing platform files..."
while IFS=$'\t' read -r P IS_DIR; do
    P=$(echo "$P" | tr -d '[:space:]')
    [ -z "$P" ] && continue
    if [ "$IS_DIR" = "true" ]; then
        sync_directory "$P"
    else
        sync_file "$P"
    fi
done < <(echo "$MANIFEST" | awk '
/^auto_update:/ { in_section=1; next }
/^[a-zA-Z_]+:/ && in_section { exit }
in_section && /^  - path:/ {
    if (path) print path "\t" is_dir
    line=$0
    sub(/^  - path:[[:space:]]*/, "", line)
    gsub(/"/, "", line)
    sub(/[[:space:]]*#.*$/, "", line)
    path=line
    is_dir="false"
    next
}
in_section && /is_directory:[[:space:]]*true/ { is_dir="true"; next }
END { if (path) print path "\t" is_dir }
')

# ------------------------------------------------------------------------------
# 6. .gitignore append-merge (before cleanup, so cleanup entries win)
# ------------------------------------------------------------------------------
if [ "$MODE" != "dry-run" ] && [ -f .gitignore ]; then
    TEMPLATE_GITIGNORE=$(git show "${TEMPLATE_REF}:.gitignore" 2>/dev/null || echo "")
    if [ -n "$TEMPLATE_GITIGNORE" ]; then
        while IFS= read -r pattern; do
            case "$pattern" in ""|\#*) continue ;; esac
            grep -Fxq "$pattern" .gitignore || echo "$pattern" >> .gitignore
        done <<< "$TEMPLATE_GITIGNORE"
    fi
fi

# ------------------------------------------------------------------------------
# 7. Cleanup — permanent "must not exist" invariants
# ------------------------------------------------------------------------------
echo ""
echo "Checking for deprecated files..."
while IFS=$'\t' read -r CPATH CTYPE; do
    CPATH=$(echo "$CPATH" | tr -d '[:space:]')
    CTYPE=$(echo "$CTYPE" | tr -d '[:space:]')
    [ -z "$CPATH" ] && continue
    case "$CTYPE" in
        file)
            if [ -f "$CPATH" ] || [ -L "$CPATH" ]; then
                [ "$MODE" = "dry-run" ] && { echo "  Would remove: $CPATH"; continue; }
                rm -f "$CPATH"
                echo "  Removed: $CPATH"
            fi
            ;;
        directory)
            if [ -d "$CPATH" ]; then
                [ "$MODE" = "dry-run" ] && { echo "  Would remove: $CPATH/"; continue; }
                rm -rf "$CPATH"
                echo "  Removed: $CPATH/"
            fi
            ;;
        gitignore_entry)
            if [ "$MODE" = "dry-run" ]; then
                if [ -f .gitignore ] && { grep -Fxq "$CPATH" .gitignore || grep -Fxq "${CPATH}/" .gitignore; }; then
                    echo "  Would clean from .gitignore: $CPATH"
                fi
                continue
            fi
            remove_gitignore_line "$CPATH"
            ;;
    esac
done < <(echo "$MANIFEST" | awk '
/^cleanup:/ { in_section=1; next }
/^[a-zA-Z_]+:/ && in_section { exit }
in_section && /^  - path:/ {
    line=$0
    sub(/^  - path:[[:space:]]*/, "", line)
    gsub(/"/, "", line)
    sub(/[[:space:]]*#.*$/, "", line)
    path=line
    next
}
in_section && /^[[:space:]]+type:/ {
    line=$0
    sub(/^[[:space:]]+type:[[:space:]]*/, "", line)
    gsub(/"/, "", line)
    sub(/[[:space:]]*#.*$/, "", line)
    if (path) print path "\t" line
    path=""
    next
}')

# ------------------------------------------------------------------------------
# 8. Housekeeping
# ------------------------------------------------------------------------------
if [ "$MODE" != "dry-run" ]; then
    # Backups must never be committed
    if [ -d "$BACKUP_ROOT" ]; then
        add_gitignore_line "${BACKUP_ROOT}/" >/dev/null || true
    fi

    chmod +x scripts/*.sh 2>/dev/null || true
    chmod +x .devcontainer/*.sh 2>/dev/null || true

    cat > .template-version << EOF
# Template Version Tracker - DO NOT EDIT MANUALLY
# This file tracks which version of the platform template is installed.
version: "$LATEST_VERSION"
migrations_applied: "$LATEST_VERSION"
template_repo: "$TEMPLATE_REPO"
last_updated: "$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"
EOF
fi

# ------------------------------------------------------------------------------
# 9. Epilogue
# ------------------------------------------------------------------------------
if [ "$MODE" = "dry-run" ]; then
    echo ""
    echo "DRY_RUN_COMPLETE|$LATEST_VERSION"
    exit 0
fi

# Activate Claude Code if the template ships it — idempotent: installs only
# what's missing, then starts the router. Runs here so a template update takes
# effect immediately (same session), not just on the next Codespace start.
if [ "$MODE" = "silent" ] && [ -f .devcontainer/setup-claude-router.sh ]; then
    echo ""
    echo "Activating Claude Code..."
    bash .devcontainer/setup-claude-router.sh || true
fi

echo ""
if [ ${#BACKED_UP[@]} -gt 0 ]; then
    echo "Backed up ${#BACKED_UP[@]} user-modified platform file(s) to ${BACKUP_DIR}/:"
    for f in "${BACKED_UP[@]}"; do
        echo "  - $f"
    done
    echo "Review them if you had intentional customizations, then delete the backup."
    echo ""
fi

echo "UPDATE_COMPLETE|$LATEST_VERSION"
echo ""
echo "Updated files to version $LATEST_VERSION"
echo "Your code (frontend/*, backend/*, database/init/*) was NOT touched."

exit 0
}
