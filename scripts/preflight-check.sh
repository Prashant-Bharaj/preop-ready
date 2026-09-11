#!/bin/bash

# =============================================================================
# Vibe Platform Pre-flight Check
# =============================================================================
# Run this before your first deployment to catch common issues.
# Works in Codespaces, local dev, or any bash environment.
#
# Usage: ./scripts/preflight-check.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Helper functions
pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    echo -e "   ${YELLOW}Fix${NC}: $2"
    FAILED=$((FAILED + 1))
}

warn() {
    echo -e "${YELLOW}⚠️  WARN${NC}: $1"
    WARNINGS=$((WARNINGS + 1))
}

info() {
    echo -e "${BLUE}ℹ️  INFO${NC}: $1"
}

header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# nginx_header_inheritance <conf> — print every location block that declares
# an add_header of its own but not the three security headers.
#
# WHY: nginx add_header REPLACES the inherited set, it does not merge. A
# location{} with `add_header Cache-Control ...` inherits NONE of the
# server-level security headers. Grepping the file for "X-Frame-Options"
# therefore proves nothing — the config can contain all three and still serve
# every HTML page and every JS/CSS asset with none of them.
nginx_header_inheritance() {
    local conf="$1"
    [[ -f "$conf" ]] || return 0
    awk '
    function flush(   missing) {
        if (in_loc && has_add) {
            missing = ""
            if (!xfo)  missing = missing " X-Frame-Options"
            if (!xcto) missing = missing " X-Content-Type-Options"
            if (!xss)  missing = missing " X-XSS-Protection"
            if (missing != "") printf "   %s  -> missing:%s\n", loc, missing
        }
        in_loc = 0; loc = ""; has_add = 0; xfo = 0; xcto = 0; xss = 0
    }
    {
        line = $0
        sub(/#.*/, "", line)                       # strip comments
        if (in_loc) {
            if (line ~ /add_header/)                            has_add = 1
            if (line ~ /add_header[ \t]+X-Frame-Options/)        xfo  = 1
            if (line ~ /add_header[ \t]+X-Content-Type-Options/) xcto = 1
            if (line ~ /add_header[ \t]+X-XSS-Protection/)       xss  = 1
        }
        if (!in_loc && line ~ /^[ \t]*location[ \t]/) {
            loc = line
            sub(/^[ \t]*/, "", loc)
            sub(/[ \t]*\{.*$/, "", loc)
            in_loc = 1
            start_depth = depth
        }
        depth += gsub(/\{/, "{", line)
        depth -= gsub(/\}/, "}", line)
        if (in_loc && depth <= start_depth) flush()
    }
    END { flush() }
    ' "$conf"
}

# check_dockerignore <dir> — a build context without a .dockerignore bakes the
# local .env into the image (Docker ignores .gitignore). For the vanilla
# frontend the image is the public web root, so the key is then SERVED.
# The build context is the segment directory, so a root .dockerignore does
# NOT cover it — the per-directory file is the one that counts.
check_dockerignore() {
    local dir="$1"
    if [[ ! -f "$dir/.dockerignore" ]]; then
        fail "$dir/.dockerignore missing — a local .env would be copied into the image" \
             "Create $dir/.dockerignore excluding at least: .env, .env.*, .git, node_modules (copy the template's)"
        return
    fi
    # Must exclude .env itself, not just .env.* — the real secret file is .env
    if grep -qE '^[[:space:]]*\.env[[:space:]]*$' "$dir/.dockerignore"; then
        pass "$dir/.dockerignore excludes .env"
    else
        fail "$dir/.dockerignore does not exclude .env — secrets get baked into the image" \
             "Add a line containing exactly: .env   (and .env.* on the next line)"
    fi
}

# =============================================================================
# Start Checks
# =============================================================================

echo ""
echo -e "${BLUE}🚀 Vibe Platform Pre-flight Check${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# -----------------------------------------------------------------------------
header "📤 Committed vs Local"
# -----------------------------------------------------------------------------
# The deploy builds from the pushed COMMIT, not from your working directory.
# A file that exists on disk but was never committed is invisible to it:
# docker-compose builds it fine, every -f test below passes, and the deploy then
# fails with "No frontend or backend detected" while naming a file you can see
# in your editor. Checking tracked-ness here is what makes the rest of this
# script's file-existence tests mean what they appear to mean.

DEPLOY_DIRS=(frontend backend database vectordb)

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then

    # Dockerfiles are the deploy's component-detection gate. Present-but-untracked
    # is the difference between a component deploying and silently not existing.
    UNTRACKED_DOCKERFILES=""
    for d in "${DEPLOY_DIRS[@]}"; do
        if [[ -f "$d/Dockerfile" ]]; then
            if ! git ls-files --error-unmatch "$d/Dockerfile" > /dev/null 2>&1; then
                UNTRACKED_DOCKERFILES="$UNTRACKED_DOCKERFILES $d/Dockerfile"
            fi
        fi
    done

    if [[ -n "$UNTRACKED_DOCKERFILES" ]]; then
        fail "Dockerfile(s) exist locally but are NOT committed:$UNTRACKED_DOCKERFILES" \
             "The deploy only sees committed files. Run: git add$UNTRACKED_DOCKERFILES"
    else
        pass "Every Dockerfile present on disk is committed"
    fi

    # Everything else inside a build context: app source, package.json,
    # index.html, schema.sql. --exclude-standard omits gitignored paths (.env,
    # node_modules), so whatever remains is genuinely forgotten work.
    EXISTING_DIRS=()
    for d in "${DEPLOY_DIRS[@]}"; do
        if [[ -d "$d" ]]; then
            EXISTING_DIRS+=("$d")
        fi
    done

    if [[ ${#EXISTING_DIRS[@]} -gt 0 ]]; then
        UNTRACKED_FILES=$(git ls-files --others --exclude-standard -- "${EXISTING_DIRS[@]}" 2>/dev/null || true)

        if [[ -n "$UNTRACKED_FILES" ]]; then
            UNTRACKED_COUNT=$(printf '%s\n' "$UNTRACKED_FILES" | wc -l | tr -d ' ')
            fail "$UNTRACKED_COUNT file(s) in build folders are not committed — they will NOT be deployed" \
                 "Review them, then stage by name (never 'git add .')"
            printf '%s\n' "$UNTRACKED_FILES" | head -10 | sed 's/^/     • /'
            if [[ "$UNTRACKED_COUNT" -gt 10 ]]; then
                echo "     … and $((UNTRACKED_COUNT - 10)) more"
            fi
        else
            pass "No uncommitted files in build folders"
        fi

        # Tracked but edited: the deploy would build the older committed content.
        MODIFIED_FILES=$(git diff --name-only HEAD -- "${EXISTING_DIRS[@]}" 2>/dev/null || true)
        if [[ -n "$MODIFIED_FILES" ]]; then
            MODIFIED_COUNT=$(printf '%s\n' "$MODIFIED_FILES" | wc -l | tr -d ' ')
            warn "$MODIFIED_COUNT file(s) have uncommitted edits — the deploy builds the last committed version, not what you see locally"
            printf '%s\n' "$MODIFIED_FILES" | head -5 | sed 's/^/     • /'
        fi
    fi
else
    info "Not a git repository — skipping committed-vs-local checks"
fi

# -----------------------------------------------------------------------------
header "📁 Project Structure"
# -----------------------------------------------------------------------------

# Check if at least one deployable segment exists (Dockerfile required)
if [[ -f "frontend/Dockerfile" ]] || [[ -f "backend/Dockerfile" ]]; then
    pass "Project has deployable frontend and/or backend (Dockerfile found)"
else
    fail "No frontend/Dockerfile or backend/Dockerfile found" "Create at least one Dockerfile to deploy (copy from Dockerfile.* templates)"
fi

# Check frontend structure (only if Dockerfile exists — directory alone is not an error)
if [[ -d "frontend" ]] && [[ ! -f "frontend/Dockerfile" ]]; then
    # App files without a Dockerfile = the frontend silently won't deploy
    if compgen -G "frontend/*.html" > /dev/null || [[ -d "frontend/src" ]]; then
        warn "frontend/ has app files but NO Dockerfile — the frontend will NOT deploy. Copy a template: cp frontend/Dockerfile.vanilla frontend/Dockerfile (or Dockerfile.react)"
    else
        info "frontend/ folder exists but no Dockerfile — skipping frontend checks (not deploying frontend)"
    fi
fi

if [[ -f "frontend/Dockerfile" ]]; then
    info "Frontend segment detected"
    pass "frontend/Dockerfile exists"

    # Check if Dockerfile has FROM
    if grep -q "^FROM " frontend/Dockerfile; then
        pass "frontend/Dockerfile has valid FROM instruction"
    else
        fail "frontend/Dockerfile is invalid" "Add a FROM instruction (e.g., FROM nginx:alpine)"
    fi
    
    if [[ -f "frontend/nginx.conf" ]]; then
        pass "frontend/nginx.conf exists"
        
        # Check nginx.conf doesn't have events or http blocks
        if grep -qE "^events\s*\{" frontend/nginx.conf; then
            fail "nginx.conf has 'events' block" "Remove events{} block - only server{} allowed in conf.d files"
        elif grep -qE "^http\s*\{" frontend/nginx.conf; then
            fail "nginx.conf has 'http' block" "Remove http{} block - only server{} allowed in conf.d files"
        else
            pass "nginx.conf format is valid (no events/http blocks)"
        fi
        
        # Check for health endpoint
        if grep -q "/health" frontend/nginx.conf; then
            pass "nginx.conf has /health endpoint"
        else
            fail "nginx.conf missing /health endpoint" "Add: location /health { return 200 'OK'; }"
        fi

        # Check nginx listens on port 8080 (non-root can't bind port 80)
        if grep -qE "listen\s+8080" frontend/nginx.conf; then
            pass "nginx.conf listens on port 8080"
        elif grep -qE "listen\s+80[^0-9]" frontend/nginx.conf; then
            fail "nginx.conf listens on port 80 (must be 8080)" "Change 'listen 80;' to 'listen 8080;' (non-root user cannot bind port 80)"
        fi

        # Check security headers
        if grep -q "server_tokens off" frontend/nginx.conf; then
            pass "nginx.conf has server_tokens off"
        else
            fail "nginx.conf missing 'server_tokens off'" "Add: server_tokens off;"
        fi

        if grep -q "X-Frame-Options" frontend/nginx.conf; then
            pass "nginx.conf has X-Frame-Options header"
        else
            fail "nginx.conf missing X-Frame-Options header" "Add: add_header X-Frame-Options \"SAMEORIGIN\" always;"
        fi

        if grep -q "X-Content-Type-Options" frontend/nginx.conf; then
            pass "nginx.conf has X-Content-Type-Options header"
        else
            fail "nginx.conf missing X-Content-Type-Options header" "Add: add_header X-Content-Type-Options \"nosniff\" always;"
        fi

        if grep -q "X-XSS-Protection" frontend/nginx.conf; then
            pass "nginx.conf has X-XSS-Protection header"
        else
            fail "nginx.conf missing X-XSS-Protection header" "Add: add_header X-XSS-Protection \"1; mode=block\" always;"
        fi

        # The greps above only prove the directives EXIST somewhere in the file.
        # They pass happily on a config that never actually emits the headers —
        # see nginx_header_inheritance() for why.
        NGINX_BAD_LOCATIONS=$(nginx_header_inheritance frontend/nginx.conf)
        if [[ -n "$NGINX_BAD_LOCATIONS" ]]; then
            fail "nginx.conf location blocks set their own add_header, so they emit NO security headers:
$NGINX_BAD_LOCATIONS" \
                 "nginx add_header is replace-not-merge. Repeat all three security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection) inside each block listed above — see the shipped frontend/nginx.conf."
        else
            pass "nginx.conf security headers survive in every location block"
        fi

        if [[ -f "frontend/nginx.local.conf" ]]; then
            # Local dev only — no production impact, so warn rather than block.
            NGINX_LOCAL_BAD=$(nginx_header_inheritance frontend/nginx.local.conf)
            if [[ -n "$NGINX_LOCAL_BAD" ]]; then
                warn "nginx.local.conf location blocks drop the security headers (local dev only, but it hides the problem you would ship): $(echo "$NGINX_LOCAL_BAD" | tr '\n' ' ')"
            fi
        fi

        # Check for proxy_pass (should NOT be in production nginx.conf)
        if grep -q "proxy_pass" frontend/nginx.conf; then
            fail "nginx.conf has proxy_pass (not allowed in production)" "Remove proxy_pass - Traefik handles API routing. Use nginx.local.conf for local dev."
        else
            pass "nginx.conf has no proxy_pass (correct for production)"
        fi
    else
        fail "frontend/nginx.conf missing" "Create nginx.conf with server block and /health endpoint"
    fi

    # Check Dockerfile has curl (required for ECS health checks)
    if [[ -f "frontend/Dockerfile" ]]; then
        if grep -q "curl" frontend/Dockerfile; then
            pass "frontend/Dockerfile installs curl (required for ECS health checks)"
        else
            fail "frontend/Dockerfile missing curl" "Add: RUN apk add --no-cache curl"
        fi

        # Check Dockerfile has non-root user
        if grep -q "USER appuser" frontend/Dockerfile; then
            pass "frontend/Dockerfile runs as non-root user"
        else
            fail "frontend/Dockerfile missing non-root user" "Add USER appuser (see Dockerfile.vanilla or Dockerfile.react for example)"
        fi
    fi

    check_dockerignore "frontend"
fi

# Check backend structure (only if Dockerfile exists — directory alone is not an error)
if [[ -d "backend" ]] && [[ ! -f "backend/Dockerfile" ]]; then
    info "backend/ folder exists but no Dockerfile — skipping backend checks (not deploying backend)"
fi

if [[ -f "backend/Dockerfile" ]]; then
    info "Backend segment detected"
    pass "backend/Dockerfile exists"

    if grep -q "^FROM " backend/Dockerfile; then
        pass "backend/Dockerfile has valid FROM instruction"
    else
        fail "backend/Dockerfile is invalid" "Add a FROM instruction (e.g., FROM node:22-alpine)"
    fi
    
    # Check for health endpoint in common backend files
    HEALTH_FOUND=false
    for file in backend/server.js backend/index.js backend/app.js backend/app.py backend/main.py backend/src/main.rs backend/main.rs; do
        if [[ -f "$file" ]] && grep -q "/health" "$file"; then
            HEALTH_FOUND=true
            break
        fi
    done
    
    if [[ "$HEALTH_FOUND" == "true" ]]; then
        pass "Backend has /health endpoint"
    else
        warn "Could not verify backend /health endpoint - make sure it exists!"
    fi
    
    # Check port 3000
    for file in backend/server.js backend/index.js backend/app.js backend/main.py backend/app.py backend/src/main.rs backend/main.rs; do
        if [[ -f "$file" ]]; then
            if grep -qE "(3000|PORT)" "$file"; then
                pass "Backend appears to use port 3000"
            else
                warn "Could not verify backend uses port 3000 - deployment requires port 3000"
            fi
            break
        fi
    done

    # /api prefix in backend routes = guaranteed 404 in production.
    # Traefik (prod) and nginx.local.conf (local) strip /api before the request
    # reaches the backend: frontend calls /api/users -> backend must define /users.
    API_PREFIX_HITS=$(grep -rnE \
        "(app|router)\.(get|post|put|delete|patch|use)\(\s*['\"]/api|@app\.(get|post|put|delete|patch|route)\(\s*['\"]/api|web::(resource|scope)\(\s*\"/api" \
        backend --include="*.js" --include="*.py" --include="*.rs" \
        --exclude-dir=node_modules --exclude-dir=target 2>/dev/null \
        | grep -vE "^[^:]+:[0-9]+:\s*(\*|//|#)" || true)
    if [[ -n "$API_PREFIX_HITS" ]]; then
        fail "Backend routes defined WITH /api prefix — these will 404 (the /api prefix is stripped before reaching the backend)" \
             "Remove the prefix: app.get('/api/users') -> app.get('/users'). Found:
$API_PREFIX_HITS"
    else
        pass "No /api-prefixed routes in backend code"
    fi

    # Hardcoded secret-shaped literals in app code (incl. sneaky || 'sk-...'
    # fallbacks). Conservative patterns to avoid false positives.
    SECRET_LITERALS=$(grep -rnE "['\"](sk-|mga-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{5,}['\"]" \
        backend frontend --include="*.js" --include="*.py" --include="*.html" \
        --exclude-dir=node_modules 2>/dev/null || true)
    if [[ -n "$SECRET_LITERALS" ]]; then
        fail "Hardcoded API-key-shaped literals in app code (fallback defaults count too):
$SECRET_LITERALS" \
             "Remove the literal; use process.env.X / os.getenv(\"X\") with the APP_* GitHub secret flow. Missing config must degrade to a mock, never to a hardcoded key."
    else
        pass "No hardcoded API-key literals in app code"
    fi

    # Migration files outside backend/migrations/ can NEVER run: the backend
    # image contains only backend/, so database/migrations/ or a repo-root
    # migrations/ dir are invisible to the runner (locally AND deployed).
    MISPLACED_MIGRATIONS=$(find database migrations -name "*.sql" -type f 2>/dev/null \
        | grep -vE "^database/(init|seed)/" || true)
    if [[ -n "$MISPLACED_MIGRATIONS" ]]; then
        fail "Migration .sql files outside backend/migrations/ — the backend container cannot see them, they will NEVER run:
$MISPLACED_MIGRATIONS" \
             "Move them: mkdir -p backend/migrations && git mv <file> backend/migrations/ — then rebuild: docker compose up -d --build backend"
    else
        pass "No misplaced migration files"
    fi

    # Migration files exist but no runner wired = they also never run
    if compgen -G "backend/migrations/*.sql" > /dev/null; then
        if grep -rqE "runMigrations|run_migrations" backend --include="*.ts" --include="*.js" --include="*.py" \
             --exclude-dir=node_modules --exclude-dir=migrations --exclude-dir=dist 2>/dev/null; then
            pass "Migration runner is wired into the backend"
        else
            fail "backend/migrations/ has .sql files but no runner is wired into the backend code" \
                 "Node: backend/src/lib/migrate.ts is staged by the harness (or copy snippets/database/migration-runner.ts) — call 'await runMigrations(pool)' before app.listen. Python: copy snippets/config/db-migrations.js logic into a run_migrations() called at startup."
        fi
        if [[ -f "backend/Dockerfile" ]] && grep -q "^FROM .* AS builder" backend/Dockerfile \
             && ! grep -qE "COPY --from=builder .*/migrations" backend/Dockerfile; then
            fail "backend/Dockerfile is multi-stage but never copies migrations/ into the runtime image — the runner finds nothing" \
                 "Add: COPY --from=builder --chown=appuser:appgroup /app/migrations ./migrations (see backend/Dockerfile.node)"
        fi
    fi

    # Check Dockerfile has non-root user
    if [[ -f "backend/Dockerfile" ]]; then
        if grep -qE "USER (appuser|node|python|rust|app)" backend/Dockerfile; then
            pass "backend/Dockerfile runs as non-root user"
        else
            fail "backend/Dockerfile missing non-root user" "Add USER appuser (see Dockerfile.node or Dockerfile.python for example)"
        fi
    fi

    check_dockerignore "backend"

    # Check for hardcoded localhost URLs in frontend code (breaks in production)
    HARDCODED_FOUND=false
    for file in $(find frontend/src frontend/ -maxdepth 3 -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.html" 2>/dev/null); do
        if grep -qE "https?://localhost" "$file" 2>/dev/null; then
            HARDCODED_FOUND=true
            warn "Hardcoded localhost URL found in $file - use relative URLs (e.g., fetch('/api/...'))"
        fi
    done
    if [[ "$HARDCODED_FOUND" == "false" ]] && [[ -d "frontend" ]]; then
        pass "No hardcoded localhost URLs in frontend code"
    fi

    # (route /api-prefix violations are FAILED above with file:line detail)
fi

# Check vectordb structure (optional, for dual-database setups)
if [[ -d "vectordb" ]] && [[ ! -f "vectordb/Dockerfile" ]]; then
    info "vectordb/ folder exists but no Dockerfile — skipping vectordb checks (not using vector database)"
fi

if [[ -d "vectordb" ]] && [[ -f "vectordb/Dockerfile" ]]; then
    info "Vector database segment detected (dual-database setup)"
    pass "vectordb/Dockerfile exists"

    if grep -q "^FROM " vectordb/Dockerfile; then
        pass "vectordb/Dockerfile has valid FROM instruction"
    else
        fail "vectordb/Dockerfile is invalid" "Add a FROM instruction (copy from vectordb/Dockerfile.chroma, .qdrant, or .pgvector)"
    fi

    # Check if pgvector and init.sql has CREATE EXTENSION
    if grep -q "pgvector" vectordb/Dockerfile; then
        if [[ -f "vectordb/init/init.sql" ]]; then
            if grep -q "CREATE EXTENSION" vectordb/init/init.sql; then
                pass "vectordb/init/init.sql enables vector extension"
            else
                warn "vectordb/init/init.sql should have: CREATE EXTENSION IF NOT EXISTS vector;"
            fi
        else
            warn "vectordb/init/init.sql missing - pgvector needs init script with CREATE EXTENSION"
        fi
    fi

    if [[ ! -f "backend/Dockerfile" ]]; then
        warn "vectordb/ exists but no backend/Dockerfile - backend is needed to connect to the vector database"
    fi
fi

# Check database structure (optional)
if [[ -d "database" ]] && [[ ! -f "database/Dockerfile" ]]; then
    info "database/ folder exists but no Dockerfile — skipping database checks (not using database)"
fi

if [[ -d "database" ]] && [[ -f "database/Dockerfile" ]]; then
    info "Database segment detected"

    if grep -q "^FROM " database/Dockerfile; then
        pass "database/Dockerfile has valid FROM instruction"
    else
        fail "database/Dockerfile is invalid" "Add a FROM instruction (copy from database/Dockerfile.postgres or .mysql)"
    fi

    # Check for HEALTHCHECK in Dockerfile
    if grep -q "HEALTHCHECK" database/Dockerfile; then
        pass "database/Dockerfile has HEALTHCHECK"
    else
        fail "database/Dockerfile missing HEALTHCHECK" "Add HEALTHCHECK instruction (see Dockerfile.postgres or .mysql templates)"
    fi
fi

# -----------------------------------------------------------------------------
header "🔐 Security Checks"
# -----------------------------------------------------------------------------

# Check for committed .env files
if git ls-files --error-unmatch .env backend/.env frontend/.env 2>/dev/null | grep -q ".env"; then
    fail "Secret .env file(s) committed to git" "Run: git rm --cached .env backend/.env frontend/.env"
else
    pass "No .env files committed to git"
fi

# Check for deprecated chat/ directory
if [[ -d "chat" ]]; then
    warn "Deprecated chat/ directory found - run template sync to remove it"
fi

# -----------------------------------------------------------------------------
header "🔧 Configuration Files"
# -----------------------------------------------------------------------------

# Check docker-compose.yml
if [[ -f "docker-compose.yml" ]]; then
    pass "docker-compose.yml exists"

    # Check nginx.local.conf volume mount for local API proxy
    if [[ -f "frontend/Dockerfile" ]] && [[ -f "backend/Dockerfile" ]]; then
        if grep -q "nginx.local.conf" docker-compose.yml; then
            pass "docker-compose.yml mounts nginx.local.conf for local API proxy"
        else
            warn "docker-compose.yml missing nginx.local.conf volume mount - local /api/ proxy won't work"
        fi
    fi

    # Validate docker-compose services match project structure
    if [[ -d "database" ]] && [[ -f "database/Dockerfile" ]]; then
        if grep -qE '^\s+(db|database):' docker-compose.yml; then
            pass "docker-compose.yml has database service matching database/Dockerfile"
        else
            fail "database/Dockerfile exists but docker-compose.yml has no db/database service" "Add a 'db' service to docker-compose.yml for local development"
        fi
    fi

    if [[ -d "vectordb" ]] && [[ -f "vectordb/Dockerfile" ]]; then
        if grep -qE '^\s+vectordb:' docker-compose.yml; then
            pass "docker-compose.yml has vectordb service matching vectordb/Dockerfile"
        else
            fail "vectordb/Dockerfile exists but docker-compose.yml has no vectordb service" "Add a 'vectordb' service to docker-compose.yml for local development"
        fi
    fi

    # Warn if frontend-only project has proxy_pass in nginx config
    if [[ -f "frontend/Dockerfile" ]] && [[ ! -f "backend/Dockerfile" ]]; then
        if [[ -f "frontend/nginx.local.conf" ]] && grep -q "proxy_pass" frontend/nginx.local.conf; then
            warn "No backend/ folder but nginx.local.conf has proxy_pass - this will 502 locally"
        fi
    fi
else
    fail "docker-compose.yml missing" "Create docker-compose.yml for local development"
fi

# Check deploy workflow
if [[ -f ".github/workflows/deploy.yml" ]]; then
    pass ".github/workflows/deploy.yml exists"
else
    fail "Deploy workflow missing" "This should exist in the template - check .github/workflows/"
fi

# Code scanning gate.
# deploy.yml is triggered by `workflow_run: workflows: ["CodeQL"]`, and that
# "CodeQL" workflow is GitHub's own code-scanning DEFAULT SETUP — it is
# deliberately not a file in this repo (a second CodeQL workflow cannot coexist
# with default setup). If code scanning is off, nothing ever emits the event,
# so pushes silently never deploy and no error appears anywhere.
#
# WARN only, never fail: this needs an authenticated gh CLI and admin rights on
# the repo, and neither is guaranteed in a hackathon Codespace.
if ! command -v gh &> /dev/null; then
    info "gh CLI not available — skipping the code-scanning check (deploy needs GitHub's CodeQL default setup to be enabled)"
elif ! gh auth status &> /dev/null; then
    info "gh CLI not authenticated — skipping the code-scanning check (run: gh auth login)"
else
    REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    if [[ -z "$REPO_SLUG" ]]; then
        info "Could not determine the GitHub repo — skipping the code-scanning check"
    else
        SCAN_STATE=$(gh api "repos/${REPO_SLUG}/code-scanning/default-setup" -q .state 2>/dev/null || true)
        case "$SCAN_STATE" in
            configured)
                pass "Code scanning (CodeQL default setup) is enabled — deploy.yml can be triggered"
                ;;
            not-configured)
                warn "Code scanning is OFF for ${REPO_SLUG}. deploy.yml only runs after a \"CodeQL\" workflow_run, which ONLY GitHub's default setup emits — with it off your pushes will never deploy and nothing will report an error. Enable it: Settings > Code security > Code scanning > CodeQL analysis > Set up > Default"
                ;;
            *)
                info "Could not read the code-scanning status for ${REPO_SLUG} (needs admin rights) — if a push never deploys, check Settings > Code security > Code scanning first"
                ;;
        esac
    fi
fi

# Check .template-version
if [[ -f ".template-version" ]]; then
    pass ".template-version exists"
    VERSION=$(grep "^version:" .template-version | cut -d'"' -f2)
    info "Template version: $VERSION"
else
    warn ".template-version missing - auto-updates won't work"
fi

# -----------------------------------------------------------------------------
header "🐳 Docker Check"
# -----------------------------------------------------------------------------

# Check if Docker is available
if command -v docker &> /dev/null; then
    pass "Docker is installed"
    
    # Check if Docker daemon is running
    if docker info &> /dev/null; then
        pass "Docker daemon is running"
    else
        fail "Docker daemon not running" "Start Docker or Docker Desktop"
    fi
else
    fail "Docker not installed" "Install Docker or use GitHub Codespaces"
fi

# Check if docker-compose is available
if command -v docker-compose &> /dev/null || docker compose version &> /dev/null 2>&1; then
    pass "docker-compose is available"
else
    fail "docker-compose not available" "Install docker-compose or update Docker"
fi

# -----------------------------------------------------------------------------
header "📋 Summary"
# -----------------------------------------------------------------------------

echo ""
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}, ${YELLOW}$WARNINGS warnings${NC}"
echo ""

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  ✅ All checks passed! You're ready to deploy.${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Test locally:  docker-compose up --build"
    echo "  2. Deploy:        git add <your changed files> && git commit -m 'Ready to deploy' && git push"
    echo "                    (stage specific files by name — never 'git add .')"
    echo ""
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ❌ $FAILED issue(s) found. Fix them before deploying.${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Ask your AI assistant: 'Can you help fix the preflight check issues?'"
    echo ""
    exit 1
fi
