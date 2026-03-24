# ============================================================================
# Node.js Backend (Express/Fastify/etc) - SECURE
# ============================================================================
# Runs as non-root user for defense in depth
# ============================================================================

FROM node:22-alpine

# ============================================
# SECURITY: Create non-root user
# ============================================
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Install dependencies as root (before switching user)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code with correct ownership
COPY --chown=appuser:appgroup . .

# Switch to non-root user
USER appuser

EXPOSE 3000
CMD ["node", "src/index.js"]
