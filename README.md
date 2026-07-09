# routini

Routini is an autonomous engineer platform for defining and running three
kinds of tasks: **daily** operations (SSH, email checks, dashboards),
**developmental** coding jobs that execute in Docker containers with a
selectable AI agent, and **routines** that orchestrate the two.

This repository currently contains the initial skeleton: a TypeScript
Express backend and a React + Vite frontend, wired together with a shared
API contract, a global error handler, a security baseline (Helmet +
explicit CORS allowlist), and a supertest-driven integration test suite.
Subsequent PRD tasks (auth, task CRUD, Docker orchestration, routine
builder, AI settings, theming, notifications, real-time updates) build
on top of this foundation.

The AI Settings page and its `/api/settings/ai` API — provider selection,
API-key storage encrypted at rest with AES-256-GCM, default agent, and
model parameters — are wired up as of the AI settings milestone (see
*AI Settings* below).

- Express.js backend with TypeScript
- React frontend with Vite
- Hot module replacement for both client and server
- API proxy configuration
- Type-safe development
- **Authentication** — password login with HTTP-only JWT cookies, protected API routes, and a themed login/logout UI

## Project Structure

```
routini/
├── server/                    # Express.js backend
│   ├── src/
│   │   ├── index.ts           # Server entry point + wiring
│   │   ├── routes.ts          # /api item routes (auth-protected)
│   │   ├── aiSettings/        # Per-user AI provider settings
│   │   │   ├── config.ts      # Env-driven encryption-key bootstrap
│   │   │   ├── encryption.ts  # AES-256-GCM Encryptor (at-rest key sealing)
│   │   │   ├── routes.ts      # /api/settings/ai GET/PUT
│   │   │   ├── store.ts       # In-memory AiSettingsStore
│   │   │   ├── types.ts       # AiProvider, AiSettingsView, ...
│   │   │   └── validation.ts  # Input validation for PUT bodies
│   │   ├── tasks/             # Task domain
│   │   │   ├── docker.ts      # Docker executor (ephemeral containers)
│   │   │   ├── executor.ts    # TaskExecutor contract, retry loop, event bus
│   │   │   ├── routes.ts      # /api/tasks CRUD + runs
│   │   │   ├── store.ts       # In-memory TaskStore
│   │   │   ├── types.ts       # Task domain types
│   │   │   ├── validation.ts  # Input validation for task routes
│   │   │   └── daily/         # Daily task handlers
│   │   │       ├── dashboardHandler.ts  # HTTP dashboard fetch (SSRF-guarded)
│   │   │       ├── dns.ts               # SSRF-safe DNS resolver
│   │   │       ├── emailHandler.ts      # IMAP (IMAPS/TLS) mailbox check
│   │   │       ├── executor.ts          # Daily-task dispatcher
│   │   │       ├── sanitizeError.ts     # Credential-scrubbing wrapper
│   │   │       └── sshHandler.ts        # SSH exec via ssh2
│   │   └── auth/              # Authentication module
│   │       ├── index.ts       # Public exports
│   │       ├── config.ts      # Auth config loaded from env
│   │       ├── cookies.ts     # Cookie parse/serialize helpers
│   │       ├── csrf.ts        # Content-Type: application/json CSRF guard
│   │       ├── middleware.ts  # requireAuth / authenticate
│   │       ├── passwords.ts   # scrypt hash + verify
│   │       ├── rateLimit.ts   # Sliding-window limiter for /login
│   │       ├── routes.ts      # /api/auth login/logout/me/session
│   │       ├── tokens.ts      # HS256 JWT issue/verify (+ jti)
│   │       └── userStore.ts   # User store w/ optional JSON persistence
│   ├── vitest.config.ts       # Test discovery for ../tests
│   └── package.json
├── client/                    # React frontend
│   ├── src/
│   │   ├── main.tsx           # Client entry point
│   │   ├── App.tsx            # AuthProvider + shell
│   │   ├── App.css            # Component styles (consumes theme.css tokens)
│   │   ├── theme.css          # Single source of truth for the red/orange/black palette
│   │   ├── index.css          # CSS reset + base body (consumes theme.css tokens)
│   │   ├── auth/
│   │   │   ├── AuthContext.tsx  # useAuth() hook
│   │   │   └── authApi.ts       # login/logout/session fetches
│   │   ├── settings/
│   │   │   └── aiSettingsApi.ts # /api/settings/ai typed fetch client
│   │   ├── components/
│   │   │   └── AppHeader.tsx    # Shared nav header (Dashboard / AI Settings / Log out)
│   │   └── pages/
│   │       ├── Login.tsx        # Login form
│   │       ├── Dashboard.tsx    # Item list (auth required)
│   │       └── AiSettings.tsx   # AI Settings page (provider / API key / defaults)
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
backend (3001).

The Vite dev server proxies `/api` and `/health` to the backend so cookies work
as a same-origin request during development.

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

## Configuration

The auth module reads configuration from environment variables. Sensible defaults
are used in development; production requires `JWT_SECRET`, a non-default
`DEFAULT_ADMIN_PASSWORD`, **and** an `AI_SETTINGS_ENCRYPTION_KEY` to be set — the
server refuses to start otherwise.

| Variable                          | Default             | Description                                                                                          |
|-----------------------------------|---------------------|------------------------------------------------------------------------------------------------------|
| `JWT_SECRET`                      | (dev fallback)      | HMAC secret for signing tokens. **Required in production**, ≥ 32 chars.                              |
| `JWT_TTL_SECONDS`                 | `3600` (1 hour)     | Token / cookie lifetime. Capped at 24 hours. Kept short deliberately — see *Session lifetime* below. |
| `DEFAULT_ADMIN_USERNAME`          | `admin`             | Seeded on server start when the user store is empty.                                                 |
| `DEFAULT_ADMIN_PASSWORD`          | dev-only literal    | Seeded admin password. **Must be overridden in production or the server refuses to start.** Do not copy the dev default into a real deployment — pick a fresh secret per environment. |
| `USER_STORE_PATH`                 | (in-memory)         | Absolute path to a JSON file. When set, users + sessions survive restarts.                           |
| `LOGIN_RATE_LIMIT_MAX`            | `10`                | Max failed login attempts per (client IP, username) inside the window.                               |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `60`                | Sliding window for the login rate limiter.                                                           |
| `AI_SETTINGS_ENCRYPTION_KEY`      | (dev ephemeral)     | Base64-encoded 32-byte key for AES-256-GCM sealing of stored AI provider API keys. **Required in production.** Generate with `openssl rand -base64 32`. |
| `NODE_ENV`                        | `development`       | When `production`, the auth cookie is emitted with `Secure`.                                         |

Generate a production `JWT_SECRET` with, for example, `openssl rand -base64 48`
or `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
Anything shorter than 32 bytes is refused at startup.

