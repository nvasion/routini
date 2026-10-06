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

Images for other agents reuse `entrypoint.sh` (clone, broker CA, check, commit,
push) and add an executable `/usr/local/bin/routini-agent`. When it exists, the
entrypoint runs it in place of `claude`. It reads the same environment
(`ROUTINI_MCP_FILE` points at the MCP config, when there is one), prints
stream-json on stdout, and exits non-zero on failure. `omnimancer/` is one.

### Omnimancer (`omnimancer/`)

```bash
docker build -f omnimancer/Dockerfile -t routini/agent-omnimancer:latest .   # --build-arg OMNIMANCER_REF=<branch|tag|sha>
# then on the server: ROUTINI_AGENT_IMAGE_OMNIMANCER=routini/agent-omnimancer:latest
```

The launcher runs `omn -p … --output-format stream-json --dangerously-skip-permissions`.
It writes `~/.omnimancer/config.json` (provider, model, Bedrock `aws_region`),
passes the key as `OMNIMANCER_<PROVIDER>_API_KEY` (never on disk), and puts
`ROUTINI_SYSTEM_PROMPT` in `~/.omnimancer/OMNIMANCER.md`. Routini's parser reads
Omnimancer's stream-json variant directly.

- Endpoints: anthropic, openrouter, digitalocean, aws-bedrock, openai, google, azure. Not gateway.
- Bedrock needs a model id (Omnimancer has no default for it) and a region.
- MCP servers are not available: Omnimancer does not load them in headless mode.
- Iteration cap defaults to 200 (`OMNIMANCER_MAX_ITERATIONS`). When Omnimancer stops
  early it exits 3; the launcher reports that and exits 6, since 3 means "check failed" here.

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
| `CLAUDE_CODE_USE_BEDROCK` / `AWS_REGION` / `AWS_BEARER_TOKEN_BEDROCK` | Model endpoint when the org routes Claude Code through AWS Bedrock (Bedrock API key). |
| `ROUTINI_ENDPOINT` / `ROUTINI_ENDPOINT_KEY` | Other agents (Omnimancer, OpenCode) instead of the vars above: the endpoint name from the AI settings (`anthropic`, `openrouter`, `aws-bedrock`, `gateway`, …) and its key. The image maps these onto the agent's own config. |
| `ROUTINI_ENDPOINT_REGION` / `ROUTINI_GATEWAY_URL` | AWS region for `aws-bedrock` (the key is a Bedrock API key, sent as `authorization: Bearer`); URL for `gateway`. |
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
timeout (per-step `resources` / `timeoutSec`; in the sandbox the timeout is
also capped by the org's remaining agent minutes for the day). The worker
reaches Docker through `DOCKER_HOST`, so a remote runner host (`ssh://…` or
`tcp://…`) works without code changes.

## Fleet agents (`runOn`)

An agent step normally runs in the Routini sandbox: a container on the Docker
host the server or worker points at (`DOCKER_HOST`). Give the step a `runOn` and
it runs on one of your own fleet servers instead:

```jsonc
{ "type": "agent", "agent": "claude", "prompt": "…", "runOn": { "hostId": "…" } }
{ "type": "agent", "agent": "claude", "prompt": "…", "runOn": { "host": "alert" } }
```

`{ host: "alert" }` resolves to the host the alert matched, like a command step
does. `runOn` and `environmentId` are mutually exclusive: a step runs on a fleet
host or in an environment, never both.

The container, its egress proxy and the repository checkout all live on that
host; Routini only streams the output. So the code never leaves your network,
and the agent can reach what that server reaches.

**What the host needs**

- [routini-runner](https://github.com/nvasion/routini-runner) connected, with
  `"capabilities": ["exec", "pty", "agents"]` in its `config.json` — without
  `agents` the step fails with *This host's runner does not run agents; enable
  "agents" in its config.json*.
- Docker on that host, reachable by the runner's user. The runner starts the
  agent container and the egress proxy beside it.
- SSH hosts cannot run agents: the step is rejected when the job is saved.

**Images the runner pulls** (set on the Routini server, not on the host):

| Variable | Default | Meaning |
|---|---|---|
| `ROUTINI_FLEET_AGENT_IMAGE_CLAUDE` | `ghcr.io/nvasion/routini-agent-claude:latest` | Claude Code on fleet hosts. |
| `ROUTINI_FLEET_AGENT_IMAGE_OMNIMANCER` | — | Omnimancer; without it those steps fail with a clear message. |
| `ROUTINI_FLEET_AGENT_IMAGE_OPENCODE` | — | OpenCode; same. |
| `ROUTINI_FLEET_EGRESS_IMAGE` | `ghcr.io/nvasion/routini-egress:latest` | The egress proxy started next to the agent container. |

These are separate from the `ROUTINI_AGENT_IMAGE_*` vars, which stay with the
sandbox: a fleet host usually wants a published image it can pull, while the
sandbox may use one you built locally.

The images must be **public**. v1 sends no registry credentials, so a runner
pulls anonymously; a private image fails at pull time. [images.yml](../.github/workflows/images.yml)
publishes both to GHCR on every `v*` tag, multi-arch (amd64 and arm64) and
tagged `X.Y.Z`, `X.Y` and `latest`.

Policy still applies — rules can match agent steps by where they run (sandbox or
fleet host) and by that host's tags and groups. **Fleet agent time does not
count toward the org's `agentMinutesPerDay`**: that budget is for the Routini
sandbox, and these minutes are your own server's. The per-step `timeoutSec`
still bounds the run.

## Known gap (Phase 2)

Integration tokens and model keys are visible inside the container, so a
prompt-injected agent could leak them. Phase 2 replaces this with a credential
broker and an egress proxy that adds credentials outside the sandbox.
