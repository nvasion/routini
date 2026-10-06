#!/usr/bin/env bash
# Routini agent entrypoint — the contract between the worker and an agent image.
#
# In:  ROUTINI_PROMPT (required), ROUTINI_SYSTEM_PROMPT, ROUTINI_MODEL,
#      REPO_URL + BASE_BRANCH + WORK_BRANCH (optional), CHECK_COMMAND (optional),
#      ROUTINI_OUTPUT = pr | branch | none, ROUTINI_COMMIT_MESSAGE,
#      GITHUB_TOKEN (used for clone/push on github.com when present).
# Out: the agent's stdout (Claude Code stream-json) plus control lines
#      "::routini::{json}" for check / commit / pushed / no_changes / error.
# Exit: 0 success · 3 check failed · other = failure.
set -uo pipefail

ctl() { printf '::routini::%s\n' "$1"; }
fail() {
  ctl "$(jq -cn --arg m "$1" '{type: "error", message: $m}')"
  exit "${2:-1}"
}

[ -n "${ROUTINI_PROMPT:-}" ] || fail "ROUTINI_PROMPT is empty"

# Credential broker: trust Routini's CA. The egress proxy intercepts only the
# hosts it holds credentials for; everything else is tunnelled untouched, so
# the system CAs stay in the bundle.
if [ -n "${ROUTINI_CA_PEM:-}" ]; then
  rdir="${HOME:-/tmp}/.routini"
  mkdir -p "$rdir"
  printf '%s\n' "$ROUTINI_CA_PEM" > "$rdir/ca.pem"
  { cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null; cat "$rdir/ca.pem"; } > "$rdir/bundle.pem"
  export NODE_EXTRA_CA_CERTS="$rdir/ca.pem" SSL_CERT_FILE="$rdir/bundle.pem" GIT_SSL_CAINFO="$rdir/bundle.pem" \
    REQUESTS_CA_BUNDLE="$rdir/bundle.pem" CURL_CA_BUNDLE="$rdir/bundle.pem"
fi

# MCP servers connected for this agent (Claude Code --mcp-config).
mcp_args=()
if [ -n "${ROUTINI_MCP_CONFIG:-}" ]; then
  printf '%s' "$ROUTINI_MCP_CONFIG" > "${HOME:-/tmp}/.routini-mcp.json"
  mcp_args=(--mcp-config "${HOME:-/tmp}/.routini-mcp.json")
fi
mkdir -p /workspace && cd /workspace || fail "cannot enter /workspace"

if [ -n "${REPO_URL:-}" ] || [ -n "${ROUTINI_REPO_DIR:-}" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    # Token comes from the environment at use time; it is never written to disk.
    git config --global credential.https://github.com.helper \
      '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'
  fi
  git config --global user.name "Routini"
  git config --global user.email "routini@users.noreply.tynhub.com"
  git config --global advice.detachedHead false
fi

if [ -n "${ROUTINI_REPO_DIR:-}" ]; then
  # Inside a persistent environment: work in a fresh git worktree so the
  # person's own checkout is never touched; the result stays for inspection.
  [ -d "$ROUTINI_REPO_DIR/.git" ] || fail "no git repository at $ROUTINI_REPO_DIR"
  cd "$ROUTINI_REPO_DIR" || fail "cannot enter $ROUTINI_REPO_DIR"
  git fetch --quiet origin "${BASE_BRANCH:-main}" 2>&1 | sed 's/^/[git] /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail "git fetch of ${BASE_BRANCH:-main} failed"
  wt="/workspace/.routini/$(printf '%s' "${WORK_BRANCH:-routini/work}" | tr '/' '-')"
  rm -rf "$wt"
  git worktree prune
  git worktree add --quiet -B "${WORK_BRANCH:-routini/work}" "$wt" "origin/${BASE_BRANCH:-main}" || fail "cannot create worktree $wt"
  cd "$wt" || fail "cannot enter $wt"
elif [ -n "${REPO_URL:-}" ]; then
  git clone --quiet --depth 50 --branch "${BASE_BRANCH:-main}" "$REPO_URL" repo 2>&1 | sed 's/^/[git] /' \
    || fail "git clone of ${BASE_BRANCH:-main} failed"
  [ -d repo/.git ] || fail "git clone of ${BASE_BRANCH:-main} failed"
  cd repo || fail "cannot enter repository"
  git checkout --quiet -b "${WORK_BRANCH:-routini/work}" || fail "cannot create branch ${WORK_BRANCH:-routini/work}"
fi

args=(-p "$ROUTINI_PROMPT" --output-format stream-json --verbose --dangerously-skip-permissions)
[ -n "${ROUTINI_SYSTEM_PROMPT:-}" ] && args+=(--append-system-prompt "$ROUTINI_SYSTEM_PROMPT")
[ -n "${ROUTINI_MODEL:-}" ] && args+=(--model "$ROUTINI_MODEL")
args+=("${mcp_args[@]}")
claude "${args[@]}"
code=$?
[ "$code" -eq 0 ] || fail "agent exited with code $code" "$code"

if [ -n "${CHECK_COMMAND:-}" ]; then
  # Prefix each line without `sed -u` (BusyBox sed lacks it) so output streams live.
  bash -c "$CHECK_COMMAND" 2>&1 | while IFS= read -r line; do printf '[check] %s\n' "$line"; done
  check=${PIPESTATUS[0]}
  ctl "{\"type\":\"check\",\"exitCode\":${check}}"
  [ "$check" -eq 0 ] || exit 3
fi

if [ -n "${REPO_URL:-}" ] && [ "${ROUTINI_OUTPUT:-pr}" != "none" ]; then
  git add -A
  git diff --cached --quiet || git commit --quiet -m "${ROUTINI_COMMIT_MESSAGE:-Routini run}"
  ahead=$(git rev-list --count "origin/${BASE_BRANCH:-main}..HEAD" 2>/dev/null || echo 0)
  if [ "$ahead" -eq 0 ]; then
    ctl '{"type":"no_changes"}'
    exit 0
  fi
  files=$(git diff --name-only "origin/${BASE_BRANCH:-main}..HEAD" | wc -l | tr -d ' ')
  ctl "{\"type\":\"commit\",\"sha\":\"$(git rev-parse HEAD)\",\"files\":${files}}"
  git push --quiet origin "HEAD:refs/heads/${WORK_BRANCH:-routini/work}" 2>&1 | sed 's/^/[git] /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail "git push failed"
  ctl "{\"type\":\"pushed\",\"branch\":\"${WORK_BRANCH:-routini/work}\"}"
fi
exit 0