## Authentication

- The server issues an HMAC-SHA256 JWT on `POST /api/auth/login` and sets it in
  an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production).
- The middleware accepts either the cookie or an `Authorization: Bearer <jwt>`
  header, so both browser and machine clients work.
- All `/api/items*` routes require an authenticated session; `/api/version` is
  public.
- Login intentionally returns the same generic error for "unknown user" and
  "wrong password" to avoid enumerating accounts.
- Passwords are hashed with `crypto.scrypt` (memory-hard, no third-party
  dependency), and verification uses `timingSafeEqual`. Cost parameters are
  `N=2^15`, `r=8`, `p=1`, matching RFC 7914 §2 for interactive login flows;
  stored records with parameters outside safe bounds (`N > 2^20`, `r > 32`,
  `p > 16`) are rejected on verify to prevent a poisoned hash from stalling
  the process.

### CSRF protection

`SameSite=Lax` blocks the classic HTML-form CSRF payload, but the reviewer
correctly flagged that it is not a complete defense on its own (older
browsers, top-level navigation edge cases, etc.). We layer a second guard on
top: **every state-changing endpoint (`POST`, `PUT`, `PATCH`, `DELETE`) must
declare `Content-Type: application/json`**, or the server rejects the request
with `415 Unsupported Media Type`.

Why this works as CSRF protection:

- HTML `<form>` submissions cannot set `Content-Type: application/json` — the
  spec restricts them to `application/x-www-form-urlencoded`,
  `multipart/form-data`, or `text/plain`. The classic "hidden form
  auto-submits" CSRF attack is therefore ineffective.
- Cross-origin `fetch()` with `Content-Type: application/json` triggers a
  CORS preflight, which our server does not answer for arbitrary origins.

Both the browser client and the integration tests already send this header;
machine clients that use `Authorization: Bearer <jwt>` should do the same. A
per-token double-submit scheme (`X-CSRF-Token`) can be layered on top later
without changing the wire format for existing clients.

### Session lifetime and revocation

Stateless JWTs cannot be revoked purely on the client side — clearing the
cookie doesn't invalidate a copy an attacker may have stolen. To close that
gap without giving up JWT simplicity, we:

1. **Keep TTL short** (1 hour by default, capped at 24 hours). Shorter tokens
   mean smaller blast radius when leaked; longer sessions belong behind an
   OAuth-style refresh flow, not a bumped JWT lifetime. A dedicated refresh
   token endpoint is **out of scope for this milestone** — clients simply
   re-authenticate when the JWT expires.
2. **Track session ids server-side.** Each token embeds a random `jti` claim,
   and the auth middleware requires that id to still be on the user's active
   session allowlist. `POST /api/auth/logout` removes the caller's session id
   from the allowlist, so the same token stops working immediately — even if
   an attacker has copied it. Other sessions for the same user are unaffected.
3. **Cap concurrent sessions** at 10 per user with **FIFO eviction** — the
   session registered longest ago is dropped when a client keeps logging in
   without ever logging out. FIFO (rather than LRU) is deliberate: session
   validity is a signature check, not a hot-path read, so LRU accounting
   would add complexity for no measurable benefit.

### Login rate limiting

`POST /api/auth/login` is protected by a per-process sliding-window rate
limiter keyed on `(client IP, normalized username)`. Username normalization
matches the user store: `.trim().toLowerCase()`, truncated to 64 characters.
That means `alice`, `ALICE`, and `  alice  ` all share a single bucket, so
an attacker can't dodge the limit by varying casing or padding whitespace.

The default — `LOGIN_RATE_LIMIT_MAX=10` attempts per
`LOGIN_RATE_LIMIT_WINDOW_SECONDS=60` seconds — throttles brute-force attempts
while leaving room for the occasional typo. Tripping the limit returns
`429 Too Many Requests` with a `Retry-After` header, and a successful login
resets the counter for that key.

### User store persistence

By default the user store is in-memory: fast, zero-config, and appropriate for
development / tests. Setting `USER_STORE_PATH=/absolute/path/to/users.json`
switches to a JSON-file backend with atomic writes (temp file + rename) and
`0600` file permissions. Password hashes and session ids survive restarts, so
operators can restart the server without kicking every user out. Relative or
non-absolute paths are rejected on startup to avoid CWD ambiguity.

### Deployment scope and known limitations

The PRD calls out horizontal scalability as a Non-Functional Requirement
(worker nodes added as load grows). The **authentication module in this
milestone is designed for a single backend instance** and has the following
gaps against a fully clustered deployment; all three are on the roadmap and
require a shared cache / database:

- **Session revocation is per-process.** The `jti` allowlist lives in the
  user store, which is either in-memory or a per-node JSON file. Logging out
  on one pod does not invalidate a copy of the token that reaches another
  pod. Operators running multiple replicas today should either (a) pin
  sessions to a single pod with sticky-session load balancing, or (b) accept
  that logout is best-effort until a shared session store (e.g. Redis with
  `SETEX`) is introduced.
- **Rate limiting is per-process.** The sliding-window limiter counts
  attempts inside each Node process. Ten replicas → ten times the attempts
  before the limit trips. Front the fleet with an authenticating proxy
  (nginx `limit_req`, an API gateway, or a Redis-backed limiter) so limits
  apply across all instances.
- **The JSON file store is not a database.** It is intentionally simple —
  atomic writes serialize through a per-process queue, which is safe for a
  single instance but does **not** provide cross-process concurrency control,
  indexing, or transactional integrity. Do not point two Node processes at
  the same file, and treat it as suitable only for MVP / small-team
  deployments. Point production systems at PostgreSQL (or equivalent) via a
  future adapter before scaling out.

These constraints are explicit technical debt; the module boundaries
(`UserStore` interface, `RateLimiter` class, `csrfProtect` middleware) are
shaped so a Redis- or Postgres-backed implementation can drop in without
touching the routes.

## API Endpoints

