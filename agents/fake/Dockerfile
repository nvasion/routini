# Test image: the real Routini entrypoint with a fake `claude` that replays a
# recorded stream-json transcript. Lets the full container pipeline run in CI
# without a model or an API key.
# Build from the agents/ directory:  docker build -f fake/Dockerfile -t routini/agent-fake:test .
FROM alpine:3.20
RUN apk add --no-cache bash git jq coreutils \
 && adduser -D -u 1000 agent \
 && mkdir -p /workspace && chown agent:agent /workspace
COPY entrypoint.sh /usr/local/bin/routini-entrypoint
COPY fake/claude /usr/local/bin/claude
COPY fake/transcript.jsonl /opt/routini/transcript.jsonl
RUN chmod 0755 /usr/local/bin/routini-entrypoint /usr/local/bin/claude
USER agent
ENV HOME=/home/agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/routini-entrypoint"]
