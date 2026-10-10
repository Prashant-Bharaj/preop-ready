# React frontend. Builds with Node, serves with nginx as a non-root user.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache curl && \
    addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    chown -R appuser:appgroup /etc/nginx/conf.d && \
    chown -R appuser:appgroup /usr/share/nginx/html && \
    touch /tmp/nginx.pid && \
    chown appuser:appgroup /tmp/nginx.pid && \
    sed -i 's|^pid .*|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    sed -i 's/^user /#user /' /etc/nginx/nginx.conf && \
    mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi && \
    chown -R appuser:appgroup /tmp/nginx && \
    printf 'client_body_temp_path /tmp/nginx/client_body;\nproxy_temp_path /tmp/nginx/proxy;\nfastcgi_temp_path /tmp/nginx/fastcgi;\nuwsgi_temp_path /tmp/nginx/uwsgi;\nscgi_temp_path /tmp/nginx/scgi;\n' > /etc/nginx/conf.d/00-temp-paths.conf && \
    chown appuser:appgroup /etc/nginx/conf.d/00-temp-paths.conf

COPY --from=builder --chown=appuser:appgroup /app/dist /usr/share/nginx/html
COPY --chown=appuser:appgroup nginx.conf /etc/nginx/conf.d/default.conf
USER appuser
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
