# ============================================================================
# Vanilla Frontend (HTML/CSS/JS) - SECURE
# ============================================================================
# Serves static files with nginx as non-root user
# ============================================================================

FROM nginx:alpine

# ============================================
# SECURITY: Create non-root user
# ============================================
RUN apk add --no-cache curl && \
    addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    chown -R appuser:appgroup /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown appuser:appgroup /var/run/nginx.pid

# Copy static files and nginx config
COPY --chown=appuser:appgroup . /usr/share/nginx/html
COPY --chown=appuser:appgroup nginx.conf /etc/nginx/conf.d/default.conf

# Switch to non-root user
USER appuser

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
