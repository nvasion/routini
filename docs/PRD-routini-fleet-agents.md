# PRD: Routini: agent steps on your own fleet

**Status:** Ready to build · **Date:** 2026-10-06 · **Repos:** `nvasion/routini` (server, console) and `nvasion/routini-runner` (Go runner, protocol)
**Builds on:** [Phase 2: policy and broker](PRD-routini-phase2-policy-broker.md), [Phase 3: fleet and runner](PRD-routini-phase3-fleet-sre.md)

## Why

Agent steps always run in a sandbox container on Routini's own Docker host (`routini-agents` in the hosted deploy). A user with servers enrolled through `routini-runner` cannot choose to run an agent on one of them. Command steps can target a fleet host; agent steps cannot.

Hosted pricing promises the free tier "capped compute, **or connect your own infra via runners**". This PRD delivers that promise for agents: an agent step can say "run on host web-1". The agent then runs in a container on web-1's own Docker, with the **same credential guarantees as the hosted sandbox**.

## Decisions

1. **Placement is per step.** `AgentConfig.runOn` is optional. When absent, the step runs in the Routini sandbox, exactly as today. When set, the step runs on one fleet host, given as `{ hostId }` or `{ host: 'alert' }` (the incident's host, like command steps). There is no fan-out across hosts.
2. **Only runner hosts.** Fleet agents need `routini-runner`. SSH hosts are refused at validation time with a clear message.
3. **Opt-in on the server.** The runner's `config.json` gets `capabilities.agents`, **default `false`**. The runner advertises `agents` in `hello` only when that flag is true **and** the local Docker daemon answers. Old runners never advertise it, so the protocol stays **version 1**. The new frames are additive and gated by the capability.
4. **Local broker (credential guarantee).** On the fleet host, the runner runs the same egress proxy that runs on `routini-agents`: the `routini-egress` container, built from the routini-api image as `node dist/egress.js`.
   - The agent container joins an **internal** Docker network whose only exit is that proxy.
   - It holds **placeholders**, never real keys.
   - The proxy enforces the org's egress allow-list and injects the real credentials.
   - Real secrets travel from Routini to the runner over the existing TLS WebSocket, and live only in the proxy's memory for the session.
   - The fleet path **always** uses brokered mode, whether or not the Routini server has its own broker configured.
5. **Secrets are never at rest in plaintext.** `runner_tasks.payload` for an agent task stores the secret-bearing fields (`env`, `egress`) **sealed** with the app's `SecretBox` (`server/src/crypto/secrets.ts`, AAD = `runner_task:<taskId>`). The gateway opens them just before sending. When the task finishes, they are removed from the row.
6. **Image allow-list on the runner.** The runner refuses `agent.start` for any image (and egress image) not matching `agentImagePrefixes` in its config. The default is `["ghcr.io/nvasion/"]`. A compromised server can already run shell commands as the runner user, but the docker group is root-equivalent, so the runner limits what it will start.
7. **Public images.** Fleet hosts cannot pull from Routini's private DOCR. The routini repo publishes `ghcr.io/nvasion/routini-agent-claude` and `ghcr.io/nvasion/routini-egress` (multi-arch, `{X.Y.Z, X.Y, latest}`). The server's fleet image settings default to them.
8. **Compute accounting.** Fleet agent time is the customer's own compute. It does **not** count toward `agentMinutesPerDay`, and the timeout is not clamped by it. The model budget (`dailyBudgetUsd`) and cost recording still apply.
9. **No environments on the fleet (v1).** `runOn` and `environmentId` are mutually exclusive; validation fails with a clear message. Persistent environments stay Routini-side.

## 1. Runner (`routini-runner`, Go)

### 1.1 Config (`internal/config/config.go`)

- Add `Agents bool \`json:"agents"\`` to `Capabilities`. `New()` keeps `Agents: false`.
- Add the following fields to `Config`:
  - `AgentImagePrefixes []string \`json:"agentImagePrefixes"\``. When empty or missing at load, it is `["ghcr.io/nvasion/"]`.
  - `MaxConcurrentAgents int \`json:"maxConcurrentAgents"\``. The default is 2; a non-positive value means the default.
  - `DockerHost string \`json:"dockerHost"\``. The default is `""`, which means `unix:///var/run/docker.sock`; it is also overridden by `DOCKER_HOST`.
  - `ContainerRuntime string \`json:"containerRuntime"\``. The default is `""`, which means Docker's default runtime; set `"runsc"` for gVisor.
- Update `config_test.go`: defaults, the round trip, and that a non-positive `maxConcurrentAgents` becomes 2.

### 1.2 Docker client (new package `internal/dockerx`)

Use the official Go SDK (`github.com/docker/docker/client`) with `client.FromEnv` plus the `DockerHost` override and API version negotiation. Expose:

- `Ping(ctx) (version string, err error)`
- `EnsureImage(ctx, ref string, pull string)`, where `pull` is `"missing"` (pull only if absent) or `"always"`. Images are public, so there is no registry auth in v1.
- `EnsureNetwork(ctx, name string, labels map[string]string)`: creates an **Internal: true** bridge network if it is missing; a 409 is fine.
- `EnsureEgress(ctx, image, secret string) (controlURL string, err error)`. It keeps exactly one container named `routini-egress` running:
  - env: `ROUTINI_EGRESS_SECRET=<secret>`, with CA persistence through a named volume `routini-egress-ca` mounted where `server/src/egress.ts` / `egress/ca.ts` keeps its CA (read `loadOrCreateCa` for the path or env var).
  - command: `node dist/egress.js`.
  - ports: the control port 3129 is published **only on 127.0.0.1** (an ephemeral host port). Return `http://127.0.0.1:<port>`.
  - The proxy port 3128 is not published; agents reach it on the internal network.
  - restart policy `unless-stopped`; labels `routini.managed=true`, `routini.role=egress`.
  - If a container exists with a different image, recreate it.
  - The secret is generated once per runner process (32 random bytes, hex) and kept in memory. If the runner restarts, it recreates the egress container with the new secret.
- `ConnectNetwork(ctx, network, container, alias string)`: "already exists" is fine.
- `RunStreaming(ctx, spec, onLine func(stream, line string)) (exitCode *int, err error)`. It creates the container with exactly the hardening the server uses in `server/src/services/docker.ts`:
  - `User` from the frame (default `1000:1000`) and `Env`, `Labels`, `NetworkMode`;
  - `Memory`, `NanoCpus`, `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges:true"]`, `AutoRemove: false`;
  - `PidsLimit` from the frame's `pidsLimit` (default 512);
  - `Runtime` from the runner config's optional `containerRuntime` (for example `runsc` for gVisor). It is unset by default, which means Docker's default runtime. The server mirrors these with `ROUTINI_CONTAINER_PIDS_LIMIT` / `ROUTINI_CONTAINER_RUNTIME` (routini PR #31). On a fleet host, the runtime is the host owner's choice, so it comes from runner config, not from the server.
  - It then attaches stdout and stderr, demultiplexes them (`stdcopy`), splits lines with the same rules as `internal/execx/lines.go` (16 KiB cap, strip a trailing `\r`, replace invalid UTF-8), waits, and **always removes** the container.
- `KillByLabels(ctx, labels)`: kills and removes matching containers.

### 1.3 Protocol (update `PROTOCOL.md`, new section **2.6 Agents**; add `agents` to capabilities in 1 and 2.1)

Facts (2.2) gain `"docker": { "available": true, "version": "27.3.1" }`. It is omitted when Docker is unreachable.

Server → runner:

```json
{ "type": "agent.start", "id": "task-uuid",
  "image": "ghcr.io/nvasion/routini-agent-claude:0.3.0", "pull": "missing",
  "user": "1000:1000", "cpus": 2, "memoryMb": 4096, "pidsLimit": 512, "timeoutSec": 1800,
  "env": { "ROUTINI_PROMPT": "…", "ANTHROPIC_API_KEY": "routini-brokered-credential", "…": "…" },
  "labels": { "routini.managed": "true", "routini.org": "…", "routini.run": "…", "routini.step": "0" },
  "egress": {
    "image": "ghcr.io/nvasion/routini-egress:0.3.0",
    "network": "routini-sb-1a2b3c4d",
    "session": { "token": "…", "orgId": "…", "label": "run 12 step 1", "allowedHosts": ["…"],
                 "bindings": [{ "host": "api.anthropic.com", "header": "x-api-key", "format": "raw", "secret": "…" }],
                 "expiresAt": "…" } } }
{ "type": "agent.cancel", "id": "task-uuid" }
```

Runner → server:

```json
{ "type": "agent.output", "id": "task-uuid", "stream": "stdout", "data": "one line" }
{ "type": "agent.exit", "id": "task-uuid", "exitCode": 0, "timedOut": false, "canceled": false, "error": null,
  "egress": { "requests": 41, "intercepted": 12, "blocked": ["evil.example"] } }
```

Runner behaviour for `agent.start`, in order. Any failure sends **one** `agent.exit` with `exitCode: null` and a short `error`.

1. If agents are disabled, reply `error: "agents are disabled on this runner"`. If the image or egress image fails the prefix allow-list, reply `error: "image not allowed by agentImagePrefixes: <ref>"`. If `maxConcurrentAgents` is reached, reply `error: "runner busy (N agents running)"`.
2. `EnsureImage(egress.image)`, `EnsureEgress`, `EnsureNetwork(egress.network, {routini.managed:true})`, `ConnectNetwork(network, "routini-egress", alias "routini-egress")`.
3. `PUT {controlURL}/sessions/{token}` with `egress.session` as JSON and `Authorization: Bearer <secret>`. Then `GET /ca` → `{pem}`.
4. Add these to `env`, exactly as `BrokerClient.containerEnv` in `server/src/egress/client.ts` does:
   - `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy` = `http://routini:<token>@routini-egress:3128`
   - `NO_PROXY=""`, `no_proxy=""`
   - `GIT_HTTP_PROXY_AUTHMETHOD=basic`
   - `ROUTINI_CA_PEM=<pem>`
5. `EnsureImage(image, pull)`, then `RunStreaming` with `NetworkMode = egress.network`. Stream every line as `agent.output`, using the same per-line framing as `exec.output`.
6. Timeout or `agent.cancel`: stop the container (10 s grace), then kill it. Report `timedOut` or `canceled`.
7. Always: `DELETE /sessions/{token}` and put the returned stats in `agent.exit.egress` (null if the call fails). The container is always removed.

**When the control connection drops,** kill every running agent container (labels `routini.managed=true` and `routini.run`) and close their sessions. This is the same rule as exec. The `routini-egress` container stays up.

**Startup:** when agents are enabled, ping Docker. If it is unreachable, log one warning and leave `agents` out of `hello`; exec and pty keep working. Concurrency is counted separately from exec (`maxConcurrentAgents`).

### 1.4 Wiring (`internal/conn/conn.go`)

- `capabilities()` adds `"agents"` when it is enabled and the Docker ping succeeded.
- The frame switch gets `agent.start` → an agent manager (new `internal/agentx`, mirroring `internal/execx`'s `Manager`: `Start`, `Cancel`, `CancelAll`, `Running`).
- `agent.cancel` → `Cancel`. The disconnect path → `CancelAll`.
- Facts get the `docker` block.

### 1.5 Packaging and docs

- `install.sh`: a flag `--enable-agents` that sets `capabilities.agents=true` and adds the runner user to the `docker` group, printing a clear warning that **membership of the docker group is root-equivalent on this host**.
- README: a section "Running agents on this server": the requirements (Docker ≥ 24, outbound HTTPS to ghcr.io and the model and repo hosts), the warning above, and how to enable or disable it.
- Version **0.2.0**; CHANGELOG entry.

### 1.6 Runner tests

- `internal/agentx`: a fake Docker (an interface over `dockerx`) and a fake egress control server (`httptest`). Cover:
  - the order of operations;
  - the env it injects;
  - the session PUT and DELETE;
  - the allow-list refusal, the busy refusal and the disabled refusal;
  - a timeout stops the container and sets `timedOut`;
  - cancel sets `canceled`;
  - disconnect kills everything;
  - the container is removed on every path;
  - the egress stats end up in the exit.
- `internal/conn`: `agents` appears in hello only when enabled and Docker answers. `agent.start` and `agent.cancel` are routed.
- `go vet ./... && go test ./...` passes. An opt-in e2e behind `ROUTINI_RUNNER_DOCKER_E2E=1` uses real Docker with `alpine` as the agent image and a stub egress.

## 2. Server (`routini`)

### 2.1 Spec (`server/src/engine/spec.ts`)

- `AgentConfig.runOn?: { hostId: string } | { host: 'alert' }`.
- `parseAgent` validation messages, using the field path `p` as today:
  - `runOn` must be an object with exactly one of `hostId` (UUID) or `host: 'alert'`;
  - `runOn` together with `environmentId` → `"${p}: run on a fleet host or in an environment, not both"`.
- In job validation (wherever SSH steps are checked against existing hosts, the "does not match a host" check), check `runOn.hostId` the same way. Also fail if the host's transport is `ssh`: `"${p}.runOn: agents need a host connected with routini-runner; \"<name>\" uses SSH"`.

### 2.2 Prepare (`server/src/engine/prepare.ts`)

Resolve `runOn: { host: 'alert' }` to `{ hostId: t.hostId }`, with the same two error messages the SSH `host: 'alert'` path uses (worded for agents).

### 2.3 Policy (`server/src/engine/policy.ts`, `server/src/repos/policy.ts`, console `PolicyPanel`)

- `StepFacts` gains `agentPlacement?: 'sandbox' | 'fleet'`, and for fleet agents also sets `host: { tags, group }`. Wherever facts are built, set them from the resolved `runOn` host.
- `PolicyMatch` gains `agentPlacements?: Array<'sandbox' | 'fleet'>`, matched with `anyOf`.
- Update the doc comments: `hostTags` and `hostGroups` now also match agent steps that run on a fleet host.
- Validate the new field in the policy API exactly like the other enum arrays.
- PolicyPanel: a "Where agents run" multi-select (Sandbox / Fleet host).
- Tests: a rule "require approval for agents on hosts tagged prod" holds a fleet agent step and does not hold a sandbox one.

### 2.4 Tasks and gateway (`server/src/repos/runners.ts`, `server/src/runner/gateway.ts`)

- `ExecPayload` becomes `RunnerPayload = ExecPayload | AgentPayload`:

```ts
export interface AgentPayload {
  type: 'agent'
  image: string
  pull: 'missing' | 'always'
  user: string
  cpus: number
  memoryMb: number
  /** ROUTINI_CONTAINER_PIDS_LIMIT (default 512), as for sandbox containers. */
  pidsLimit: number
  timeoutSec: number
  labels: Record<string, string>
  egressImage: string
  network: string
  /** SecretBox-sealed JSON of { env, session } (AAD `runner_task:<id>`); never stored in plaintext. */
  sealed: SealedSecret
}
```

- `createRunnerTask` needs the task id **before** sealing, because the AAD includes it. Generate the uuid in TypeScript (`randomUUID()`) and insert it explicitly. Add a helper `createAgentRunnerTask(q, box, orgId, runnerId, plain, secret: { env, session }, link)`.
- `finishRunnerTask`: for agent tasks, also `payload = payload - 'sealed'` in the same UPDATE. Also scrub `sealed` from any agent task that ends in `canceled` or `failed` through `cancelStepRunnerTasks`.
- `ExecResultData` gains `egress?: { requests: number; intercepted: number; blocked: string[] } | null`.
- Gateway `dispatch`:
  - when `payload.type === 'agent'`, open `sealed` with `ctx.box` and send `agent.start` built from the payload and the opened `{ env, session }` (`egress: { image: egressImage, network, session }`);
  - the cancel op sends `agent.cancel` for agent tasks and `exec.cancel` for exec tasks (look up the task type);
  - handle `agent.output` exactly like `exec.output`, and `agent.exit` like `exec.exit` (including `egress`).
  - If the runner lacks the `agents` capability at dispatch time, finish the task as failed with `error: "This host's runner does not run agents; enable \"agents\" in its config.json"`.
- `sentTasksFor` and the disconnect handling apply unchanged to agent tasks.

### 2.5 Worker side (new `server/src/runner/agent.ts`)

`runAgentOnRunner(ctx, opts)` mirrors `execOnRunner` in `server/src/runner/exec.ts`: the offline grace, poll, NOTIFY output, cancel on `ctx.signal`, and the same outcome shape plus `egress` stats. Each output line calls `opts.onLine(line, stream)` instead of logging. Do not duplicate code: factor the shared wait/stream loop out of `execOnRunner` into a function both use.

### 2.6 Agent executor (`server/src/engine/agent.ts`)

When `cfg.runOn` is set (after prepare it is always `{ hostId }`):

1. Load the host (`getHost`). Fail clearly if it no longer exists, uses SSH, has no active runner, or its runner lacks the `agents` capability. The message names the host and the fix.
2. **Limits:** skip the `agentMinutesPerDay` check and the timeout clamp. Keep the `dailyBudgetUsd` check.
3. **Credentials:** compute access exactly as the brokered path does today: `mcpAccessFor(..., brokered = true)`, `brokeredModelAccess`, and integration bindings. This must not depend on `ctx.app.broker` being configured.
   - Refactor so the "brokered vs direct" decision is a parameter, not `Boolean(broker)`.
   - Register every secret with `ctx.addSecret`, as today.
4. `await emitPlacement(ctx, { target: 'fleet', via: 'runner', host: host.name, hostId: host.id })` (`server/src/engine/placement.ts`, already exists).
5. Log `Starting <agent> agent (<image>) on <host> via routini-runner`.
6. Image: `fleetAgentImages()`, a new helper next to `defaultAgentImages`. It reads `ROUTINI_FLEET_AGENT_IMAGE_CLAUDE` (default `ghcr.io/nvasion/routini-agent-claude:latest`), and the `_OMNIMANCER` / `_OPENCODE` variants (no default; the step fails clearly if one is missing). The egress image comes from `ROUTINI_FLEET_EGRESS_IMAGE` (default `ghcr.io/nvasion/routini-egress:latest`).
7. Network name: exactly what `BrokerClient.network()` names it for the org. Factor the name into an exported helper (`sandboxNetworkName(prefix, orgId)`) and use it in both places. Do not hard-code the length of the org-id part: routini PR #31 switches it to the full org id. Session: `{ token: randomBytes(24).toString('hex'), orgId, label, allowedHosts: access.hosts, bindings: access.bindings, expiresAt: now + timeout + 600 s }`.
8. Call `runAgentOnRunner` with the same `onLine` parser feed the Docker path uses. Then continue through the **existing** post-run code (facts, cost via `ctx.addUsage({ costUsd })` **without** `agentSeconds`, PR creation, results). Do not fork that logic.
9. Egress stats: log and emit `egress.blocked` exactly as the sandbox path does after `broker.close`.
10. The Routini MCP token (`routini: true`): created and revoked the same way.

When `cfg.runOn` is absent, the behaviour is unchanged.

### 2.7 Console (`client/`)

- `client/src/lib/types.ts`: mirror `AgentConfig.runOn`, `PolicyMatch.agentPlacements`, and the runner `facts.docker`.
- Job editor (`client/src/pages/jobForm.ts` and `JobEditorPage.tsx`): agent steps get a **Run on** select.
  - Options:
    - "Routini sandbox" (the default);
    - every runner host by name;
    - "Alert's host", only when the trigger kind is `alert`.
  - A host whose runner is offline, revoked or lacking `agents` is shown disabled with the reason ("offline", "agents not enabled").
  - The select is disabled while an environment is chosen, and vice versa.
  - Form ↔ spec conversion lives in `jobForm.ts` with unit tests (round trip, the alert option, mutual exclusion).
- Run page (`client/src/pages/RunPage.tsx` `stepSummary`): agent steps on the fleet append ` · on <host name>` (or ` · on alert's host`). The placement badge from `step.placement` already shows where it actually ran.
- Fleet page: an "agents" capability badge per host, and the Docker version from facts.
- Use only colour tokens from `client/src/styles/tokens.css`.

### 2.8 MCP server (`server/src/mcp/server.ts`)

If any tool schema describes agent step config, add `runOn` to it, with the same wording as the spec.

### 2.9 Images and release (`routini` repo)

- Add `.github/workflows/images.yml`. On tags `v*` and on `workflow_dispatch`, it builds and pushes multi-arch (amd64, arm64) images to GHCR, tagged `{X.Y.Z, X.Y, latest}`:
  - `ghcr.io/nvasion/routini-agent-claude` from `agents/claude-code`;
  - `ghcr.io/nvasion/routini-egress` from the server image with `CMD ["node","dist/egress.js"]` (a small Dockerfile target or a separate Dockerfile).
- Use `docker/metadata-action` and `docker/build-push-action`, the same as `routini-runner/.github/workflows/release.yml`.
- `agents/README.md` and `README.md`: document fleet agents, the env vars from 2.6 step 6, and that images must be public (no registry auth in v1).

### 2.10 Server tests (`tests/`, using `tests/helpers/testApp.ts` and the fake runner in `tests/fleet.test.ts`)

- Spec: `runOn` validation messages (bad shape, both keys, environment together with runOn, unknown host, SSH host).
- Fleet agent run with a fake runner that answers `agent.start`. Assert:
  - the frame carries `image`, `labels`, `egress.session.bindings` with the **real** key, and `env` with **only placeholders** (no real key anywhere in `env`);
  - the `runner_tasks.payload` row never contains the real key (query it during and after the run), and `sealed` is gone once the task finishes;
  - the output lines become `agent.*` timeline events through the parser;
  - `step.placement` = `{ target: 'fleet', via: 'runner', host, hostId }`;
  - cost is recorded and `agent_seconds` is not increased;
  - `egress.blocked` is emitted from the exit stats.
- A runner without `agents` → the step fails with the capability message. Offline beyond the grace → it fails like exec.
- Cancel the run → `agent.cancel` is sent.
- `host: 'alert'` resolves to the incident's host.
- Policy: see 2.3.
- Client: `jobForm.test.ts` cases from 2.7, and a RunPage summary check.
- `make test` and both `tsc --noEmit` pass.

## Out of scope (v1)

- Private registry auth for fleet images.
- Persistent environments on fleet hosts.
- Choosing "any host in group X" (fan-out or scheduling).
- Windows and macOS runners.
- GPU passthrough.

## Acceptance

1. A job with an agent step `runOn: { hostId: <runner host with agents enabled> }` runs on that host. The run page shows `ran on <host> · fleet via routini-runner`. The PR is opened as it is for sandbox runs.
2. `docker inspect` of the agent container on the host shows only placeholder credentials and the internal network. A request to a host not on the allow-list is blocked and shows up in the timeline.
3. No real secret is present in `runner_tasks` at any time.
4. A runner with agents disabled, or without Docker, is refused with an actionable message. Its exec and terminals keep working.
5. Existing sandbox agent steps, command steps and all current tests are unaffected.
