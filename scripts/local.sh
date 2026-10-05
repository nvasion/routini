#!/usr/bin/env bash
# Routini on this machine: the Docker Compose stack plus a routini-runner
# connected to it, so the fleet, terminals and command steps work end to end.
#
#   scripts/local.sh          start (or update) and print the URL and login
#   scripts/local.sh down     stop; data is kept
#   scripts/local.sh reset    stop and delete all local data
#
# Needs Docker (with compose) and node. The runner image is built from a
# routini-runner checkout next to this repo (../routini-runner) when present.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=routini-local
PORT="${HTTP_PORT:-8088}"
URL="http://localhost:${PORT}"
RUNNER_SRC="${ROUTINI_RUNNER_SRC:-../routini-runner}"
RUNNER=routini-local-runner
compose() { docker compose -p "$PROJECT" "$@"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);const r=($1);process.stdout.write(r===undefined||r===null?'':String(r))})"; }
envget() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

case "${1:-up}" in
down)
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  compose down
  exit 0
  ;;
reset)
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  docker volume rm "$RUNNER" >/dev/null 2>&1 || true
  compose down -v
  rm -f .env
  echo "Local Routini removed (data deleted)."
  exit 0
  ;;
up) ;;
*)
  echo "usage: $0 [up|down|reset]" >&2
  exit 2
  ;;
esac

if [ ! -f .env ]; then
  echo "Creating .env with fresh secrets…"
  cat >.env <<ENV
JWT_SECRET=$(openssl rand -hex 32)
COOKIE_SECRET=$(openssl rand -hex 32)
CREDENTIALS_MASTER_KEY=$(openssl rand -hex 32)
HTTP_PORT=${PORT}
CLIENT_URL=${URL}
ROUTINI_PUBLIC_URL=${URL}
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
ENV
fi

if ! docker image inspect routini/agent-claude:latest >/dev/null 2>&1; then
  echo "Building the agent images (first run only)…"
  make agents
fi
if [ -d "$RUNNER_SRC" ]; then
  echo "Building routini-runner from $RUNNER_SRC…"
  docker build -q -t routini/runner:dev "$RUNNER_SRC" >/dev/null
fi

echo "Starting Routini…"
compose up --build -d
for _ in $(seq 1 90); do curl -sf "$URL/health" >/dev/null && break; sleep 2; done
curl -sf "$URL/health" >/dev/null || { echo "Routini did not come up; see: docker compose -p $PROJECT logs server" >&2; exit 1; }

# The first account owns the server; create one the first time.
EMAIL=$(envget LOCAL_ADMIN_EMAIL)
PASSWORD=$(envget LOCAL_ADMIN_PASSWORD)
if [ -z "$EMAIL" ]; then
  EMAIL=admin@routini.local
  PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')
  body=$(printf '{"email":"%s","password":"%s","displayName":"Admin","orgName":"Local"}' "$EMAIL" "$PASSWORD")
  if curl -sf "$URL/api/auth/signup" -H 'content-type: application/json' -d "$body" >/dev/null; then
    printf 'LOCAL_ADMIN_EMAIL=%s\nLOCAL_ADMIN_PASSWORD=%s\n' "$EMAIL" "$PASSWORD" >>.env
  else
    EMAIL="" # an account already exists (created in the browser)
  fi
fi

# Connect a runner (once): a container on the stack's network, enrolled through nginx.
if [ -n "$EMAIL" ] && docker image inspect routini/runner:dev >/dev/null 2>&1 && [ -z "$(docker ps -q -f name="^${RUNNER}$")" ]; then
  login=$(curl -sf "$URL/api/auth/login" -H 'content-type: application/json' -d "$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")")
  token=$(printf '%s' "$login" | json 'v.token')
  org=$(printf '%s' "$login" | json 'v.orgs[0].slug')
  if [ -n "$(docker ps -aq -f name="^${RUNNER}$")" ]; then
    docker start "$RUNNER" >/dev/null # enrolled before; its config is in the volume
  else
    enroll=$(curl -sf "$URL/api/orgs/$org/runners/enrollments" -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"name":"local-runner","group":"local","tags":["local"]}')
    docker run -d --init --name "$RUNNER" --restart unless-stopped --network "${PROJECT}_default" \
      -e ROUTINI_RUNNER_URL=http://client -e ROUTINI_RUNNER_TOKEN="$(printf '%s' "$enroll" | json 'v.token')" \
      -v "$RUNNER:/home/routini-runner/.config" routini/runner:dev >/dev/null
  fi
  echo "Runner connected as host \"local-runner\"."
fi

echo
echo "Routini is running: $URL"
[ -n "$EMAIL" ] && echo "Sign in as $EMAIL / $PASSWORD (also in .env)"
echo "Stop: scripts/local.sh down · Delete everything: scripts/local.sh reset"
