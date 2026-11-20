# Routini agent image: Omnimancer.
# Build from the agents/ directory:  docker build -f omnimancer/Dockerfile -t routini/agent-omnimancer:latest .
#
# Same base as the Claude Code image (claude-code/Dockerfile), so agent steps
# and environments get the same toolchain whichever agent runs: git, curl,
# python3, make, g++ and node 22 for the repo's own checks. apt adds only jq,
# ripgrep and python3-venv and never reconfigures openssl/ca-certificates
# (that fails under the Factory pipeline's Kaniko).
#
# OMNIMANCER_REF is a branch, tag or commit of github.com/nvasion/omnimancer.
# Pinned to a commit so a rebuild gives the same agent; bump it on purpose.
FROM node:22-bookworm

ARG OMNIMANCER_REF=69310bbab374c257209edfcbadbae301961235f2
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ripgrep python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/omnimancer \
 && /opt/omnimancer/bin/pip install --no-cache-dir "git+https://github.com/nvasion/omnimancer.git@${OMNIMANCER_REF}" \
 && ln -s /opt/omnimancer/bin/omn /usr/local/bin/omn \
 && omn --help > /dev/null

COPY entrypoint.sh /usr/local/bin/routini-entrypoint
COPY omnimancer/routini-agent /usr/local/bin/routini-agent
RUN chmod 0755 /usr/local/bin/routini-entrypoint /usr/local/bin/routini-agent \
 && mkdir -p /workspace && chown node:node /workspace

# The node image's non-root user (uid 1000): the worker runs containers as 1000:1000.
USER node
ENV HOME=/home/node \
    PYTHONUNBUFFERED=1
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/routini-entrypoint"]
