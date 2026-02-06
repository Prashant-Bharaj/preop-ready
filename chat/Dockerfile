FROM node:22-bookworm-slim

# Install git (needed by cline for repo operations)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# Install cline globally
RUN npm install -g cline

# Set up the chat app
WORKDIR /opt/chat

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY . .

# Build frontend
RUN npm run build

# The repo will be mounted here at runtime
VOLUME /workspace
WORKDIR /workspace

ENV PORT=8888
ENV WORKSPACE_DIR=/workspace
EXPOSE 8888

CMD ["node", "/opt/chat/server/index.js"]
