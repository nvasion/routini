# Routini agent image: Omnimancer.
# Build from the agents/ directory:  docker build -f omnimancer/Dockerfile -t routini/agent-omnimancer:latest .
# OMNIMANCER_REF is a branch, tag or commit of github.com/nvasion/omnimancer.
FROM python:3.12-slim

ARG OMNIMANCER_REF=main
RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates curl ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "git+https://github.com/nvasion/omnimancer.git@${OMNIMANCER_REF}" \
 && omn --help > /dev/null

COPY entrypoint.sh /usr/local/bin/routini-entrypoint
COPY omnimancer/routini-agent /usr/local/bin/routini-agent
RUN chmod 0755 /usr/local/bin/routini-entrypoint /usr/local/bin/routini-agent \
 && useradd -m -u 1000 -s /bin/bash agent \
 && mkdir -p /workspace && chown agent:agent /workspace

# uid 1000 — the worker runs containers as 1000:1000.
USER agent
ENV HOME=/home/agent \
    PYTHONUNBUFFERED=1
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/routini-entrypoint"]
