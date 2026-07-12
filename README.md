# routini

Routini is an autonomous engineer platform for defining and running three
kinds of tasks: **daily** operations (SSH, email checks, HTTP dashboards),
**developmental** coding jobs that execute in Docker containers with a
selectable AI agent, and **routines** that orchestrate the two.

Features:
- Express.js backend with TypeScript
- React frontend with Vite
- Hot module replacement for both client and server
- API proxy configuration
- Type-safe development
- **Authentication** — password login with HTTP-only JWT cookies, protected API routes, and a themed login/logout UI
- **AI Settings** — per-user provider selection, API-key storage encrypted at rest with AES-256-GCM (per-record IV, authenticated encryption), default agent, and model parameters
- **Task CRUD** — full create/read/update/delete for daily, developmental, and routine tasks (`/api/tasks`)
- **Dashboard items** — lightweight named-item resource for bookmarks, links, and notes shown on the Dashboard page (`/api/items`); a separate, simpler resource distinct from the three-type task domain
- **Real-time updates** — Server-Sent Events (SSE) stream for task/run state transitions
- **Email notifications** — task outcome alerts via SMTP or SendGrid

## Project Structure

> The tree below reflects the layout at the time of this writing. Run `tree server/src client/src --dirsfirst` for the authoritative current layout, and keep this section in sync when making structural changes.

```
routini/
├── server/                    # Express.js backend
│   ├── src/
│   │   ├── index.ts           # Server entry point + wiring
│   │   ├── app.ts             # Express app factory (createApp)
│   │   ├── routes.ts          # Main API router (mounts sub-routers)
│   │   ├── config.ts          # Environment-variable config loader
│   │   ├── auth/              # Authentication module
│   │   │   ├── index.ts       # Public exports
│   │   │   ├── config.ts      # Auth config loaded from env
│   │   │   ├── cookies.ts     # Cookie parse/serialize helpers
│   │   │   ├── csrf.ts        # Content-Type: application/json CSRF guard
│   │   │   ├── middleware.ts  # requireAuth / authenticate
│   │   │   ├── passwords.ts   # scrypt hash + verify
│   │   │   ├── rateLimit.ts   # Sliding-window limiter for /login
│   │   │   ├── routes.ts      # /api/auth login/logout/me/session
│   │   │   ├── tokens.ts      # HS256 JWT issue/verify (+ jti)
│   │   │   └── userStore.ts   # User store w/ optional JSON persistence
│   │   ├── aiSettings/        # Per-user AI provider settings
│   │   │   ├── config.ts      # Env-driven encryption-key bootstrap
│   │   │   ├── encryption.ts  # AES-256-GCM Encryptor (at-rest key sealing)
│   │   │   ├── routes.ts      # /api/settings/ai GET/PUT
│   │   │   ├── store.ts       # In-memory AiSettingsStore
│   │   │   ├── types.ts       # AiProvider, AiSettingsView, ...
│   │   │   └── validation.ts  # Input validation for PUT bodies
│   │   ├── tasks/             # Task domain
│   │   │   ├── docker.ts      # Docker executor (ephemeral containers)
│   │   │   ├── events.ts      # Pub/sub event bus (TaskRunEventTransport)
│   │   │   ├── executor.ts    # TaskExecutor contract, retry loop, event bus
│   │   │   ├── index.ts       # Public exports
│   │   │   ├── routes.ts      # /api/tasks CRUD + runs router
│   │   │   ├── sse.ts         # GET /api/tasks/stream SSE endpoint
│   │   │   ├── store.ts       # In-memory TaskStore
│   │   │   ├── types.ts       # Task domain types
│   │   │   ├── validation.ts  # Input validation for task routes
│   │   │   ├── wireEvents.ts  # Canonical SSE wire-format types
│   │   │   ├── daily/         # Daily task handlers
│   │   │   │   ├── dashboardHandler.ts  # HTTP dashboard fetch (SSRF-guarded)
│   │   │   │   ├── dns.ts               # SSRF-safe DNS resolver
│   │   │   │   ├── emailHandler.ts      # IMAP (IMAPS/TLS) mailbox check
│   │   │   │   ├── executor.ts          # Daily-task dispatcher
│   │   │   │   ├── sanitizeError.ts     # Credential-scrubbing wrapper
│   │   │   │   └── sshHandler.ts        # SSH exec via ssh2
│   │   │   ├── developmental/ # Developmental task handlers
│   │   │   │   └── service.ts           # Docker executor bridge (agent images, secrets)
│   │   │   └── routine/       # Routine task orchestration
│   │   │       ├── condition.ts         # Safe condition evaluator (no eval())
│   │   │       └── executor.ts          # Sequential step runner
│   │   └── notifications/     # Email notification service
│   │       ├── config.ts      # Env-driven SMTP/SendGrid config loader
│   │       ├── index.ts       # Public exports + createNotifier factory
│   │       ├── sendgridNotifier.ts  # SendGrid API transport
│   │       ├── smtpNotifier.ts      # SMTP transport (nodemailer)
│   │       ├── taskNotifier.ts      # TaskNotifier: event-bus subscriber
│   │       └── types.ts       # Notifier interface, NotificationMessage
│   ├── vitest.config.ts       # Test discovery for ../tests
│   └── package.json
├── client/                    # React frontend
│   ├── src/
│   │   ├── main.tsx           # Client entry point
│   │   ├── App.tsx            # AuthProvider + shell (Dashboard / Routine Builder / AI Settings)
│   │   ├── App.css            # Component styles (consumes theme.css tokens)
│   │   ├── theme.css          # Single source of truth for the red/orange/black palette
│   │   ├── index.css          # CSS reset + base body (consumes theme.css tokens)
│   │   ├── auth/
│   │   │   ├── AuthContext.tsx  # useAuth() hook
│   │   │   └── authApi.ts       # login/logout/session fetches
│   │   ├── settings/
│   │   │   └── aiSettingsApi.ts # /api/settings/ai typed fetch client
│   │   ├── tasks/
│   │   │   └── tasksApi.ts      # Task CRUD + execution typed fetch client
│   │   ├── hooks/
│   │   │   ├── taskEventWire.ts # Client-side SSE wire-type mirror
│   │   │   └── useTaskEvents.ts # EventSource hook (open/dispatch/close)
│   │   ├── components/
│   │   │   └── AppHeader.tsx    # Shared nav header (Dashboard / Routine Builder / AI Settings / Log out)
│   │   └── pages/
│   │       ├── Login.tsx           # Login form
│   │       ├── Dashboard.tsx       # Item list (auth required)
│   │       ├── AiSettings.tsx      # AI Settings page (provider / API key / defaults)
│   │       └── RoutineBuilder.tsx  # Routine workflow editor (compose + run routines)
│   └── package.json
├── tests/                     # Vitest tests
├── Makefile                   # Build commands
└── package.json               # Root scripts
```

