# Routini agent image: Claude Code.
# Build from the agents/ directory:  docker build -f claude-code/Dockerfile -t routini/agent-claude:latest .
# The full bookworm image already has git, curl, ca-certificates, openssl,
# python3, make and g++. apt adds only jq and ripgrep, so the build never
# reconfigures openssl/ca-certificates, which fails under the Factory pipeline's
# Kaniko (it can't replace the action container's own libcrypto).
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/routini-entrypoint
RUN chmod 0755 /usr/local/bin/routini-entrypoint \
 && mkdir -p /workspace && chown node:node /workspace

# The node image's non-root user (uid 1000) — the worker runs containers as 1000:1000.
USER node
ENV HOME=/home/node \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/routini-entrypoint"]
