# ============================================================================
# React Frontend - SECURE
# ============================================================================
# Builds with Node, serves with nginx as non-root user
# ============================================================================

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine

# ============================================
# SECURITY: Create non-root user
# ============================================
RUN apk add --no-cache libcap && \
    addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    chown -R appuser:appgroup /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown appuser:appgroup /var/run/nginx.pid && \
    setcap cap_net_bind_service=+ep /usr/sbin/nginx

# Copy built files and nginx config
COPY --from=builder --chown=appuser:appgroup /app/dist /usr/share/nginx/html
COPY --chown=appuser:appgroup nginx.conf /etc/nginx/conf.d/default.conf

# Switch to non-root user
USER appuser

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