| Method | Endpoint             | Auth | Description                              |
|--------|----------------------|------|------------------------------------------|
| GET    | `/health`            | —    | Health check                             |
| POST   | `/api/auth/login`    | —    | Log in, sets an HttpOnly JWT cookie      |
| POST   | `/api/auth/logout`   | —    | Clears the auth cookie                   |
| GET    | `/api/auth/session`  | —    | Returns the current user (or `null`)     |
| GET    | `/api/auth/me`       | ✓    | Returns the current user, 401 if missing |
| GET    | `/api/version`       | —    | API version                              |
| GET    | `/api/items`         | ✓    | List all items                           |
| GET    | `/api/items/:id`     | ✓    | Get a single item                        |
| POST   | `/api/items`         | ✓    | Create an item                           |
| DELETE | `/api/items/:id`     | ✓    | Delete an item                           |
| GET    | `/api/settings/ai`   | ✓    | Read the caller's AI provider settings   |
| PUT    | `/api/settings/ai`   | ✓    | Update AI provider settings (partial)    |
| GET    | `/api/tasks/stream`  | ✓    | SSE stream of task/run events (this user) |

## Testing

```bash
make test
# or
npm run test
```

Test coverage includes:

- JWT sign/verify (tampered payload, wrong secret, expiration, malformed input,
  optional `jti` claim round-trip)
- Password hashing (round-trip, wrong password, random salts, malformed hash,
  refusal of oversized scrypt parameters)
- Cookie parse/serialize (URL encoding, duplicates, header-injection defense)
- CSRF middleware (safe methods pass, `application/json` allowed, form/plain
  content types rejected with 415, missing Content-Type rejected)
- User store (normalization, duplicates, invalid input, session tracking,
  file persistence + malformed-file handling)
- Config loader (production `JWT_SECRET` and `DEFAULT_ADMIN_PASSWORD`
  requirements, TTL cap, `USER_STORE_PATH` absolute-path guard, rate-limit
  env vars)
- Rate limiter (allow → deny transition, window recovery, per-key isolation,
  reset on success, fail-open for empty keys, memory bounding)
- Login/logout integration tests exercising real HTTP requests against the
  Express app, plus server-side session revocation (stolen-cookie invalidation
  after logout), login rate-limiting (429 + `Retry-After`), and the CSRF
  Content-Type check on `POST /api/auth/logout`
- AI settings AES-256-GCM helper (round-trip, per-record IV uniqueness,
  ciphertext / IV / tag tamper detection, wrong-key rejection, wrong-length
  key rejection, key copying so caller-buffer zeroing is safe, unicode +
  empty-plaintext round-trip)
- AI settings store (per-user isolation, redaction of the API key from all
  responses, partial update / explicit-clear semantics, plaintext round-trip
  via the internal `getApiKeyPlaintext` accessor)
- AI settings validation (enum providers, agents, numeric range on
  temperature / maxTokens, oversized key/model rejection, unknown-field
  rejection, aggregate error reporting)
- AI settings encryption-key bootstrap (`resolveAiEncryptor`) — production
  fail-fast on missing/malformed keys, dev fallback + `console.warn`
- AI settings integration tests exercising `/api/settings/ai` end-to-end
  (auth 401, CSRF 415, defaults on GET, full/partial PUT, `null` clearing,
  per-user isolation, plaintext key never leaks over the wire)
- Task event bus + store emission (`tests/tasks.events.test.ts`) — listener
  fan-out, unsubscribe, listener-error isolation, no-op-when-unchanged
  status filtering, and silent-when-bus-omitted defaults
- SSE stream integration (`tests/tasks.sse.test.ts`) — 401 without auth,
  cookie-based session accepted, `text/event-stream` content-type + `no-cache`
  headers, initial `connected` comment, heartbeat cadence, subscriber cleanup
  on client disconnect, per-user event ownership filtering (including no
  `task-deleted` leaks for never-seen tasks), in-order log delivery,
  attempt-level internals not forwarded to the wire, and the per-user
  concurrent-connection cap
- SSE wire contract (`tests/tasks.wireContract.test.ts`) — enforces
  byte-for-byte parity between the server-side canonical wire types
  (`server/src/tasks/wireEvents.ts`) and the client mirror
  (`client/src/hooks/taskEventWire.ts`), and asserts that every required
  event type literal remains present in both files
- `useTaskEvents` hook (`tests/client.useTaskEvents.test.ts`) — happy-path
  dispatch, missing-handler no-op, JSON parse-error isolation (warns and
  moves on rather than killing the subscription), empty-`data` frame
  survival, hook module re-exports the wire type aliases, and exhaustive
  wire-union coverage via a switch that fails to type-check if a new
  event is added without a matching hook alias

## Theme

The UI uses the PRD-mandated red / orange / black palette:

- `--color-red: #ff0000ff` (PRD `#FF0000`)
- `--color-orange: #ffa500ff` (PRD `#FFA500`)
- `--color-black: #000000ff` (PRD `#000000`)

All palette tokens live in **one file** — `client/src/theme.css` — and every
other stylesheet (`index.css`, `App.css`) imports it with
`@import './theme.css';`. Every token is declared as **8-digit hex**
(`#rrggbbaa`) so opaque and translucent colors share one consistent format.
Tokens are applied to buttons, headers, borders, focus rings, form inputs,
the login card accent, the settings page, and the header navigation — no
component uses raw hex.

### Adding or changing a color

1. Add the token to `client/src/theme.css` (never inline a hex literal in a
   component stylesheet or TSX file).
2. Reference it as `var(--your-token)` from `App.css` / `index.css`.
3. `tests/client.theme.test.ts` enforces this contract:
   - The three PRD colors must exist as `--color-red`, `--color-orange`,
     `--color-black`.
   - Every declared token uses `#rrggbbaa` shape (no 3/6-digit hex, no
     `rgba()`).
   - **No other CSS or TSX file may declare a palette hex literal** — the
     test walks `client/src/**` and fails with the offender's path if it
     finds one.
   - `index.css` and `App.css` must both `@import './theme.css';`.
   - Key surfaces (`.header`, `.button`, `.delete-btn`, `.login-card`,
     `.login-submit`, `.nav-btn-active`, `.settings-heading`) must reference
     a palette token, so a refactor cannot silently drop the accent from a
     marquee component.

## API surface

The initial skeleton exposes a small demonstration surface that will be
replaced by the task-CRUD API in a later PRD step.

