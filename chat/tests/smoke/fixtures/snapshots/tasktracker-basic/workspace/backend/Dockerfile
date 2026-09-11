# ============================================================================
# Node.js Backend (Express/Fastify/etc) — multi-stage, SECURE, TypeScript
# ============================================================================
# Stage 1 (builder): install full deps, run `tsc` to emit dist/.
# Stage 2 (runtime): copy only dist/ + node_modules + package.json, run as
# non-root. Final image stays slim — the TS compiler lives only in the
# build layer.
#
# Base: node:22-slim (minimal, public) for both stages — builder installs +
# compiles; runtime ships only dist/ + pruned prod deps + curl for healthcheck.
#
# Required package.json scripts (see snippets/backend/express-server-template.ts):
#   "build":     "tsc"
#   "start":     "node dist/index.js"
#   "typecheck": "tsc --noEmit"
# ============================================================================

# -------------------------------- BUILD STAGE -------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Install ALL deps (incl. dev) so tsc + @types/* are available for the build.
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund

# Copy sources and emit JS to dist/.
COPY . .
RUN npm run build

# Prune dev deps so the runtime stage copies a production-only node_modules.
RUN npm prune --omit=dev

# ------------------------------ RUNTIME STAGE -------------------------------
# Minimal runtime base (security): ships only the built dist/ + pruned prod
# deps. curl is REQUIRED for the `/health` healthcheck (local compose + ECS
# Fargate container health check per .platform-rules/security.md). Mirrors the
# frontend runtime (nginx:alpine + apk add curl).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# SECURITY: non-root user (Debian syntax).
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh appuser

WORKDIR /app

# Copy only what's needed at runtime, owned by the appuser.
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

USER appuser

EXPOSE 3000
CMD ["node", "dist/index.js"]