## Prerequisites

- Node.js 18+
- npm

## Getting started

```bash
# Install all workspace dependencies
make install
# or
npm run install:all
```

## Development

```bash
make dev            # Start server (3001) + client (5173) concurrently
make dev-server     # Backend only
make dev-client     # Frontend only
```

Vite proxies `/api` and `/health` from the client dev server (5173) to the
backend (3001) so cookies work as same-origin requests during development.

### Building

```bash
make build          # Compile server (tsc) and client (vite build)
make start          # Run compiled server from dist/
```

Build outputs land in `server/dist/` and `client/dist/`.

## Testing

```bash
make test
# or
cd server && npm test
```

## API Endpoints

**Public / Infrastructure**

| Method | Endpoint                  | Auth | Description                                          |
|--------|---------------------------|------|------------------------------------------------------|
| GET    | `/health`                 | —    | Health check (JSON with ISO timestamp)               |
| GET    | `/api/version`            | —    | Application name and version                         |

**Authentication** (`/api/auth`)

| Method | Endpoint                  | Auth | Description                                          |
|--------|---------------------------|------|------------------------------------------------------|
| POST   | `/api/auth/login`         | —    | Log in, sets an HttpOnly JWT cookie                  |
| POST   | `/api/auth/logout`        | —    | Clears the auth cookie; revokes server-side session  |
| GET    | `/api/auth/session`       | —    | Returns the current user (or `null`)                 |
| GET    | `/api/auth/me`            | ✓    | Returns the current user, 401 if missing             |

**Dashboard items** (`/api/items`) — a lightweight named-item resource separate from the task domain

| Method | Endpoint                  | Auth | Description                                          |
|--------|---------------------------|------|------------------------------------------------------|
| GET    | `/api/items`              | ✓    | List all items owned by the caller                   |
| GET    | `/api/items/:id`          | ✓    | Get a single item                                    |
| POST   | `/api/items`              | ✓    | Create an item (`{ name: string }`)                  |
| DELETE | `/api/items/:id`          | ✓    | Delete an item                                       |

**AI Settings** (`/api/settings/ai`)

| Method | Endpoint                  | Auth | Description                                          |
|--------|---------------------------|------|------------------------------------------------------|
| GET    | `/api/settings/ai`        | ✓    | Read the caller's AI provider settings (key redacted)|
| PUT    | `/api/settings/ai`        | ✓    | Update AI provider settings (partial patch)          |

**Tasks** (`/api/tasks`) — the three-type task domain (daily, developmental, routine)

| Method | Endpoint                  | Auth | Description                                          |
|--------|---------------------------|------|------------------------------------------------------|
| GET    | `/api/tasks`              | ✓    | List tasks owned by caller (optional `?type=` filter)|
| POST   | `/api/tasks`              | ✓    | Create a task (daily, developmental, or routine)     |
| GET    | `/api/tasks/:id`          | ✓    | Get a single task                                    |
| PUT    | `/api/tasks/:id`          | ✓    | Partial-update a task                                |
| DELETE | `/api/tasks/:id`          | ✓    | Delete a task and its runs                           |
| POST   | `/api/tasks/:id/execute`  | ✓    | Trigger execution → returns a TaskRun (202 Accepted) |
| GET    | `/api/tasks/:id/runs`     | ✓    | List all runs for a task                             |
| GET    | `/api/runs/:runId`        | ✓    | Get a single run with logs                           |
| GET    | `/api/tasks/stream`       | ✓    | SSE stream of task/run events for the caller         |

**Error responses**

All error responses have the shape `{ "error": string }`. Common status codes:

