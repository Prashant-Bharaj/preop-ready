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
    ((PASSED++))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    echo -e "   ${YELLOW}Fix${NC}: $2"
    ((FAILED++))
}

warn() {
    echo -e "${YELLOW}⚠️  WARN${NC}: $1"
    ((WARNINGS++))
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

# Check if at least frontend or backend exists
if [[ -d "frontend" ]] || [[ -d "backend" ]]; then
    pass "Project has frontend and/or backend folder"
else
    fail "No frontend/ or backend/ folder found" "Create at least one: mkdir frontend"
fi

# Check frontend structure
if [[ -d "frontend" ]]; then
    info "Frontend folder detected"
    
    if [[ -f "frontend/Dockerfile" ]]; then
        pass "frontend/Dockerfile exists"
        
        # Check if Dockerfile has FROM
        if grep -q "^FROM " frontend/Dockerfile; then
            pass "frontend/Dockerfile has valid FROM instruction"
        else
            fail "frontend/Dockerfile is invalid" "Add a FROM instruction (e.g., FROM nginx:alpine)"
        fi
    else
        fail "frontend/Dockerfile missing" "Copy Dockerfile.vanilla or Dockerfile.react to frontend/Dockerfile"
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
    else
        fail "frontend/nginx.conf missing" "Create nginx.conf with server block and /health endpoint"
    fi
fi

# Check backend structure
if [[ -d "backend" ]]; then
    info "Backend folder detected"
    
    if [[ -f "backend/Dockerfile" ]]; then
        pass "backend/Dockerfile exists"
        
        if grep -q "^FROM " backend/Dockerfile; then
            pass "backend/Dockerfile has valid FROM instruction"
        else
            fail "backend/Dockerfile is invalid" "Add a FROM instruction (e.g., FROM node:20-alpine)"
        fi
    else
        fail "backend/Dockerfile missing" "Copy Dockerfile.node or Dockerfile.python to backend/Dockerfile"
    fi
    
    # Check for health endpoint in common backend files
    HEALTH_FOUND=false
    for file in backend/server.js backend/index.js backend/app.js backend/app.py backend/main.py; do
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
    for file in backend/server.js backend/index.js backend/app.js; do
        if [[ -f "$file" ]]; then
            if grep -qE "(3000|PORT)" "$file"; then
                pass "Backend appears to use port 3000"
            else
                warn "Could not verify backend uses port 3000 - deployment requires port 3000"
            fi
            break
        fi
    done
fi

# Check vectordb structure (optional, for dual-database setups)
if [[ -d "vectordb" ]]; then
    info "Vector database folder detected (dual-database setup)"

    if [[ -f "vectordb/Dockerfile" ]]; then
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
    else
        fail "vectordb/Dockerfile missing" "Copy Dockerfile.chroma, .qdrant, or .pgvector to vectordb/Dockerfile"
    fi

    if [[ ! -d "backend" ]]; then
        warn "vectordb/ exists but no backend/ - backend is needed to connect to the vector database"
    fi
fi

# -----------------------------------------------------------------------------
header "🔧 Configuration Files"
# -----------------------------------------------------------------------------

# Check docker-compose.yml
if [[ -f "docker-compose.yml" ]]; then
    pass "docker-compose.yml exists"
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
