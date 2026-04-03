#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Pre-Commit Security Check                                      ║
# ║  Scans staged files for sensitive data before allowing commit.   ║
# ║  ⛔ AI agents: DO NOT modify this file.                          ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Phase 1: Filename scan — blocks sensitive file types
# Phase 2: Secret content scan — blocks hardcoded secrets
# Phase 3: Seed data scan — flags real data in SQL/fixture files
#
# Install: ./scripts/install-hooks.sh
# Bypass:  git commit --no-verify  (use rarely, only when certain)

# Note: NOT using set -e because grep returns 1 on no match, which is expected.
set -uo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m' # No Color

BLOCKED_FILES=()
WARNED_FILES=()

# Get list of staged files (added or modified, not deleted)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

# ============================================================
# PHASE 1: Filename scan — sensitive file types
# ============================================================

while IFS= read -r file; do
    [ -z "$file" ] && continue
    basename=$(basename "$file")
    dirname=$(dirname "$file")

    # Environment files — ALL blocked, including .env.example
    # Matches: .env, .env.local, .env.example, env.example, backend/.env, etc.
    if [[ "$basename" == .env || "$basename" == .env.* || "$basename" == env.example || "$basename" == *.env.example ]]; then
        BLOCKED_FILES+=("$file|Environment file — must not be committed. Create .env locally (gitignored).")
        continue
    fi

    # Cryptographic material
    case "$basename" in
        *.pem|*.key|*.cert|*.crt|*.p12|*.pfx|*.jks|*.keystore)
            BLOCKED_FILES+=("$file|Cryptographic material — private keys and certificates must never be committed.")
            continue
            ;;
    esac

    # Credential files
    case "$basename" in
        *.secret|credentials.json|service-account*.json)
            BLOCKED_FILES+=("$file|Credential file — contains authentication secrets.")
            continue
            ;;
    esac

    # Documents & data files
    case "$basename" in
        *.pdf|*.doc|*.docx|*.xls|*.xlsx|*.ppt|*.pptx)
            BLOCKED_FILES+=("$file|Document file — may contain confidential content. Use context/ folder for reference data.")
            continue
            ;;
        *.csv|*.tsv|*.parquet|*.avro)
            BLOCKED_FILES+=("$file|Data file — may contain sensitive records. Use context/ folder for reference data.")
            continue
            ;;
    esac

    # Local database files
    case "$basename" in
        *.sqlite|*.sqlite3|*.db)
            BLOCKED_FILES+=("$file|Local database file — may contain sensitive data.")
            continue
            ;;
    esac

    # Image files outside frontend/
    case "$basename" in
        *.png|*.jpg|*.jpeg|*.gif|*.bmp|*.ico|*.svg|*.webp|*.tiff|*.tif)
            if [[ "$file" != frontend/* ]]; then
                BLOCKED_FILES+=("$file|Image file outside frontend/ — only frontend app assets are allowed in git.")
            fi
            continue
            ;;
    esac

    # Media files
    case "$basename" in
        *.mp4|*.mp3|*.wav|*.mov|*.avi|*.webm)
            BLOCKED_FILES+=("$file|Media file — binary media should not be committed.")
            continue
            ;;
    esac

    # Archives
    case "$basename" in
        *.zip|*.tar.gz|*.tar|*.rar|*.7z|*.gz|*.bz2)
            BLOCKED_FILES+=("$file|Archive file — compressed files should not be committed.")
            continue
            ;;
    esac

    # Blocked directories
    case "$file" in
        data/*|uploads/*|exports/*|secrets/*|.secrets/*)
            BLOCKED_FILES+=("$file|File in blocked directory — data directories must not be committed.")
            continue
            ;;
        database/seed/*)
            if [[ "$basename" != ".gitkeep" ]]; then
                BLOCKED_FILES+=("$file|Seed data file — database/seed/ is for local test data only (gitignored).")
            fi
            continue
            ;;
    esac

done <<< "$STAGED_FILES"

# ============================================================
# PHASE 2: Secret content scan — hardcoded secrets
# ============================================================

while IFS= read -r file; do
    [ -z "$file" ] && continue

    # Skip binary files, already-blocked files, and the hook script itself
    case "$file" in
        *.png|*.jpg|*.jpeg|*.gif|*.bmp|*.ico|*.svg|*.webp|*.pdf|*.doc|*.docx|*.xls|*.xlsx|*.ppt|*.pptx|*.zip|*.tar*|*.gz|*.rar|*.7z|*.mp4|*.mp3|*.wav|*.mov|*.db|*.sqlite*)
            continue
            ;;
        scripts/pre-commit-security-check.sh|scripts/install-hooks.sh)
            continue
            ;;
    esac

    # Get staged file content
    content=$(git show ":$file" 2>/dev/null || true)
    [ -z "$content" ] && continue

    # Private keys
    if echo "$content" | grep -q -- '-----BEGIN.*PRIVATE KEY-----'; then
        BLOCKED_FILES+=("$file|Contains a private key — cryptographic keys must never be committed.")
    fi

    # AWS access keys
    if echo "$content" | grep -qE 'AKIA[0-9A-Z]{16}'; then
        BLOCKED_FILES+=("$file|Contains what looks like an AWS access key (AKIA...).")
    fi

    # Hardcoded passwords (common patterns like password = "secret123")
    if echo "$content" | grep -qiE '(password|passwd|pwd)[[:space:]]*[:=][[:space:]]*["\x27][^"\x27]{8,}["\x27]'; then
        BLOCKED_FILES+=("$file|Contains what looks like a hardcoded password. Use environment variables instead.")
    fi

    # Docker-compose / YAML inline credentials (e.g. MYSQL_PASSWORD=realvalue, POSTGRES_PASSWORD=realvalue)
    case "$basename" in
        docker-compose*.yml|docker-compose*.yaml|compose*.yml|compose*.yaml)
            if echo "$content" | grep -qiE '_PASSWORD[=:][[:space:]]*[^$\{]'; then
                WARNED_FILES+=("$file|Contains inline password values. Use env_file to reference a gitignored .env file instead of hardcoding credentials in docker-compose.")
            fi
            ;;
    esac

done <<< "$STAGED_FILES"

# ============================================================
# PHASE 3: Seed data scan — real data in SQL/fixture files
# ============================================================

while IFS= read -r file; do
    [ -z "$file" ] && continue

    case "$file" in
        database/init/*|*/seed/*|*/fixtures/*|*/seed.sql|*/fixture*.json|*/seed*.json)
            ;;
        *.sql)
            ;;
        *)
            continue
            ;;
    esac

    content=$(git show ":$file" 2>/dev/null || true)
    [ -z "$content" ] && continue

    # Corporate email domains in data
    if echo "$content" | grep -qiE '@bayer\.(com|cnb)|@monsanto\.com|@bayer\.cnb'; then
        WARNED_FILES+=("$file|Contains Bayer/Monsanto email addresses — this looks like real corporate data, not test data.")
    fi

    # Bulk INSERT detection (>10 VALUE rows in a single INSERT)
    # Count consecutive lines with VALUES/value patterns after an INSERT
    insert_count=$(echo "$content" | grep -ciE '^\s*\(' | head -1 || true)
    if echo "$content" | grep -qiE 'INSERT\s+INTO'; then
        # Count value rows (lines starting with parentheses after INSERT)
        value_rows=$(echo "$content" | awk '
            /INSERT[[:space:]]+INTO/,/;/ {
                if (/^\s*\(/) count++
            }
            END { print count+0 }
        ')
        if [ "$value_rows" -gt 10 ]; then
            WARNED_FILES+=("$file|Contains INSERT with $value_rows data rows — this looks like bulk data, not hand-written test fixtures. Use database/seed/ for test data (gitignored).")
        fi
    fi

    # Check for INSERT in database/init/ (should be schema only)
    if [[ "$file" == database/init/* ]]; then
        init_insert_rows=$(echo "$content" | awk '
            /INSERT[[:space:]]+INTO/,/;/ {
                if (/^\s*\(/) count++
            }
            END { print count+0 }
        ')
        if [ "$init_insert_rows" -gt 3 ]; then
            WARNED_FILES+=("$file|database/init/ should contain schema only (CREATE TABLE). Found INSERT with $init_insert_rows rows. Move data to database/seed/ (gitignored).")
        fi
    fi

    # IBAN patterns in data
    if echo "$content" | grep -qE '[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7,}'; then
        WARNED_FILES+=("$file|Contains what looks like IBAN numbers — this may be real financial data.")
    fi

done <<< "$STAGED_FILES"

# ============================================================
# PHASE 4: Dangerous logging patterns (warn, not block)
# ============================================================

while IFS= read -r file; do
    [ -z "$file" ] && continue

    # Only check JS/TS and Python source files
    case "$file" in
        *.js|*.ts|*.jsx|*.tsx|*.py)
            ;;
        *)
            continue
            ;;
    esac

    # Skip hook scripts, node_modules, test files
    case "$file" in
        scripts/pre-commit-security-check.sh|scripts/install-hooks.sh)
            continue
            ;;
        */node_modules/*|*test*|*spec*|*.test.*|*.spec.*)
            continue
            ;;
    esac

    content=$(git show ":$file" 2>/dev/null || true)
    [ -z "$content" ] && continue

    # JS/TS: logging request body, headers, files, or secrets
    if echo "$content" | grep -qE 'console\.(log|info|debug|warn)\(.*req\.(body|headers|file[s]?)'; then
        WARNED_FILES+=("$file|Logs request payload/headers/files — remove debug logging before committing. See .clinerules/18-security.md § Logging Restrictions.")
    fi

    # JS/TS: logging variables named password, secret, token, key
    if echo "$content" | grep -qiE 'console\.(log|info|debug|warn)\(.*\b(password|secret|token|apiKey|api_key)\b'; then
        WARNED_FILES+=("$file|Logs sensitive variable (password/secret/token/key) — redact before committing.")
    fi

    # Python: logging request body, headers
    if echo "$content" | grep -qE '(print|logger\.\w+)\(.*request\.(body|headers|json|files)'; then
        WARNED_FILES+=("$file|Logs request payload/headers — remove debug logging before committing. See .clinerules/18-security.md § Logging Restrictions.")
    fi

    # Python: logging variables named password, secret, token
    if echo "$content" | grep -qiE '(print|logger\.\w+)\(.*\b(password|secret|token|api_key)\b'; then
        WARNED_FILES+=("$file|Logs sensitive variable (password/secret/token) — redact before committing.")
    fi

done <<< "$STAGED_FILES"

# ============================================================
# OUTPUT RESULTS
# ============================================================

if [ ${#BLOCKED_FILES[@]} -eq 0 ] && [ ${#WARNED_FILES[@]} -eq 0 ]; then
    exit 0
fi

echo ""
echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║  🚫 COMMIT BLOCKED — Sensitive content detected!           ║${NC}"
echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"

if [ ${#BLOCKED_FILES[@]} -gt 0 ]; then
    echo -e "${RED}║                                                              ║${NC}"
    echo -e "${RED}║  ${BOLD}Blocked files:${NC}${RED}                                               ║${NC}"
    echo -e "${RED}║                                                              ║${NC}"
    for entry in "${BLOCKED_FILES[@]}"; do
        file="${entry%%|*}"
        reason="${entry#*|}"
        echo -e "${RED}║${NC}  ${RED}❌ ${BOLD}$file${NC}"
        echo -e "${RED}║${NC}     → $reason"
        echo -e "${RED}║${NC}"
    done
fi

if [ ${#WARNED_FILES[@]} -gt 0 ]; then
    echo -e "${RED}║                                                              ║${NC}"
    echo -e "${YELLOW}║  ${BOLD}Warnings (possible real data):${NC}${RED}                                ║${NC}"
    echo -e "${RED}║                                                              ║${NC}"
    for entry in "${WARNED_FILES[@]}"; do
        file="${entry%%|*}"
        reason="${entry#*|}"
        echo -e "${RED}║${NC}  ${YELLOW}⚠️  ${BOLD}$file${NC}"
        echo -e "${RED}║${NC}     → $reason"
        echo -e "${RED}║${NC}"
    done
fi

echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${RED}║                                                              ║${NC}"
echo -e "${RED}║${NC}  ${BOLD}How to fix:${NC}                                                ${RED}║${NC}"
echo -e "${RED}║${NC}    git reset HEAD <file>     Remove file from staging        ${RED}║${NC}"
echo -e "${RED}║${NC}    git rm --cached <file>    Untrack a tracked file          ${RED}║${NC}"
echo -e "${RED}║${NC}                                                              ${RED}║${NC}"
echo -e "${RED}║${NC}  ${BOLD}Safe locations for sensitive data:${NC}                          ${RED}║${NC}"
echo -e "${RED}║${NC}    context/                  Reference data (gitignored)     ${RED}║${NC}"
echo -e "${RED}║${NC}    database/seed/            Test data (gitignored)          ${RED}║${NC}"
echo -e "${RED}║${NC}                                                              ${RED}║${NC}"
echo -e "${RED}║${NC}  ${BOLD}False positive?${NC}                                              ${RED}║${NC}"
echo -e "${RED}║${NC}    git commit --no-verify    Bypass this check (use rarely)  ${RED}║${NC}"
echo -e "${RED}║                                                              ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

exit 1