| Status | Meaning                                                          |
|--------|------------------------------------------------------------------|
| 400    | Invalid input / validation error                                 |
| 401    | Authentication required or session expired                       |
| 403    | CORS origin not in allowlist                                     |
| 404    | Resource not found (also returned for ownership mismatches)      |
| 409    | Conflict — task is currently queued or running                   |
| 415    | Wrong `Content-Type` (CSRF guard on state-changing methods)      |
| 429    | Rate limit exceeded (login, execute endpoint, or SSE cap)        |
| 500    | Unhandled server error                                           |

The centralized error handler in `server/src/app.ts` never leaks stack traces
or internal messages to clients.

## Configuration

### Core server

| Variable          | Default                  | Description                                    |
| ----------------- | ------------------------ | ---------------------------------------------- |
| `PORT`            | `3001`                   | Express listen port                            |
| `ALLOWED_ORIGINS` | `http://localhost:5173`  | Comma-separated CORS allowlist (no wildcards)  |
| `NODE_ENV`        | `development`            | Set to `production` for prod deployments       |

### Authentication

| Variable                          | Default             | Description                                                                                          |
|-----------------------------------|---------------------|------------------------------------------------------------------------------------------------------|
| `JWT_SECRET`                      | (dev fallback)      | HMAC secret for signing tokens. **Required in production**, ≥ 32 chars. Generate with `openssl rand -base64 48`. |
| `JWT_TTL_SECONDS`                 | `3600` (1 hour)     | Token / cookie lifetime. Capped at 24 hours.                                                         |
| `DEFAULT_ADMIN_USERNAME`          | `admin`             | Seeded on server start when the user store is empty.                                                 |
| `DEFAULT_ADMIN_PASSWORD`          | dev-only literal    | Seeded admin password. **Must be overridden in production or the server refuses to start.**           |
| `USER_STORE_PATH`                 | (in-memory)         | Absolute path to a JSON file. When set, users + sessions survive restarts.                           |
| `LOGIN_RATE_LIMIT_MAX`            | `10`                | Max failed login attempts per (client IP, username) inside the window.                               |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `60`                | Sliding window for the login rate limiter.                                                           |

### AI Settings

| Variable                     | Default         | Description                                                                                                      |
|------------------------------|-----------------|------------------------------------------------------------------------------------------------------------------|
| `AI_SETTINGS_ENCRYPTION_KEY` | (dev ephemeral) | Base64-encoded 32-byte key for AES-256-GCM sealing of stored AI provider API keys. **Required in production.** Generate with `openssl rand -base64 32`. |

### Docker (task execution)

| Variable                       | Required? | Description                                              |
|--------------------------------|-----------|----------------------------------------------------------|
| `DOCKER_HOST`                  | Preferred | Full daemon URL (`tcp://…`, `unix://…`, `ssh://…`).       |
| `DOCKER_TLS_VERIFY`            | Optional  | Set to `1` when using TLS with `DOCKER_HOST=tcp://…`.     |
| `DOCKER_CERT_PATH`             | Optional  | Directory holding `ca.pem` / `cert.pem` / `key.pem`.      |
| `DOCKER_SOCKET_PATH`           | Alternate | Explicit Unix socket path if not using `DOCKER_HOST`.     |
| `DOCKER_ALLOW_DEFAULT_SOCKET`  | Dev only  | Set to `1` to opt in to `/var/run/docker.sock`.           |
| `DOCKER_MEMORY_LIMIT`          | Optional  | Container memory ceiling (bytes). Default 512 MiB.        |
| `DOCKER_MEMORY_SWAP_LIMIT`     | Optional  | Container memory+swap ceiling (bytes).                    |
| `DOCKER_CPU_NANOS`             | Optional  | CPU ceiling in nano-CPUs (default 1 vCPU = `1000000000`). |
| `DOCKER_PIDS_LIMIT`            | Optional  | Container PID ceiling. Default 128.                       |
| `DOCKER_TIMEOUT_MS`            | Optional  | Wall-clock deadline for a run (ms). Default 15 minutes.   |
| `DOCKER_TMPFS_SIZE_BYTES`      | Optional  | `/tmp` tmpfs size cap (bytes). Default 64 MiB.            |
| `DOCKER_GIT_NETWORK`           | Optional  | Docker network for git-capable developmental tasks. Default `routini-egress`. |
| `ROUTINI_GIT_TOKEN`            | Optional  | HTTPS personal-access token for git clone/push in developmental tasks. |

### Notifications (email)

| Variable             | Default                  | Description                                                                          |
|----------------------|--------------------------|--------------------------------------------------------------------------------------|
| `NOTIFY_PROVIDER`    | (disabled)               | Set to `smtp` or `sendgrid` to enable notifications. Omit to disable.               |
| `NOTIFY_FROM_EMAIL`  | `no-reply@routini.app`   | From address on notification emails.                                                 |
| `NOTIFY_FROM_NAME`   | `Routini`                | Display name in the From header.                                                     |
| `NOTIFY_TO_EMAIL`    | (none)                   | Fallback recipient when the task owner's username is not an email address.           |
| `SMTP_HOST`          | (required for smtp)      | SMTP server hostname.                                                                |
| `SMTP_PORT`          | `587`                    | SMTP server port.                                                                    |
| `SMTP_SECURE`        | `false`                  | Set to `true` for port-465 implicit TLS.                                             |
| `SMTP_USER`          | (required for smtp)      | SMTP login username.                                                                 |
| `SMTP_PASS`          | (required for smtp)      | SMTP login password. Never logged or returned via any API.                           |
| `SENDGRID_API_KEY`   | (required for sendgrid)  | SendGrid API key. Never logged or returned via any API.                              |