| Method | Endpoint            | Description                                 |
| ------ | ------------------- | ------------------------------------------- |
| GET    | `/health`           | Liveness probe (JSON with ISO timestamp)    |
| GET    | `/api/version`      | Application name and version                |
| GET    | `/api/items`        | List demo items                             |
| GET    | `/api/items/:id`    | Fetch a single item (400 on invalid id)     |
| POST   | `/api/items`        | Create an item (`name`: non-empty ≤200 chr) |
| DELETE | `/api/items/:id`    | Delete an item                              |
| GET    | `/api/settings/ai`  | Read the caller's AI provider settings      |
| PUT    | `/api/settings/ai`  | Update AI provider settings (partial patch) |

All error responses have the shape `{ "error": string }`. The centralized
error handler in `server/src/app.ts` never leaks stack traces or internal
messages to clients.

## Configuration

Environment variables are documented in `.env.example`. Copy it to a
local `.env` (which is git-ignored) before running the server:

| Variable          | Default                  | Description                                    |
| ----------------- | ------------------------ | ---------------------------------------------- |
| `PORT`            | `3001`                   | Express listen port                            |
| `ALLOWED_ORIGINS` | `http://localhost:5173`  | Comma-separated CORS allowlist (no wildcards)  |
| `NODE_ENV`        | `development`            | Set to `production` for prod deployments       |

Parsing lives in `server/src/config.ts` behind a `loadConfig()` factory
so that tests can inject fake environments without mutating `process.env`.

## Security baseline

The skeleton establishes the security floor that later PRD tasks (auth,
Docker task runners, AI credential storage) build on:

