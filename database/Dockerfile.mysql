# MySQL Database
# Popular relational database - widely supported
#
# Environment variables (set by platform):
#   MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD
#
# Data persistence:
#   In production, EFS is mounted to /data for persistent storage.
#   The EFS access point is pre-configured with correct ownership (UID 999 = mysql).
#
# IMPORTANT: Do NOT use mkdir/chown commands - EFS access points don't support chown
# and will cause "Operation not permitted" errors on container startup.
#
# To use: Copy this file to database/Dockerfile

FROM mysql:8.0

# Copy initialization scripts (run on first start only)
COPY init/ /docker-entrypoint-initdb.d/

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD mysqladmin ping -h localhost || exit 1

EXPOSE 3306

# Use /data directly as datadir (the EFS mount point in production)
# EFS access point handles ownership - no chown needed
CMD ["mysqld", "--datadir=/data"]