## Authentication

- The server issues an HMAC-SHA256 JWT on `POST /api/auth/login` and sets it in
  an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production).
- The middleware accepts either the cookie or an `Authorization: Bearer <jwt>`
  header, so both browser and machine clients work.
- All `/api/items*`, `/api/tasks*`, and `/api/settings/ai*` routes require an
  authenticated session; `/api/version`, `/api/auth/login`, and `/api/auth/session`
  are public.
- Login intentionally returns the same generic error for "unknown user" and
  "wrong password" to avoid enumerating accounts.
- Passwords are hashed with `crypto.scrypt` (memory-hard, no third-party
  dependency), and verification uses `timingSafeEqual`. Cost parameters are
  `N=2^15`, `r=8`, `p=1`, matching RFC 7914 §2 for interactive login flows.

### CSRF protection

`SameSite=Lax` blocks the classic HTML-form CSRF payload, but we layer a second
guard on top: **every state-changing endpoint (`POST`, `PUT`, `PATCH`, `DELETE`)
must declare `Content-Type: application/json`**, or the server rejects the request
with `415 Unsupported Media Type`.

Why this works as CSRF protection:

- HTML `<form>` submissions cannot set `Content-Type: application/json` — the
  spec restricts them to `application/x-www-form-urlencoded`,
  `multipart/form-data`, or `text/plain`.
- Cross-origin `fetch()` with `Content-Type: application/json` triggers a
  CORS preflight, which our server does not answer for arbitrary origins.

### Session lifetime and revocation

Each token embeds a random `jti` claim and the auth middleware requires that id
to still be on the user's active session allowlist. `POST /api/auth/logout`
removes the caller's session id from the allowlist, so the same token stops
working immediately after logout — even if an attacker has copied it.

Session allowlists are capped at 10 concurrent sessions per user with FIFO
eviction; the session registered longest ago is dropped when a new login pushes
past the cap.

### Login rate limiting

`POST /api/auth/login` is protected by a per-process sliding-window rate
limiter keyed on `(client IP, normalized username)`. Tripping the limit returns
`429 Too Many Requests` with a `Retry-After` header.

### User store persistence

Setting `USER_STORE_PATH=/absolute/path/to/users.json` switches to a JSON-file
backend with atomic writes (temp file + rename) and `0600` file permissions.
Relative or non-absolute paths are rejected on startup.

### Deployment scope and known limitations

The authentication module in this milestone is designed for a **single backend
instance**. Multi-replica gaps:

- **Session revocation is per-process** — logging out on one pod does not
  invalidate a token that reaches another pod.
- **Rate limiting is per-process** — ten replicas means ten times the attempts
  before the limit trips.
- **The JSON file store is not a database** — do not point two processes at the
  same file. Point production systems at PostgreSQL via a future adapter.

## Task system

### Task types

| Type           | Description                                                                       |
|----------------|-----------------------------------------------------------------------------------|
| `daily`        | Automated action: SSH command, IMAP email check, or HTTP dashboard fetch.         |
| `developmental`| AI coding job executed in an ephemeral Docker container (supports git clone/push).|
| `routine`      | Multi-step workflow that runs daily + developmental tasks sequentially.            |

### Execution model

`POST /api/tasks/:id/execute` returns `202 Accepted` immediately with a
`TaskRun` object. Execution proceeds asynchronously:

1. A `TaskRun` is created and the task status transitions to `queued`.
2. The executor retries up to **3 times with exponential backoff** (500 ms →
   1 s → 2 s) before marking the task `failed`.
3. Each attempt creates a fresh `TaskRun` with a complete log so operators see
   every attempt rather than a merged history.
4. State transitions are published to the SSE event bus.

A per-user rate limiter (default: 20 triggers per minute) prevents DoS via
resource exhaustion.

### Routine step conditions

Routine steps may carry an optional condition evaluated at runtime against the
previous step's result. Supported syntax:

```
previous.status === 'succeeded'
previous.status !== 'failed'
```

The evaluator uses a strict allowlist regex — `eval()` and the `Function()`
constructor are never used, so a malicious condition stored in the database
cannot execute arbitrary server-side JavaScript.

### Real-time updates — SSE stream

Task/run state transitions are published over a pluggable pub/sub
`TaskRunEventTransport` bus. The default `InProcessTaskRunEventBus` is a
lightweight `EventEmitter` wrapper suitable for single-process deployments.
Distributed adapters (Redis Pub/Sub, NATS, etc.) can drop in at the composition
root by implementing the same interface.

The SSE endpoint is at **`GET /api/tasks/stream`**. Every frame is a standard
SSE event with a `type` field and a JSON `data` payload:

