# Agent images

Routini runs coding agents in short-lived containers, one per agent step.
Every image uses the same entrypoint ([entrypoint.sh](entrypoint.sh)), which
defines the contract with the worker.

| Image | Dockerfile | Tag the server expects |
|---|---|---|
| Claude Code | [claude-code/Dockerfile](claude-code/Dockerfile) | `routini/agent-claude:latest` (override: `ROUTINI_AGENT_IMAGE_CLAUDE`) |
| Fake (tests) | [fake/Dockerfile](fake/Dockerfile) | `routini/agent-fake:test` |

Build from this directory:

```bash
docker build -f claude-code/Dockerfile -t routini/agent-claude:latest .
docker build -f fake/Dockerfile -t routini/agent-fake:test .
```

Omnimancer and OpenCode use the same contract. Point `ROUTINI_AGENT_IMAGE_OMNIMANCER`
or `ROUTINI_AGENT_IMAGE_OPENCODE` at an image that follows it; without one,
those agents' steps fail with a clear message.

## Contract

**Input (environment)**

| Variable | Meaning |
|---|---|
| `ROUTINI_PROMPT` | The task. Required. |
| `ROUTINI_SYSTEM_PROMPT` | Appended system prompt: unattended, don't commit/push, summarise at the end. |
| `ROUTINI_MODEL` | Model id for the configured endpoint (optional). |
| `REPO_URL`, `BASE_BRANCH`, `WORK_BRANCH` | Repository to clone, branch to start from, branch to push (`routini/run-<n>`). |
| `CHECK_COMMAND` | Done-check run after the agent; non-zero fails the step. |
| `ROUTINI_OUTPUT` | `pr`, `branch` or `none`. |
| `ROUTINI_COMMIT_MESSAGE` | Commit message for the agent's changes. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | Model endpoint, from the org's AI settings. |
| `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, … | Connected integrations whose scope includes this agent. |

**Output (stdout)**

The agent's own output (Claude Code `--output-format stream-json`), plus control lines:

```
::routini::{"type":"check","exitCode":0}
::routini::{"type":"commit","sha":"…","files":3}
::routini::{"type":"pushed","branch":"routini/run-12"}
::routini::{"type":"no_changes"}
::routini::{"type":"error","message":"git push failed"}
```

**Exit code:** `0` success, `3` check failed, anything else failure.

The worker streams these lines into the run timeline as they happen, adds the
reported model cost to the run, and, for `ROUTINI_OUTPUT=pr`, opens the pull
request itself with the org's GitHub integration. The container never sees a
GitHub App or org-level credential beyond the scoped integration env.

## Runtime settings

Containers run as uid 1000 with all capabilities dropped and
`no-new-privileges`. They default to 2 CPUs, 4 GB of memory and a 30-minute
timeout (per-step `resources` / `timeoutSec`; the timeout is also capped by the
org's remaining agent minutes for the day). The worker reaches Docker through
`DOCKER_HOST`, so a remote runner host (`ssh://…` or `tcp://…`) works without
code changes.

## Known gap (Phase 2)

Integration tokens and model keys are visible inside the container, so a
prompt-injected agent could leak them. Phase 2 replaces this with a credential
broker and an egress proxy that adds credentials outside the sandbox.
