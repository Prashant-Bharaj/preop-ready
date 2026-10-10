# ============================================================================
# Python Backend (FastAPI) - SECURE
# ============================================================================
# Runs as non-root user for defense in depth.
# Base: python:3.12-slim (minimal, security). curl is REQUIRED for the
# /health healthcheck.
# ============================================================================

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# SECURITY: Create non-root user
# ============================================
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/bash appuser

WORKDIR /app
RUN chown appuser:appgroup /app
RUN mkdir -p /data && chown appuser:appgroup /data

COPY requirements.txt .
RUN pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY --chown=appuser:appgroup . .

USER appuser

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 CMD curl -f http://localhost:3000/health || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
