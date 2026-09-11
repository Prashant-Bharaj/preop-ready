# PostgreSQL Dockerfile template
# CRITICAL: PGDATA must point to /data for persistence across deployments
# Init scripts in init/ run on FIRST deployment only (empty database)

FROM postgres:16
COPY init/ /docker-entrypoint-initdb.d/
ENV PGDATA=/data/postgres
RUN mkdir -p /data/postgres && chown -R postgres:postgres /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD pg_isready -U postgres || exit 1
EXPOSE 5432