```
retry: 5000

event: task-status
data: {"type":"task-status","taskId":"…","status":"running"}

event: run-log
data: {"type":"run-log","taskId":"…","runId":"…","log":{"timestamp":"…","message":"…","level":"info"}}
```

**Wire event types** (canonical source: `server/src/tasks/wireEvents.ts`; mirrored on the client in `client/src/hooks/taskEventWire.ts`):

| Event type      | Payload fields                                                              |
|-----------------|-----------------------------------------------------------------------------|
| `task-created`  | `taskId`, `taskType` (`'daily'│'developmental'│'routine'`)                  |
| `task-deleted`  | `taskId`                                                                    |
| `task-status`   | `taskId`, `status` (`'idle'│'queued'│'running'│'succeeded'│'failed'`)       |
| `run-created`   | `taskId`, `runId`                                                           |
| `run-status`    | `taskId`, `runId`, `status`, `completedAt?` (ISO string), `error?` (string) |
| `run-log`       | `taskId`, `runId`, `log: { timestamp, message, level: 'info'│'warn'│'error' }` |

All payloads also carry the `type` field (matches the event name) so clients can discriminate in a single `onmessage` handler as well as via named event listeners.

**Security and isolation:**
- Auth enforced by `requireAuth` middleware — same cookie/bearer as every other `/api/*` route.
- Events are filtered by ownership; `task-deleted` events are only forwarded for
  task IDs the caller has already seen on the stream.
- Concurrent connections per user are capped (default 4); hitting the cap returns `429`.
- A per-connection in-flight byte ceiling (default 1 MiB) sheds slow consumers
  with a `stream-overrun` control comment rather than buffering unbounded logs.
- A heartbeat comment (`: keepalive`, every 15 s) keeps NAT/proxy idle timers happy.

**Client usage** via `client/src/hooks/useTaskEvents.ts`:

```typescript
import { useTaskEvents } from './hooks/useTaskEvents'

useTaskEvents({
  onTaskStatus: (e) => updateTaskStatus(e.taskId, e.status),
  onRunLog:     (e) => appendLog(e.runId, e.log),
})
```

The hook opens an `EventSource`, dispatches per-type events, and closes on
unmount. It is a no-op when `EventSource` is unavailable (SSR / test contexts).

**Wire format contract:** The SSE frame types live in one canonical file
(`server/src/tasks/wireEvents.ts`) and are mirrored on the client
(`client/src/hooks/taskEventWire.ts`). A filesystem contract test
(`tests/tasks.wireContract.test.ts`) enforces byte-for-byte parity so the
wire cannot drift silently.

**Horizontal scaling:** The in-process bus is a single-process transport. A
run executed on pod A would not reach an SSE client held by pod B. Multi-replica
deployments must inject a distributed transport (e.g. Redis Pub/Sub):

```typescript
class RedisTaskRunEventBus implements TaskRunEventTransport {
  // emit() → pub.publish(channel, JSON.stringify(event))
  // on(l)  → sub.on('message', …); return unsubscribe fn
  // listenerCount() → local EventEmitter count
}
```

### Task persistence and scalability — known limitations

The task store (`server/src/tasks/store.ts`) is currently **in-memory only**.
Multi-replica deployments must either:
- Pin sessions to a single replica (sticky-session load balancing), or
- Introduce a shared store (PostgreSQL or Redis) behind the `TaskStore` shape.

Secrets on stored tasks (`SshConfig.password`, `SshConfig.privateKey`,
`EmailConfig.password`) live only in process heap. Any persistent replacement
**MUST** encrypt those fields with AES-256-GCM before writing and redact them
from query logs and audit trails. The route layer (`sanitizeTask` in
`tasks/routes.ts`) already strips credentials from every API response.

## Daily task handlers

Daily tasks live in `server/src/tasks/daily/` and dispatch through
`createDailyExecutor` to one of three concrete handlers.

### SSH command execution (`sshHandler.ts`)

- Uses the `ssh2` client. Password or PEM-encoded private key auth.
- Blocks any host in an SSRF-unsafe range (loopback, RFC 1918, cloud metadata)
  at handler entry.
- Enforces a wall-clock timeout (default 30 s) and per-stream output caps
  (default 1 MiB).
- Every thrown error goes through `sanitizeError` with the password and private
  key in the `sensitive` list, so credentials cannot appear in logs or task-run
  errors.

### IMAP mailbox check (`emailHandler.ts`)

- Hand-rolled RFC 3501 subset over `tls.connect` with `rejectUnauthorized: true`.
  IMAPS (port 993) only — STARTTLS-on-plaintext is intentionally not supported.
- Uses `EXAMINE` (read-only SELECT) so a daily poll never mutates `/Seen` flags.
- IMAP-quotes every argument and refuses arguments containing CR/LF to prevent
  IMAP command injection.
- Response buffer capped at 64 KiB; wall-clock deadline enforced by a
  top-level `setTimeout`.
- Same `sanitizeError` wrapping as the SSH handler.

### HTTP dashboard fetch (`dashboardHandler.ts`)

- Uses the global `fetch` (Node 18+). URL scheme and hostname are re-validated
  on every hop (initial request + each 3xx redirect).
- **SSRF hardening:** `resolveHostnameSafe` in `dns.ts` re-resolves the hostname
  immediately before the request and fails if any A/AAAA record targets a
  private range. This closes the DNS-rebinding hole that validation-time checks
  alone leave open.