- **[Helmet](https://helmetjs.github.io/)** middleware sets
  `X-Content-Type-Options: nosniff`, `X-Frame-Options`, a conservative
  Content-Security-Policy, and Strict-Transport-Security on every
  response.
- **CORS** uses an explicit allowlist — no wildcards. Requests from
  origins outside `ALLOWED_ORIGINS` are rejected with `403`. Same-origin
  and server-to-server requests (no `Origin` header) pass through.
- **JSON body limit** of `100kb` on all endpoints guards against trivial
  payload-DoS on unauthenticated routes.
- **Error handler** logs the underlying cause server-side but only sends
  a generic message to the client — no stack traces or internal state
  leak across the wire.
- **`.gitignore`** blocks `node_modules/`, npm caches, `dist/`/`build/`,
  and every `.env*` variant so credentials never accidentally enter git.

## Task persistence and scalability — known limitations

The task store (`server/src/tasks/store.ts`) is currently **in-memory
only**. This is deliberate scope for the MVP — the same reasoning as the
auth module (see *Deployment scope and known limitations* above) — but it
does not meet the PRD's horizontal-scalability NFR by itself. Operators
running multiple replicas must either:

- **Pin sessions to a single replica** so a task created on pod A is
  polled on pod A (sticky-session load balancing).
- **Introduce a shared store** (PostgreSQL or Redis) that implements the
  same `TaskStore` shape. The class is already the seam — a replacement
  drops in behind `createTasksRouter(store, …)` without touching route
  code.

Secrets on stored tasks (`SshConfig.password`, `SshConfig.privateKey`,
`EmailConfig.password`) live only in the process heap in the current
implementation. Any persistent replacement **MUST**:

1. Encrypt those fields with AES-256-GCM (or equivalent) before writing.
2. Source the encryption key from a KMS / secrets manager, not the same
   store.
3. Redact them from query logs and audit trails.

The route layer (`sanitizeTask` in `tasks/routes.ts`) already strips
credentials from every API response regardless of the storage backend, so
this constraint applies only to the storage adapter itself.

## AI Settings

The AI Settings page (`client/src/pages/AiSettings.tsx`) lets a signed-in
user configure the AI provider that developmental tasks call, store the
provider's API key, pick a default agent for new developmental tasks, and
tune model parameters (model, temperature, maxTokens).

### API surface

| Method | Endpoint             | Auth | Description                                   |
|--------|----------------------|------|-----------------------------------------------|
| GET    | `/api/settings/ai`   | ✓    | Read the caller's redacted settings view      |
| PUT    | `/api/settings/ai`   | ✓    | Partial update — only supplied fields change  |

Both endpoints require an authenticated user (per-user isolation: the
`userId` is taken from the verified JWT, never from the request body).
`PUT` additionally requires `Content-Type: application/json` — same CSRF
Content-Type guard used everywhere else in the app.

### Update semantics

The `PUT` body is a **partial patch**:

- Omit a field → leave its current value alone.
- Send `null` → clear the value.
- Send a non-null value → replace.

The `apiKey` field is **write-only**: it is never included in any GET or
PUT response. The response instead carries a `hasApiKey: boolean` flag so
the UI can render "Configured" vs. "Not configured" without ever holding
the plaintext key in the browser.

### Redaction

`AiSettingsStore` never returns the plaintext key from the redacted
`AiSettingsView`. The only public accessor for the plaintext is
`getApiKeyPlaintext(userId)`, intended solely for server-side outbound
calls the developmental-task runner makes on behalf of the user. Route
handlers do not call it — only the executor pipeline should.

### Encryption at rest

API keys are sealed with **AES-256-GCM** (authenticated encryption)
before being stored, using a per-record random 12-byte IV. Tampering
with the ciphertext, IV, or auth tag is rejected on decrypt with a
`EncryptionError` — the store never silently returns garbage plaintext.

- **Production** requires `AI_SETTINGS_ENCRYPTION_KEY` — a base64-encoded
  32-byte key sourced from a KMS or secret manager. Missing or malformed
  keys stop the server at startup rather than silently generating an
  ephemeral one.
- **Development** falls back to a per-process random key with a loud
  `console.warn`. Restarts invalidate every stored API key on the
  fallback path — do not use it outside local dev.

Generate a production key with, for example:

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Key rotation is **out of scope for the MVP** — the current store
encrypts and decrypts under one key. A production adapter that persists
records to a database should tag each ciphertext with a key id so
multiple key generations can coexist during a rotation window.

### Validation

`validateUpdateAiSettings` enforces:

- `provider` and `defaultAgent`: enum-only (`opencode`, `claude-code`,
  `omnimancer`) or `null`.
- `apiKey`: non-empty string ≤ 4096 chars, or `null` to clear.
- `model`: non-empty string ≤ 200 chars, or `null`.
- `temperature`: finite number in `[0, 2]`, or `null`.
- `maxTokens`: integer in `[1, 200_000]`, or `null`.
- Unknown top-level fields (e.g. `apikey` typo) are rejected so a client
  mistake surfaces as a 400 rather than silently no-op'ing.

### Storage & scalability

Per the same trade-off as the other stores (auth, tasks), the AI
settings store is currently **in-memory only**. Multi-replica
deployments should either pin sessions to a single replica or introduce
a shared store (PostgreSQL or Redis) that implements the same
`AiSettingsStore` shape and reuses the `Encryptor` primitive for the
encrypted-at-rest column.

## Daily task handlers

Daily tasks live in `server/src/tasks/daily/` and dispatch through
`createDailyExecutor` to one of three concrete handlers depending on the
task's subtype.

### `sshHandler.ts` — SSH command execution

- Uses the `ssh2` client. Password or PEM-encoded private key auth.
- Blocks any host in an SSRF-unsafe range (loopback, RFC 1918, cloud
  metadata) at handler entry, so the check runs even for callers that
  bypass HTTP validation.
- Enforces a wall-clock timeout (`timeoutMs`, default 30 s) and per-stream
  output caps (`maxOutputBytes`, default 1 MiB) so a stalled TCP handshake
  or a runaway `cat /dev/urandom` cannot hold up the executor or exhaust
  process memory.
- Every thrown error goes through `sanitizeError` with the password and
  private key attached to the `sensitive` list, so credentials cannot
  appear in server logs or task-run errors.

### `emailHandler.ts` — IMAP mailbox check

- Speaks a hand-rolled subset of RFC 3501 over `tls.connect` with
  `rejectUnauthorized: true`. IMAPS (port 993) only — STARTTLS-on-plaintext
  is intentionally not supported to keep the state machine small and
  downgrade-safe.
- Uses `EXAMINE` (read-only SELECT) so a daily poll never mutates
  `/Seen` flags or advances a cursor.
- IMAP-quotes every argument (username, password, folder) and refuses
  arguments containing CR/LF, so a mailbox name of `foo"\r\nCAPABILITY`
  cannot inject a second IMAP command.
- Response buffer capped at 64 KiB and wall-clock deadline enforced by a
  top-level `setTimeout`.
- Same `sanitizeError` wrapping as the SSH handler; the IMAP password
  is added to the `sensitive` list on every error path.

### `dashboardHandler.ts` — HTTP dashboard fetch

- Uses the global `fetch` (Node 18+). URL scheme and hostname are
  re-validated on every hop (initial request + each 3xx redirect) via
  the same `validateUrl` used at task-create time.
- **SSRF hardening beyond validation.** `resolveHostnameSafe` in
  `dns.ts` re-resolves the hostname immediately before the request and
  fails if any A/AAAA record targets a private range. This closes the
  DNS-rebinding hole that validation-time checks alone leave open —
  a hostname that resolved to a public IP at create time and now
  resolves to `10.0.0.5` gets rejected before any bytes go on the wire.
- Redirects are followed **manually** (`redirect: 'manual'`) so each
  hop passes through the same validation → DNS-pin gate; `fetch`'s
  built-in redirect follower would silently accept a Location pointing
  at `http://127.0.0.1/`.
- Sends with `credentials: 'omit'` so no cookies from the surrounding
  Node process are forwarded to an arbitrary user-configured URL.
- Response body capped at 1 MiB by default; sensitive response headers
  (`Set-Cookie`, `WWW-Authenticate`, `Authorization`) are dropped from
  the returned summary so they cannot be persisted in a run log.

### Shared helpers

- **`sanitizeError.ts`** — wraps every external call the handlers make.
  Two-pass scrub: (a) literal credential substrings supplied by the
  handler (`sensitive: [password, privateKey]`) are replaced with
  `[REDACTED]`; (b) a regex pass strips common secret shapes (PEM
  blocks, `Authorization:` header lines, URL userinfo, `Bearer …`).
  The resulting `Error.message` is safe to log or persist; the
  original error is kept on `.cause` for server-side observability.
- **`dns.ts`** — `resolveHostnameSafe` re-resolves and re-validates the
  hostname. Rejects with a coded `UnsafeHostError` (`UNSAFE_HOST`,
  `DNS_LOOKUP_FAILED`, `NO_ADDRESSES`) so callers can key on the code
  rather than message text.

### Executor retry loop

Failed daily-task runs are retried up to **three times with exponential
backoff** (500 ms → 1 s → 2 s by default), matching the PRD's
reliability NFR. Each retry creates a fresh `TaskRun` so operators see
each attempt in the runs list rather than a merged history. `launchExecution`
takes a `maxAttempts` / `baseBackoffMs` override for tests. The task
status is only marked `failed` after the final attempt fails — earlier
failures show up as failed runs but leave the task recoverable.

### Real-time updates — event transport + SSE stream

Task/run state transitions travel over a pluggable pub/sub `bus`. The
publisher and subscriber sides are separate interfaces defined in
`server/src/tasks/events.ts`:

```typescript
interface TaskEventPublisher {
  emit(event: TaskRunEvent): void
}
interface TaskEventSubscriber {
  on(listener: (event: TaskRunEvent) => void): () => void
  listenerCount(): number
}
type TaskRunEventTransport = TaskEventPublisher & TaskEventSubscriber
```

- **`InProcessTaskRunEventBus`** (aliased as `TaskRunEventBus` for
  backwards compatibility) is the default implementation — a lightweight
  wrapper around Node's `EventEmitter`. It is fine for a single-process
  deployment and every test in this repo.
- **Distributed adapters** (Redis Pub/Sub, NATS, SQS-fanout) implement
  the same `TaskRunEventTransport` shape and drop in at the composition
  root without touching the store, executor, or SSE handler. See the
  `RedisTaskRunEventBus` sketch in `events.ts` for a concrete example.

Two publishers write to the transport:

- **Executor** publishes attempt-level events for every retry transition
  (`attempt-start`, `attempt-succeeded`, `attempt-failed`,
  `run-abandoned`) — useful for metrics and internal orchestration.
- **Store** publishes user-visible mutations (`task-created`,
  `task-deleted`, `task-status`, `run-created`, `run-status`, `run-log`) —
  these are what the SSE stream forwards to the client.

The SSE endpoint lives at **`GET /api/tasks/stream`**
(`server/src/tasks/sse.ts`). It satisfies the PRD's "task status updates
appear within 5 seconds of change" requirement — in practice clients see
events within a single event loop tick under the in-process transport,
and within one Redis round-trip under a distributed transport.

#### Horizontal scaling (PRD NFR)

The PRD requires that worker nodes can be added horizontally
(Kubernetes / Docker Swarm). The default in-process bus is a
**single-process** transport — a run executed on pod A would not reach
an SSE client whose stream is held by pod B. Multi-replica deployments
MUST:

1. Construct a distributed transport (Redis Pub/Sub is the recommended
   starting point) that satisfies `TaskRunEventTransport`.
2. Inject it into `createRouter(deps, { runBus: distributedBus, … })`
   at process start. The store, executor, and SSE handler all depend on
   the interface — no other change is required.

A minimal Redis adapter is roughly:

```typescript
class RedisTaskRunEventBus implements TaskRunEventTransport {
  private readonly local = new EventEmitter()
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
    private readonly channel = 'routini:task-events',
  ) {
    void this.sub.subscribe(this.channel)
    this.sub.on('message', (_ch, msg) => {
      const event = JSON.parse(msg) as TaskRunEvent
      for (const l of this.local.listeners('event')) (l as (e: TaskRunEvent) => void)(event)
    })
  }
  emit(event: TaskRunEvent) { void this.pub.publish(this.channel, JSON.stringify(event)) }
  on(l: (e: TaskRunEvent) => void) { this.local.on('event', l); return () => this.local.off('event', l) }
  listenerCount() { return this.local.listenerCount('event') }
}
```

Until a distributed transport is wired up, operators running more than
one replica should pin SSE connections to the pod that owns the task
(sticky-session load balancing) — see the auth deployment notes above
for the same trade-off applied to session revocation.

#### Wire format contract

The SSE frame types live in **one** canonical file
(`server/src/tasks/wireEvents.ts`) and are mirrored on the client
(`client/src/hooks/taskEventWire.ts`). A filesystem contract test
(`tests/tasks.wireContract.test.ts`) enforces byte-for-byte parity
between the marked blocks in the two files so the wire cannot drift.
Every frame is a standard SSE event with a `type` field and a JSON
`data` payload:

```
retry: 5000

event: task-status
data: {"type":"task-status","taskId":"…","status":"running"}

event: run-log
data: {"type":"run-log","taskId":"…","runId":"…","log":{"timestamp":"…","message":"…","level":"info"}}
```

The `retry:` field is emitted on connect (default 5000 ms) so the
browser's `EventSource` reconnect cadence is explicit and tunable per
deployment (`sseOptions.retryMs`) — helpful for controlling reconnect
load during a rolling deploy.

**Security and isolation**:

- Auth is enforced by the parent router's `requireAuth` middleware — same
  cookie / bearer as every other `/api/*` route.
- Every event is filtered by ownership: the handler resolves `taskId` to the
  owning user via the store and drops events for other users. `task-deleted`
  events are only forwarded for task ids the caller has already seen on the
  stream, so a snooping client cannot enumerate other users' task ids.
- Concurrent connections per user are capped (default 4) to prevent a single
  account from monopolising sockets. A hit returns `429`.
- A per-connection in-flight byte ceiling (default 1 MiB) sheds slow
  consumers with a `stream-overrun` control comment instead of buffering
  unbounded logs.
- A heartbeat comment (`: keepalive`, every 15 s) keeps NAT / proxy idle
  timers happy.

**Client usage** — see `client/src/hooks/useTaskEvents.ts`:

```typescript
import { useTaskEvents } from './hooks/useTaskEvents'

useTaskEvents({
  onTaskStatus: (e) => updateTaskStatus(e.taskId, e.status),
  onRunLog: (e) => appendLog(e.runId, e.log),
})
```

The hook opens an `EventSource` (which handles reconnect + `Last-Event-Id`
resume automatically), dispatches per-type events, and closes on unmount.
It's a no-op when `EventSource` is unavailable so it is safe to render in
SSR / test contexts. Reconnect uses the server-side `retry:` cadence
(5 s default). Note that `EventSource` does not expose the HTTP status
code on reconnect failures — a persistent 401 (session expired) or 429
(connection cap) surfaces as repeated `onError` invocations, and
callers that need to react (e.g. redirect to `/login`) should treat
that as a signal to re-check auth out-of-band.

**Why SSE over WebSocket?** Traffic is server → client only, so the extra
bidirectional plumbing of WebSocket buys nothing. SSE rides on plain HTTP
and inherits the app's helmet headers, CORS allowlist, and cookie-based
auth without a second transport.

## Developmental task execution (Docker)

Developmental tasks execute inside ephemeral Docker containers via the
[`dockerode`](https://github.com/apocas/dockerode) SDK. The executor lives at
`server/src/tasks/docker.ts` and is factory-built via `createDockerExecutor()`
so tests inject fake clients and production code passes a real daemon
connection. All error surface is expressed through the typed
[`DockerExecutionError`](server/src/tasks/docker.ts) class — callers key on
`err.code` (e.g. `TIMEOUT`, `NON_ZERO_EXIT`, `INVALID_IMAGE`) rather than
parsing message text.

### Factory usage

```typescript
import Docker from 'dockerode'
import {
  createDockerExecutor,
  readDockerLimitsFromEnv,
  resolveDockerConnection,
} from './tasks/index.js'

// Resolve daemon endpoint from the environment (throws if unconfigured — see
// "Docker daemon connection" below).
const client = new Docker(resolveDockerConnection(process.env))

const executor = createDockerExecutor({
  client,
  // Resource limits are env-driven; the factory validates them at construction.
  limits: readDockerLimitsFromEnv(process.env),
})

// Then wire the executor into launchExecution() from tasks/executor.ts.
```

Tests exercise the executor by passing a hand-rolled fake client (see
`tests/tasks.docker.test.ts`), keeping the daemon out of the loop.

### Security defaults

Every container spun up by the executor gets the following configuration
locked in by `DEFAULT_DOCKER_CONFIG`. Overriding any of these values requires
an explicit code change so it shows up in review.

| Field                        | Value                     | Why                                            |
|------------------------------|---------------------------|------------------------------------------------|
| `User`                       | `"1000:1000"`             | Never run as root inside the container.        |
| `HostConfig.CapDrop`         | `["ALL"]`                 | Drop every Linux capability.                   |
| `HostConfig.CapAdd`          | `[]`                      | Add none back.                                 |
| `HostConfig.Privileged`      | `false`                   | Explicitly disable privileged mode.            |
| `HostConfig.ReadonlyRootfs`  | `true`                    | Root filesystem is read-only.                  |
| `HostConfig.NetworkMode`     | `"none"`                  | No network by default (see *Network access*).  |
| `NetworkDisabled`            | `true`                    | Belt-and-braces: no NICs attached either.      |
| `HostConfig.SecurityOpt`     | `["no-new-privileges"]`   | Block setuid escalation.                       |
| `HostConfig.PidsLimit`       | `128`                     | Cap fork-bomb blast radius.                    |
| `HostConfig.Memory`          | `512 MiB`                 | Hard memory limit.                             |
| `HostConfig.MemorySwap`      | `512 MiB` (== Memory)     | No swap beyond `Memory`.                       |
| `HostConfig.NanoCpus`        | `1 000 000 000` (1 vCPU)  | 1 vCPU cap.                                    |
| `HostConfig.AutoRemove`      | `false`                   | We remove explicitly in `finally` — see below. |
| `HostConfig.Tmpfs["/tmp"]`   | `rw,noexec,nosuid,nodev,size=64 MiB` | Writable scratch dir (see below).   |

`AutoRemove` is deliberately **off**: relying on the daemon to auto-remove a
container races the executor's explicit cleanup and hides removal errors from
the logs. The executor calls `container.remove({ force: true, v: true })` in
a `finally` block so removal happens whether the container succeeds, fails,
or is killed by the wall-clock timeout — see *Lifecycle guarantees* below.

The numeric ceilings (memory, CPU, PIDs, timeout, tmpfs size) are exported as
constants in `DEFAULT_DOCKER_LIMITS` and mirrored into `DEFAULT_DOCKER_CONFIG`
so a policy change happens in exactly one place. They can be tuned per
deployment via env vars — see *Resource limits*.

### Writable paths under `ReadonlyRootfs`

`ReadonlyRootfs: true` blocks writes anywhere on the container's root
filesystem. Because most AI agents (and `git`) expect a writable `/tmp`, the
executor mounts a small size-capped tmpfs at `/tmp` (`64 MiB`, `noexec`,
`nosuid`, `nodev`). Data written there vanishes when the container is
removed. Agents that need to write elsewhere should stage into `/tmp` and
have the executor caller supply a bind-mounted volume via the
`DockerRunOptions.workingDir` and — in a later PRD task — a caller-provided
work volume; the executor does not open host bind mounts by default.

### Secrets handling

Credentials (git tokens, SSH keys, AI-provider API keys) MUST be passed via
the executor's `secretFiles` mechanism, **not** as environment variables.
Environment variables are visible to any host user who can run
`docker inspect` on the running container and can leak via daemon crash
dumps. `secretFiles` mounts each secret as a per-container tmpfs entry with
`0400` permissions, stages the content on start, and lets the daemon reap
the memory when the container is removed. Callers are responsible for
supplying already-decrypted content (typically pulled from a KMS or Docker
Swarm secrets store); the executor never touches host disk to persist secret
material.

The executor validates secret mount targets against a path-safety guard
(absolute path, no `.` / `..` segments, no null bytes) before touching the
daemon. Content is shell-escaped when it is written into the container's
init wrapper, so a token containing `; rm -rf /` cannot break out of the
staging step.

### Network access & git operations

Default containers have **no network** (`NetworkMode: "none"`,
`NetworkDisabled: true`). The developmental-task PRD requires
`git clone`/`git push`, which do need network — the executor exposes a
per-run `networkMode` override in `DockerRunOptions` to reconcile the two:

- **Recommended pattern:** the deployment creates a dedicated Docker bridge
  network (e.g. `routini-egress`) with `iptables` / `nftables` rules that
  allowlist exactly the ports the agent needs (`22/tcp` for SSH, `443/tcp`
  for HTTPS) to exactly the destinations it needs (git host, package
  registries). The task passes `networkMode: 'routini-egress'` for that
  developmental task only.
- **Alternative pattern:** run a git-sync sidecar in the routine's outer
  scope that stages the repo into a volume, then attach the agent container
  read-only to that volume with `networkMode: 'none'`. This keeps the agent
  fully isolated from the network at the cost of doubling the container
  count.
- Any non-`"none"` network mode is logged as a `warn` entry in the run so
  it appears in the audit trail. Deployments that want to hard-forbid the
  relaxation can override `resolveRunOptions` to strip `networkMode` before
  it reaches the executor.

Do **not** simply flip `NetworkMode` to `"bridge"` — that gives the
container unrestricted egress, and a compromised agent gets outbound access
to the internet.

### Image-name validation

Image references are checked against a strict allowlist regex before they
reach the Docker daemon. The pattern accepts an optional registry host
(`host[:port]/`), one or more lowercase path segments separated by `/`, and
an optional `:tag` or `@sha256:<64 hex>` suffix. It refuses:

- shell metacharacters (`;`, `|`, `&`, backticks, `$`)
- whitespace, control characters, and newlines
- `..` segments and absolute paths
- uppercase letters in path segments (Docker rejects these too)
- references longer than 255 bytes

If validation fails the executor throws `DockerExecutionError` with
`code === 'INVALID_IMAGE'` immediately — no `docker pull` is ever attempted.

### Resource limits

Numeric ceilings are exported as `DEFAULT_DOCKER_LIMITS` and can be tuned per
deployment. `readDockerLimitsFromEnv(process.env)` reads:

| Variable                    | Effect                                                  |
|-----------------------------|---------------------------------------------------------|
| `DOCKER_MEMORY_LIMIT`       | Bytes; sets both `Memory` and (if unset) `MemorySwap`.  |
| `DOCKER_MEMORY_SWAP_LIMIT`  | Bytes; overrides swap independently. Must be ≥ memory.  |
| `DOCKER_CPU_NANOS`          | Nano-CPUs; `1_000_000_000` = 1 vCPU.                    |
| `DOCKER_PIDS_LIMIT`         | Max PIDs inside container.                              |
| `DOCKER_TIMEOUT_MS`         | Wall-clock deadline (ms). Default 15 minutes.           |
| `DOCKER_TMPFS_SIZE_BYTES`   | Size cap for the `/tmp` tmpfs mount.                    |

Anything that isn't a positive integer (or that leaves swap below memory)
throws `DockerExecutionError` with `code === 'INVALID_LIMITS'` — a
misconfigured env var stops startup rather than silently falling back to the
default. Callers can lower the timeout per run via
`DockerRunOptions.timeoutMs` but not raise it above whatever the production
deployment configures — deployments SHOULD front the executor with a
queue-level ceiling.

### Retry policy

Only *daemon connection* operations retry:

| Operation           | Retryable? | Backoff                             |
|---------------------|-----------|--------------------------------------|
| `createContainer`   | Yes       | Exponential: 200 → 400 → 800 ms      |
| `container.start`   | Yes       | Same as above                        |
| `container.wait`    | No        | Wait completes once, timeout applies |
| Non-zero exit code  | No        | Fails the run immediately            |

`createMaxAttempts` (default `3`) and `createRetryBaseMs` (default `200`) are
configurable on the factory. Workload errors — anything the user script did,
including a non-zero exit code — are never retried; re-running a failing
script wastes cycles and can be destructive.

### Lifecycle guarantees

- `container.remove({ force: true, v: true })` runs in a `finally` block.
  Whether the container succeeds, exits non-zero, hits the wall-clock
  deadline, or fails to start, the cleanup path executes.
- **Timeout behavior:** the executor `Promise.race`s `container.wait()`
  against a `setTimeout(timeoutMs)`. If the timer wins we mark the run as
  timed out and fall through to the `finally` block. `remove({ force: true })`
  sends SIGKILL to the still-running container and reaps it, so the timeout
  path never leaks a running container. If cleanup itself fails the executor
  logs the removal error and re-throws the original workload error (rather
  than the cleanup error) so operators diagnose the actual root cause.
- Errors are wrapped by `DockerExecutionError`, which carries a typed `code`
  (`CREATE_FAILED`, `START_FAILED`, `TIMEOUT`, `NON_ZERO_EXIT`,
  `INVALID_IMAGE`, `INSECURE_CONNECTION`, etc.) plus a `cause` for
  observability. The wire response to clients stays generic — `Task
  execution failed. Check server logs for details.` — to avoid leaking
  daemon internals through the API.

### Docker daemon connection

`resolveDockerConnection(env)` is **fail-secure**: if no explicit connection
is configured, it throws `DockerExecutionError` with
`code === 'INSECURE_CONNECTION'` rather than silently falling back to the
host Docker socket. Environment drift or a missing CI variable therefore
stops the server at startup instead of exposing the daemon to any process
that compromises the Node app.

Order of precedence:

1. `DOCKER_HOST` — accepts `tcp://host:port`, `unix:///path/to/sock`, or
   `ssh://user@host`. `DOCKER_TLS_VERIFY=1` upgrades a `tcp://` URL to
   `https://`; `DOCKER_CERT_PATH=/path/to/certs` surfaces the standard
   `ca.pem` / `cert.pem` / `key.pem` triplet so `dockerode` can authenticate.
2. `DOCKER_SOCKET_PATH` — an explicit Unix socket path (useful when the
   daemon is exposed on a non-standard socket).
3. `DOCKER_ALLOW_DEFAULT_SOCKET=1` — **explicit opt-in** to fall back to
   `/var/run/docker.sock`. Intended for local development on a dev
   workstation; production deployments MUST NOT set this.
4. Otherwise: `resolveDockerConnection` throws.

The Docker socket is effectively root-equivalent on the host — compromising
the Node process gains an attacker full daemon control. Point at a remote
daemon with TLS (`DOCKER_HOST=tcp://…:2376`, `DOCKER_TLS_VERIFY=1`, and
`DOCKER_CERT_PATH=…`), or run the executor behind a Kubernetes / Nomad
orchestrator that exposes a scoped, authenticated API instead.

### Environment variables (summary)

| Variable                       | Required? | Description                                              |
|--------------------------------|-----------|----------------------------------------------------------|
| `DOCKER_HOST`                  | Preferred | Full daemon URL (`tcp://…`, `unix://…`, `ssh://…`).       |
| `DOCKER_TLS_VERIFY`            | Optional  | Set to `1` when using TLS with `DOCKER_HOST=tcp://…`.     |
| `DOCKER_CERT_PATH`             | Optional  | Directory holding `ca.pem` / `cert.pem` / `key.pem`.      |
| `DOCKER_SOCKET_PATH`           | Alternate | Explicit Unix socket path if not using `DOCKER_HOST`.     |
| `DOCKER_ALLOW_DEFAULT_SOCKET`  | Dev only  | Set to `1` to opt in to `/var/run/docker.sock`.           |
| `DOCKER_MEMORY_LIMIT`          | Optional  | Container memory ceiling (bytes).                         |
| `DOCKER_MEMORY_SWAP_LIMIT`     | Optional  | Container memory+swap ceiling (bytes).                    |
| `DOCKER_CPU_NANOS`             | Optional  | CPU ceiling in nano-CPUs.                                 |
| `DOCKER_PIDS_LIMIT`            | Optional  | Container PID ceiling.                                    |
| `DOCKER_TIMEOUT_MS`            | Optional  | Wall-clock deadline for a run (ms).                       |
| `DOCKER_TMPFS_SIZE_BYTES`      | Optional  | `/tmp` tmpfs size cap (bytes).                            |

### Test coverage

`tests/tasks.docker.test.ts` exercises the executor without touching a real
daemon (a fake `DockerClient` is injected via the factory). Coverage
includes: image-name allowlist (positive + rejection matrix), security
defaults propagation, resource-limit injection, tmpfs mount presence,
network-mode override with audit logging, secret-mount tmpfs staging + path
traversal rejection + shell-escape, retry with exponential backoff, workload
errors NOT retried, wall-clock timeout with guaranteed cleanup, cleanup
failure never masking the primary error, fail-secure daemon connection
resolution, and the `DockerExecutionError` code taxonomy.

### Dependency pinning

`dockerode` is pinned with the **tilde** range (`~5.0.1`) in
`server/package.json` so patch fixes (5.0.2, 5.0.3, …) flow in automatically
but minor upgrades — where Docker SDK behavior can change — require an
explicit bump. Type definitions are added as a dev dependency
(`@types/dockerode`). Run `npm audit` after each dockerode bump to catch
supply-chain regressions in its transitive dependencies (which pull in gRPC
for streaming Docker events).

## Architecture notes

- `createApp(options?)` in `server/src/app.ts` returns a fully wired
  Express app. It accepts `{ config, authDeps }` — when `authDeps` is
  supplied (the production wiring in `index.ts`), the auth router and
  the item router are mounted; when omitted (the skeleton smoke tests),
  only the public `/api/version` endpoint is mounted. `index.ts` only
  handles process concerns (config load, auth bootstrap, `listen`).
  This split keeps the app trivially testable via supertest and lets
  tests override the CORS allowlist per-case.
- Environment parsing lives in `server/src/config.ts` behind a single
  `loadConfig()` factory so `process.env` reads have one seam.
- Input validation for the item routes is centralized in `routes.ts`
  (id parsing, name length/whitespace guards) rather than duplicated
  per handler.

## License

MIT
