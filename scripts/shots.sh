#!/usr/bin/env bash
# Screenshots of the real console for the public pages, in every theme:
# client/src/assets/shots/<name>-routini|light|dark.webp.
#
#   scripts/shots.sh
#
# Starts a throwaway hosted-mode Routini: the dev server on embedded Postgres,
# Vite, and the credential broker (the routini-egress image). Then
# scripts/shots.mjs seeds a demo org through the API, connects four real
# routini-runner containers as its fleet, runs the jobs for real and captures
# each screen. Nothing touches `make local`: own ports (3901, 5199), own data
# dir, containers and networks named routini-shots-*, all removed on exit.
#
# Needs: node, docker, a routini-runner checkout at ../routini-runner (its image
# is built here), and Playwright with Chromium (PLAYWRIGHT=/path/to/node_modules/
# playwright/index.mjs when it isn't installed in this repo).
# Extra env: OUT (output dir), DEBUG_OUT (also save full-page PNGs there),
# ONLY (comma-separated shot names), HOLD=1 (keep the stack running afterwards,
# for debugging).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

WORK=${SHOTS_WORK:-/tmp/routini-shots}
API_PORT=3901
WEB_PORT=5199
EGRESS_PORT=3929
PREFIX=routini-shots-
for port in $API_PORT $WEB_PORT $EGRESS_PORT; do
  if curl -s -o /dev/null "http://localhost:$port/"; then
    echo "port $port is in use (an earlier scripts/shots.sh still running?)" >&2
    exit 1
  fi
done
mkdir -p "$WORK"
rm -rf "$WORK/pg"

remove_containers() {
  docker ps -aq --filter "name=^${PREFIX}" | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter "name=^${PREFIX}" | xargs -r docker network rm >/dev/null 2>&1 || true
}
remove_containers

echo "Building images…"
docker build -q -t routini/runner:shots ../routini-runner >/dev/null
docker image inspect routini/agent-fake:test >/dev/null 2>&1 || docker build -q -f agents/fake/Dockerfile -t routini/agent-fake:test agents >/dev/null
docker image inspect ghcr.io/nvasion/routini-egress:latest >/dev/null 2>&1 || docker pull -q ghcr.io/nvasion/routini-egress:latest >/dev/null

secret() { openssl rand -hex 32; }
EGRESS_SECRET=$(secret)
docker run -d --name "${PREFIX}egress" -p "127.0.0.1:${EGRESS_PORT}:3129" -e ROUTINI_EGRESS_SECRET="$EGRESS_SECRET" ghcr.io/nvasion/routini-egress:latest >/dev/null

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  remove_containers
}
trap cleanup EXIT

(
  cd server
  NODE_ENV=development PORT=$API_PORT ROUTINI_MODE=hosted ROUTINI_INLINE_WORKER=1 \
    ROUTINI_DATA_DIR="$WORK/pg" JWT_SECRET=$(secret) COOKIE_SECRET=$(secret) CREDENTIALS_MASTER_KEY=$(secret) \
    CLIENT_URL=http://localhost:$WEB_PORT ROUTINI_PUBLIC_URL=http://localhost:$WEB_PORT \
    ROUTINI_AGENT_IMAGE_CLAUDE=routini/agent-fake:test ROUTINI_SANDBOX_NETWORK_PREFIX="${PREFIX}sbx-" \
    ROUTINI_EGRESS_CONTROL_URL=http://localhost:$EGRESS_PORT ROUTINI_EGRESS_SECRET="$EGRESS_SECRET" \
    ROUTINI_EGRESS_PROXY_HOST="${PREFIX}egress" ROUTINI_EGRESS_CONTAINER="${PREFIX}egress" \
    exec npx tsx src/index.ts
) >"$WORK/server.log" 2>&1 &
pids+=($!)
(cd client && API_PROXY_TARGET=http://localhost:$API_PORT exec npx vite --port $WEB_PORT --strictPort) >"$WORK/vite.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 120); do curl -sf "http://localhost:$API_PORT/health" >/dev/null && curl -sf "http://localhost:$WEB_PORT/" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$API_PORT/health" >/dev/null || { echo "server did not start; see $WORK/server.log" >&2; exit 1; }

status=0
BASE_URL=http://localhost:$WEB_PORT API_URL=http://localhost:$API_PORT CONTAINER_PREFIX=$PREFIX RUNNER_IMAGE=routini/runner:shots \
  OUT="${OUT:-$ROOT/client/src/assets/shots}" node scripts/shots.mjs || status=$?
if [ -n "${HOLD:-}" ]; then
  echo "Holding the stack for debugging: http://localhost:$WEB_PORT (Ctrl-C to stop)"
  wait
fi
exit $status
