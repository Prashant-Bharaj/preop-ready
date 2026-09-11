#!/bin/bash
# ==============================================================================
# Detect this project's stack — one line per layer, machine-readable.
#
# Usage: bash scripts/detect-stack.sh
#
# Output (stdout contract; consumed by apply-updates.sh and the migration
# skill — keep the tokens stable):
#   backend=<node-ts|node-js|python|rust|none>
#   frontend=<react-ts|react-js|vanilla|next|angular|none>
#   database=<postgres|mysql|none>
#   vectordb=<pgvector|chroma|qdrant|none>
#   retired=<comma-separated list of retired layers, or none>
#
# Mirrors the platform's own deploy detection: a layer counts only when
# <dir>/Dockerfile exists with a FROM line (the template ships comment-only
# placeholders plus Dockerfile.<variant> files, which do not count). Source
# files break ties for the backend language.
#
# "retired" = stacks the template stopped supporting in v2.0 (vanilla frontend,
# MySQL, Chroma, Qdrant). A project on one keeps receiving additive platform
# updates but is held on its current rules until migrated — see
# .platform-rules/scope-migration.md.
# ==============================================================================

set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0

from_line() {
    # first FROM image of a real Dockerfile, lowercased; empty when absent
    [ -f "$1" ] || return 0
    grep -m1 -iE '^[[:space:]]*FROM[[:space:]]' "$1" 2>/dev/null | tr '[:upper:]' '[:lower:]'
}

# ── backend ───────────────────────────────────────────────────────────────────
BACKEND=none
BF=$(from_line backend/Dockerfile)
if [ -n "$BF" ]; then
    case "$BF" in
        *python*)  BACKEND=python ;;
        *rust*|*cargo*) BACKEND=rust ;;
        *node*|*bun*|*deno*) BACKEND=node-js ;;
    esac
fi
if [ "$BACKEND" = "none" ]; then
    if [ -f backend/main.py ] || [ -f backend/src/main.py ] || [ -f backend/requirements.txt ]; then BACKEND=python
    elif [ -f backend/Cargo.toml ]; then BACKEND=rust
    elif [ -f backend/package.json ]; then BACKEND=node-js
    fi
fi
if [ "$BACKEND" = "node-js" ]; then
    if [ -f backend/tsconfig.json ] || [ -f backend/src/index.ts ] || ls backend/src/*.ts >/dev/null 2>&1; then
        BACKEND=node-ts
    fi
fi

# ── frontend ──────────────────────────────────────────────────────────────────
FRONTEND=none
if [ -f frontend/package.json ]; then
    if grep -q '"next"' frontend/package.json; then FRONTEND=next
    elif grep -q '"@angular/core"' frontend/package.json; then FRONTEND=angular
    elif grep -q '"react"' frontend/package.json; then
        if [ -f frontend/tsconfig.json ] || ls frontend/src/*.tsx >/dev/null 2>&1; then FRONTEND=react-ts; else FRONTEND=react-js; fi
    else FRONTEND=vanilla
    fi
elif [ -f frontend/index.html ]; then
    FRONTEND=vanilla
elif [ -n "$(from_line frontend/Dockerfile)" ]; then
    FRONTEND=vanilla
fi

# ── database ──────────────────────────────────────────────────────────────────
DATABASE=none
DF=$(from_line database/Dockerfile)
case "$DF" in
    *mysql*|*mariadb*) DATABASE=mysql ;;
    *pgvector*|*postgres*) DATABASE=postgres ;;
esac

# ── vectordb ──────────────────────────────────────────────────────────────────
VECTORDB=none
VF=$(from_line vectordb/Dockerfile)
case "$VF" in
    *chroma*)  VECTORDB=chroma ;;
    *qdrant*)  VECTORDB=qdrant ;;
    *pgvector*|*postgres*) VECTORDB=pgvector ;;
esac
# A parameterised Dockerfile may hide the image behind an ARG; the local
# compose file then tells the truth about what actually runs.
if [ "$VECTORDB" = "none" ] && [ -f docker-compose.yml ]; then
    if grep -vE '^[[:space:]]*#' docker-compose.yml | grep -qiE 'image:[[:space:]]*.*chroma'; then VECTORDB=chroma
    elif grep -vE '^[[:space:]]*#' docker-compose.yml | grep -qiE 'image:[[:space:]]*.*qdrant'; then VECTORDB=qdrant
    fi
fi

# ── retired layers ────────────────────────────────────────────────────────────
RETIRED=""
[ "$FRONTEND" = "vanilla" ] && RETIRED="${RETIRED:+$RETIRED,}frontend=vanilla"
[ "$DATABASE" = "mysql" ]   && RETIRED="${RETIRED:+$RETIRED,}database=mysql"
case "$VECTORDB" in chroma|qdrant) RETIRED="${RETIRED:+$RETIRED,}vectordb=$VECTORDB" ;; esac

echo "backend=$BACKEND"
echo "frontend=$FRONTEND"
echo "database=$DATABASE"
echo "vectordb=$VECTORDB"
echo "retired=${RETIRED:-none}"
exit 0