- Redirects are followed **manually** (`redirect: 'manual'`) so each hop passes
  through the same validation → DNS-pin gate.
- Response body capped at 1 MiB; sensitive response headers (`Set-Cookie`,
  `WWW-Authenticate`, `Authorization`) are dropped from the returned summary.

### Shared helpers

- **`sanitizeError.ts`** — wraps every external call. Two-pass scrub: literal
  credential substrings are replaced with `[REDACTED]`; a regex pass strips
  common secret shapes (PEM blocks, `Authorization:` header lines, URL userinfo,
  `Bearer …`). The resulting `Error.message` is safe to log or persist; the
  original is kept on `.cause` for server-side observability.
- **`dns.ts`** — `resolveHostnameSafe` re-resolves and re-validates the hostname.
  Rejects with a coded `UnsafeHostError` (`UNSAFE_HOST`, `DNS_LOOKUP_FAILED`,
  `NO_ADDRESSES`) so callers can key on the code rather than message text.

## Developmental task execution (Docker)

Developmental tasks execute inside ephemeral Docker containers via the
[`dockerode`](https://github.com/apocas/dockerode) SDK. The executor chain is:

1. `createDevelopmentalExecutor` (`tasks/developmental/service.ts`) — maps
   agent names to pinned sandbox images, mounts credentials as tmpfs-backed
   secrets, and wires git network access.
2. `createDockerExecutor` (`tasks/docker.ts`) — manages the container lifecycle
   (create, start, wait, remove) with all security defaults applied.

### Security defaults (`DEFAULT_DOCKER_CONFIG`)

| Field                        | Value                              | Why                                            |
|------------------------------|------------------------------------|------------------------------------------------|
| `User`                       | `"1000:1000"`                      | Never run as root inside the container.        |
| `HostConfig.CapDrop`         | `["ALL"]`                          | Drop every Linux capability.                   |
| `HostConfig.Privileged`      | `false`                            | Explicitly disable privileged mode.            |
| `HostConfig.ReadonlyRootfs`  | `true`                             | Root filesystem is read-only.                  |
| `HostConfig.NetworkMode`     | `"none"`                           | No network by default.                         |
| `HostConfig.SecurityOpt`     | `["no-new-privileges"]`            | Block setuid escalation.                       |
| `HostConfig.PidsLimit`       | `128`                              | Cap fork-bomb blast radius.                    |
| `HostConfig.Memory`          | `512 MiB`                          | Hard memory limit.                             |
| `HostConfig.NanoCpus`        | `1 000 000 000` (1 vCPU)           | 1 vCPU cap.                                    |
| `HostConfig.Tmpfs["/tmp"]`   | `rw,noexec,nosuid,nodev,size=64 MiB` | Writable scratch dir (most AI agents need it). |

### Secrets handling

Credentials (AI API keys, git tokens) are **never** passed as environment
variables. They are mounted as per-container tmpfs entries with `0400`
permissions via the `secretFiles` mechanism, so they do not appear in
`docker inspect` output or crash dumps. Agents discover file paths via
`ROUTINI_AI_KEY_FILE` / `ROUTINI_GIT_TOKEN_FILE` environment variables.

### Supported agents

| Agent name    | Sandbox image                              |
|---------------|--------------------------------------------|
| `opencode`    | `ghcr.io/routini/agent-opencode:0.1.0`     |
| `claude-code` | `ghcr.io/routini/agent-claude-code:0.1.0`  |
| `omnimancer`  | `ghcr.io/routini/agent-omnimancer:0.1.0`   |

### Docker daemon connection (fail-secure)

`resolveDockerConnection(env)` throws `DockerExecutionError('INSECURE_CONNECTION')`
rather than silently falling back to the host Docker socket when no explicit
connection is configured.

Resolution order:
1. `DOCKER_HOST` — accepts `tcp://host:port`, `unix:///path/to/sock`, or `ssh://user@host`.
2. `DOCKER_SOCKET_PATH` — explicit Unix socket path.
3. `DOCKER_ALLOW_DEFAULT_SOCKET=1` — **explicit dev-only opt-in** to `/var/run/docker.sock`.
4. Otherwise: throws.

### Retry policy

Only *daemon connection* operations retry:

| Operation         | Retryable? | Backoff                        |
|-------------------|-----------|--------------------------------|
| `createContainer` | Yes       | Exponential: 200 → 400 → 800 ms |
| `container.start` | Yes       | Same as above                  |
| `container.wait`  | No        | Wait completes once, timeout applies |
| Non-zero exit     | No        | Fails the run immediately      |

### Lifecycle guarantees

`container.remove({ force: true, v: true })` runs in a `finally` block so
removal happens whether the container succeeds, fails, or is killed by the
wall-clock timeout. If cleanup itself fails, the executor logs the removal
error and re-throws the original workload error.

## Email notifications

The notifications module (`server/src/notifications/`) sends email whenever a
task transitions to `succeeded` or `failed`.

### How it works

1. `TaskNotifier.start(bus)` subscribes to the task event bus and returns an
   unsubscribe function (call on server shutdown).
2. On a `task-status` event with `status === 'succeeded'` or `'failed'`, the
   notifier resolves the recipient: it uses the task owner's username if it looks
   like an email address (`username.indexOf('@') > 0`), otherwise falls back to
   `NOTIFY_TO_EMAIL`.
3. A delivery failure is logged server-side (without PII) but never surfaces to
   the HTTP client — task execution has already returned `202 Accepted`.

### Supported transports

| Transport   | `NOTIFY_PROVIDER` | Required variables                        |
|-------------|-------------------|-------------------------------------------|
| SMTP        | `smtp`            | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`     |
| SendGrid    | `sendgrid`        | `SENDGRID_API_KEY`                        |
| (disabled)  | (unset)           | —                                         |

Both transports send both `text` and `html` bodies. The HTML email follows the
PRD's red/orange/black palette.

### Security notes

- `SMTP_PASS` and `SENDGRID_API_KEY` are read once at startup and never logged
  or returned via any API.
- Recipient addresses are never logged (treated as PII); only the `taskId` and
  `status` appear in server-side error entries.
- A misconfigured provider (e.g. `NOTIFY_PROVIDER=smtp` without `SMTP_HOST`)
  fails loudly at startup via `validateNotificationConfig` rather than silently
  dropping notifications.

## AI Settings

The AI Settings page (`client/src/pages/AiSettings.tsx`) lets a signed-in
user configure the AI provider that developmental tasks call, store the
provider's API key, pick a default agent for new developmental tasks, and
tune model parameters (model, temperature, maxTokens).

### Update semantics

The `PUT /api/settings/ai` body is a **partial patch**:

- Omit a field → leave its current value alone.
- Send `null` → clear the value.
- Send a non-null value → replace.

The `apiKey` field is **write-only**: it is never included in any GET or
PUT response. The response instead carries a `hasApiKey: boolean` flag so
the UI can render "Configured" vs. "Not configured" without ever holding
the plaintext key in the browser.

### Encryption at rest

API keys are sealed with **AES-256-GCM** (authenticated encryption)
before being stored, using a per-record random 12-byte IV.

- **Production** requires `AI_SETTINGS_ENCRYPTION_KEY` — a base64-encoded
  32-byte key sourced from a KMS or secret manager. Missing or malformed
  keys stop the server at startup.
- **Development** falls back to a per-process random key with a loud
  `console.warn`. Restarts invalidate every stored API key on the
  fallback path — do not use it outside local dev.

### Validation

`validateUpdateAiSettings` enforces:

- `provider` and `defaultAgent`: enum-only (`opencode`, `claude-code`,
  `omnimancer`) or `null`.
- `apiKey`: non-empty string ≤ 4096 chars, or `null` to clear.
- `model`: non-empty string ≤ 200 chars, or `null`.
- `temperature`: finite number in `[0, 2]`, or `null`.
- `maxTokens`: integer in `[1, 200_000]`, or `null`.
- Unknown top-level fields are rejected so a client typo surfaces as a 400.

## Routine Builder

The Routine Builder page (`client/src/pages/RoutineBuilder.tsx`) provides a
two-panel interface:

- **Left panel — My Routines:** lists existing routines with their last run
  status, and Run / Edit / Delete actions.
- **Right panel — Build / Edit Routine:** step-wise editor with task selection
  from the caller's existing daily and developmental tasks. Steps can be
  reordered with ▲/▼ buttons and carry optional conditions from a preset
  dropdown (no free-text entry, preventing invalid condition strings from
  reaching the API).

## Theme

The UI uses the PRD-mandated red / orange / black palette:

- `--color-red: #ff0000ff` (PRD `#FF0000`)
- `--color-orange: #ffa500ff` (PRD `#FFA500`)
- `--color-black: #000000ff` (PRD `#000000`)

All palette tokens live in **one file** — `client/src/theme.css` — and every
other stylesheet (`index.css`, `App.css`) imports it with
`@import './theme.css';`. Every token is declared as **8-digit hex**
(`#rrggbbaa`) so opaque and translucent colors share one consistent format.

`tests/client.theme.test.ts` enforces this contract: the three PRD colors must
exist as tokens, every declared token uses `#rrggbbaa` shape, and no other CSS
or TSX file may declare a palette hex literal.

## Security baseline

- **[Helmet](https://helmetjs.github.io/)** middleware sets
  `X-Content-Type-Options: nosniff`, `X-Frame-Options`, a conservative
  Content-Security-Policy, and Strict-Transport-Security on every response.
- **CORS** uses an explicit allowlist — no wildcards. Requests from origins
  outside `ALLOWED_ORIGINS` are rejected with `403`.
- **JSON body limit** of `100kb` on all endpoints guards against trivial
  payload-DoS on unauthenticated routes.
- **Error handler** logs the underlying cause server-side but only sends a
  generic message to the client — no stack traces or internal state leak across
  the wire.
- **`.gitignore`** blocks `node_modules/`, npm caches, `dist/`/`build/`, and
  every `.env*` variant so credentials never accidentally enter git.

## Test coverage

```bash
make test
# or
npm run test
```

Test coverage includes:

- **Auth tokens** — JWT sign/verify (tampered payload, wrong secret, expiration, malformed input, `jti` round-trip)
- **Passwords** — round-trip, wrong password, random salts, malformed hash, oversized scrypt parameter rejection
- **Cookies** — URL encoding, duplicates, header-injection defense
- **CSRF middleware** — safe methods pass, `application/json` allowed, form/plain content types rejected with 415
- **User store** — normalization, duplicates, session tracking, file persistence + malformed-file handling
- **Auth config** — production `JWT_SECRET`/`DEFAULT_ADMIN_PASSWORD` requirements, TTL cap, absolute-path guard, rate-limit env vars
- **Rate limiter** — allow→deny transition, window recovery, per-key isolation, reset on success, memory bounding
- **Auth routes integration** — real HTTP requests: login, logout, session revocation (stolen-cookie invalidation), rate-limiting (429 + `Retry-After`), CSRF Content-Type check
- **AI settings encryption** — round-trip, per-record IV uniqueness, ciphertext/IV/tag tamper detection, wrong-key rejection, wrong-length key rejection, unicode + empty-plaintext round-trip
- **AI settings store** — per-user isolation, API key redaction, partial update / explicit-clear semantics, plaintext round-trip via internal accessor
- **AI settings validation** — enum providers/agents, numeric range on temperature/maxTokens, oversized key/model rejection, unknown-field rejection
- **AI settings encryption-key bootstrap** — `resolveAiEncryptor` production fail-fast, dev fallback + `console.warn`
- **AI settings integration** — `/api/settings/ai` end-to-end: auth 401, CSRF 415, defaults on GET, full/partial PUT, `null` clearing, per-user isolation, plaintext key never leaks over the wire
- **Task event bus + store emission** — listener fan-out, unsubscribe, listener-error isolation, no-op-when-unchanged status filtering
- **Task executor (unit)** — retry loop, exponential backoff, final failure marking, per-attempt run records
- **SSE stream integration** — 401 without auth, cookie-based session, `text/event-stream` headers, `connected` comment, heartbeat cadence, subscriber cleanup on client disconnect, per-user ownership filtering, in-order log delivery, concurrent-connection cap
- **SSE wire contract** — byte-for-byte parity between `server/src/tasks/wireEvents.ts` and `client/src/hooks/taskEventWire.ts`, and all required event type literals present in both files
- **`useTaskEvents` hook** — happy-path dispatch, missing-handler no-op, JSON parse-error isolation, empty-`data` frame survival, exhaustive wire-union coverage
- **Task CRUD routes** — create/list/get/update/delete for all three task types, auth 401, CSRF 415, ownership 404 (not enumerable), conflict 409 (queued/running guard), execute rate-limit 429
- **Task store** — CRUD operations, run lifecycle, per-user isolation
- **Task validation** — daily subtypes, developmental repo URL + agent name, routine step conditions, unknown-field rejection
- **Daily task handlers** — SSH exec (SSRF guard, timeout, output cap, credential redaction), IMAP mailbox check (TLS, IMAP injection guard, buffer cap), HTTP dashboard fetch (SSRF, DNS rebinding, manual redirect, body cap)
- **Docker executor** — image-name allowlist (positive + rejection matrix), security defaults propagation, resource-limit injection, tmpfs mount, network-mode override with audit log, secret-mount staging + path-traversal rejection + shell-escape, retry with exponential backoff, workload errors NOT retried, wall-clock timeout with guaranteed cleanup, cleanup failure never masking primary error, fail-secure daemon connection resolution
- **Developmental task service** — agent image selection, AI API key and git token secret mounts, network mode wiring, per-user AI key retrieval, shell-injection guard on repo URL, unknown agent rejection
- **Routine condition evaluator** — `===` / `!==` patterns, valid + invalid statuses, first-step undefined context, unrecognized pattern fail-safe
- **Routine executor** — sequential step execution, condition skip, cross-user task rejection, nested routine rejection, sub-run orphan cleanup, all-steps-succeeded path
- **Notifications config** — SMTP + SendGrid loading, validation errors, defaults, `NOTIFY_TO_EMAIL`
- **Notifications transports** — SMTP and SendGrid `send()` happy-path and error-path
- **Task notifier** — `task-status` event filtering, recipient resolution (email username vs. fallback), delivery-failure fire-and-forget (never propagated to executor), deleted-task no-op
- **Dashboard parsing** — `parseItemsResponse` happy path, malformed/unexpected response shapes

## Architecture notes

- `createApp(options?)` in `server/src/app.ts` returns a fully wired Express app.
  It accepts `{ config, authDeps, notifier, executor, aiSettings }` — when
  `authDeps` is supplied (the production wiring in `index.ts`), the auth router
  and the main router are mounted; when omitted (skeleton smoke tests), only the
  public `/api/version` endpoint is mounted. `index.ts` only handles process
  concerns (config load, auth bootstrap, `listen`). This split keeps the app
  trivially testable via supertest.
- Environment parsing lives in `server/src/config.ts` behind a single
  `loadConfig()` factory so `process.env` reads have one seam.
- The `TaskStore`, `UserStore`, `AiSettingsStore`, and `TaskRunEventTransport`
  are all interface-shaped — in-memory implementations are provided for the MVP
  and can be swapped for PostgreSQL/Redis adapters at the composition root
  without touching route or executor code.

## License

MIT
