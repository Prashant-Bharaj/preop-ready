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

# =============================================================================
# Start Checks
# =============================================================================

echo ""
echo -e "${BLUE}🚀 Vibe Platform Pre-flight Check${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

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
    info "frontend/ folder exists but no Dockerfile — skipping frontend checks (not deploying frontend)"
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

    # Check Dockerfile has non-root user
    if [[ -f "backend/Dockerfile" ]]; then
        if grep -qE "USER (appuser|node|python|rust|app)" backend/Dockerfile; then
            pass "backend/Dockerfile runs as non-root user"
        else
            fail "backend/Dockerfile missing non-root user" "Add USER appuser (see Dockerfile.node or Dockerfile.python for example)"
        fi
    fi

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

    # Check backend routes don't have /api prefix (Traefik strips it)
    # Node.js: app.get('/api/...'), app.post('/api/...')
    for file in backend/server.js backend/index.js backend/app.js; do
        if [[ -f "$file" ]]; then
            if grep -qE "\.(get|post|put|delete|patch)\s*\(\s*['\"]\/api\/" "$file" 2>/dev/null; then
                warn "Backend routes use /api/ prefix in $file - Traefik strips /api, so use routes without it (e.g., '/users' not '/api/users')"
            fi
        fi
    done
    # Python: @app.get("/api/..."), @app.route("/api/...")
    for file in backend/app.py backend/main.py; do
        if [[ -f "$file" ]]; then
            if grep -qE "@app\.(get|post|put|delete|patch|route)\s*\(\s*['\"]\/api\/" "$file" 2>/dev/null; then
                warn "Backend routes use /api/ prefix in $file - Traefik strips /api, so use routes without it (e.g., '/users' not '/api/users')"
            fi
        fi
    done
    # Rust: .route("/api/..."), "/api/" string patterns
    for file in backend/src/main.rs backend/main.rs; do
        if [[ -f "$file" ]]; then
            if grep -qE "['\"]\/api\/" "$file" 2>/dev/null; then
                warn "Backend routes use /api/ prefix in $file - Traefik strips /api, so use routes without it (e.g., '/users' not '/api/users')"
            fi
        fi
    done
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
    echo "  2. Deploy:        git add . && git commit -m 'Ready to deploy' && git push"
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
