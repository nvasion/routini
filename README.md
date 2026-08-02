# routini

**Autonomous Engineer Platform** – Define, schedule, and run daily tasks, AI-powered developmental coding jobs, and multi-step routine workflows from a single interface.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js + TypeScript (ES modules) |
| Frontend | React 18 + Vite + React Router v7 |
| Testing | Vitest + supertest |
| Theme | Red (`#ff0000`) / Orange (`#ffa500`) / Black (`#000000`) |

## Project Structure

```
routini/
├── server/                      # Express.js backend
│   ├── src/
│   │   ├── index.ts             # Entry point – starts the server
│   │   ├── app.ts               # Express app factory (no listen; importable for tests)
│   │   ├── routes.ts            # Top-level router (mounts sub-routers)
│   │   ├── types.ts             # Shared domain types
│   │   ├── db/
│   │   │   └── index.ts         # SQLite persistence module (ROUTINI_DB_PATH)
│   │   ├── services/
│   │   │   ├── credentials.ts   # Encrypted credential store (CREDENTIALS_MASTER_KEY)
│   │   │   └── integrations.ts  # Integrations catalog + status derivation
│   │   └── routes/
│   │       ├── auth.ts          # POST /login, /logout  GET /me
│   │       ├── tasks.ts         # CRUD + trigger for tasks
│   │       ├── settings.ts      # GET/PUT AI settings
│   │       ├── credentials.ts   # CRUD for stored credentials
│   │       └── integrations.ts  # Integrations catalog + connect/test/disconnect (see "Integrations" below)
│   ├── vitest.config.ts         # Test runner config
│   └── package.json
├── client/                      # React frontend
│   ├── src/
│   │   ├── main.tsx             # React entry point
│   │   ├── App.tsx              # Router shell — see "Navigation & Pages" below
│   │   ├── types.ts             # Client-side domain types
│   │   ├── components/
│   │   │   ├── Navbar.tsx / .css / .test.tsx  # Top nav: Dashboard / Metrics / Integrations / Settings tabs
│   │   │   ├── TaskCard.tsx / .css / .test.tsx  # Clickable task card (see "Interacting with the config modal")
│   │   │   ├── ConfigModal.tsx / .css / .test.tsx  # Centered, editable task config modal (see below)
│   │   │   ├── configModal.utils.ts / (tested via tests/configModal.utils.test.ts)  # Pure form validation/payload helpers backing ConfigModal
│   │   │   ├── IntegrationModal.tsx / .css / .test.tsx  # Connect/scope/test/disconnect modal, reuses ConfigModal's chrome (see "Integrations" below)
│   │   │   └── RoutineBuilder.tsx     # Step editor for routine tasks (embedded in ConfigModal)
│   │   └── pages/
│   │       ├── Dashboard.tsx / .css / .test.tsx  # Three-bucket task dashboard (see "Dashboard Layout" below)
│   │       ├── MetricsPage.tsx / .css / .test.tsx  # Read-only task health metrics (see "Metrics Page" below)
│   │       ├── Integrations.tsx / .css / .test.tsx  # Integrations catalog grid (see "Integrations" below)
│   │       ├── Login.tsx / .css       # Login page
│   │       └── Settings.tsx / .css   # AI settings page
│   ├── vitest.config.ts         # Component-test runner config (jsdom + React), see "Running Tests"
│   └── package.json
├── tests/                       # Integration tests (supertest)
│   ├── api.test.ts              # Health + 404 tests
│   ├── auth.test.ts             # Auth endpoint tests
│   ├── tasks.test.ts            # Task CRUD + trigger tests
│   ├── settings.test.ts         # Settings endpoint tests
│   ├── integrations.test.ts     # Integrations CRUD/test/disconnect HTTP tests (see "Integrations" below)
│   └── integrations-connection.test.ts  # Unit tests for the per-provider live-check dispatch
├── Makefile
└── package.json
```

> Note: the original read-only side-drawer config panel (`TaskConfigPanel.tsx`) has been replaced
> by the editable, centered `ConfigModal.tsx` (see "Interacting with the config modal" below).

## Getting Started

### Prerequisites

- Node.js 20 or higher (see `.nvmrc`)
- npm

### Installation

```bash
make install
```

### Development

```bash
make dev          # Start both server and client with hot reload
make dev-server   # Backend only  (http://localhost:3001)
make dev-client   # Frontend only (http://localhost:5173)
```

Vite proxies `/api` and `/health` to the backend automatically.

### Production Build

```bash
make build   # Compiles server (tsc) and bundles client (vite build)
make start   # Runs compiled server
```

## Running Tests

```bash
make test
```

`make test` runs the server-side/integration suite: 900+ tests covering auth, tasks (CRUD,
type-specific `PUT` validation, and trigger), settings, notifications, credentials, integrations
(catalog, connect/test/disconnect, and the per-provider live-check dispatch), and general API
behaviour. These live under `tests/**`, `server/tests/**`, and `server/src/**/*.test.ts` and run
with the workspace-root Vitest config (`server/vitest.config.ts`) in a plain Node environment.
Task validation in particular is covered across three files that stay independently readable:

- `tests/tasks.test.ts` — CRUD + trigger happy paths and generic 404/401 handling.
- `server/src/routes/tasks.put-validation.test.ts` — type-specific `PUT` field validation
  (daily's `schedule`/`actionType`/`config`, developmental's `repoUrl`/`branch`/`agentId`).
- `server/src/tests/tasks.test.ts` — edge cases: type coercion quirks, immutability of
  server-managed fields (`id`/`status`/`createdAt`/`type`), malformed JSON bodies, and
  injection/prototype-pollution-style inputs.

Where possible, client-side logic is tested the same way, by exporting the pure logic a component
needs (e.g. `client/src/hooks/openPanelStore.ts`, `client/src/components/configModal.utils.ts`)
into a module with no React/JSX so it's testable without a DOM.

Components whose behavior can't reasonably be reduced to pure functions — e.g. `TaskCard`'s
click/keyboard interactions, `ConfigModal`'s editable save flow, `Dashboard`'s per-bucket create
forms and drill-in navigation, and `MetricsPage`'s summary/table rendering — are covered separately
with component tests (`client/src/**/*.test.tsx`) using Vitest + `@testing-library/react` in a
jsdom environment, configured by `client/vitest.config.ts`:

```bash
cd client && npx vitest run --config vitest.config.ts
```

This requires `vitest`, `jsdom`, and `@testing-library/react` as `client` devDependencies (in
addition to `@vitejs/plugin-react`, already present) — install them with `npm install` in `client/`
if they're missing. Note that `@testing-library/jest-dom` is **not** installed, so client tests use
plain DOM assertions (`.textContent`, `.getAttribute(...)`, `.toHaveProperty(...)`) rather than
jest-dom matchers like `toHaveTextContent`.

## Navigation & Pages

Every authenticated page is wrapped in `Navbar` (`client/src/components/Navbar.tsx`), which exposes
four tabs and highlights whichever one matches the current route:

| Tab | Route | Page |
|-----|-------|------|
| Dashboard | `/` (and `/?bucket=<type>` — see "Bucket drill-in" below) | `pages/Dashboard.tsx` |
| Metrics | `/metrics` | `pages/MetricsPage.tsx` |
| Integrations | `/integrations` | `pages/Integrations.tsx` (see "Integrations" below) |
| Settings | `/settings` | `pages/Settings.tsx` |

All four are protected routes (see `App.tsx`'s `Protected` wrapper) — an unauthenticated visitor is
redirected to `/login`, and any unmatched path redirects back to `/`.

The Integrations tab (`pages/Integrations.tsx`) renders the full catalog grid fed by
`GET /api/integrations`; clicking a card opens `IntegrationModal`, which handles connect, live test,
scoping, and disconnect — see "Integrations" below for the full feature writeup.

## Dashboard Layout

The task dashboard (`client/src/pages/Dashboard.tsx` / `Dashboard.css`) organizes tasks into three
buckets, one per `TaskType` (`daily`, `developmental`, `routine` — see `client/src/types.ts`). Each
bucket renders its own column of `TaskCard` components (`client/src/components/TaskCard.tsx`) for
tasks whose `type` matches that bucket.

### Three-bucket structure

- **Daily Tasks** — scheduled tasks driven by a cron `schedule` and `actionType` (`http` / `ssh` / `email`).
- **Developmental Tasks** — AI-agent coding jobs tied to a `repoUrl`, `branch`, and `agentId`.
- **Routine Automation** — multi-step workflows composed of other tasks, edited via `RoutineBuilder.tsx`.

Tasks are assigned to a bucket purely by their `type` field — there is no manual sorting or
drag-and-drop between buckets. Each bucket header shows a live count of the tasks it contains,
and an empty bucket shows a short hint instead of an empty column.

### Per-bucket task creation

Rather than a single global "+ New Routine" action, each bucket owns its own type-specific "New"
button (`+ New Daily Task` / `+ New Developmental Task` / `+ New Routine`) which expands an inline
create form scoped to that bucket. Only one bucket's create form can be open at a time — opening a
different bucket's form closes whichever was previously open. Submitting posts a type-specific body
to `POST /api/tasks` (see "Task body by type" below) and the newly created task is appended to its
bucket immediately, without waiting for the SSE `task:updated` broadcast to arrive.

### Bucket drill-in

Clicking a bucket's title (e.g. "Daily Tasks") focuses that bucket full-width, with a "← Back"
control to return to the three-bucket grid. This focused view is reflected in the URL as a
`?bucket=daily|developmental|routine` query parameter on the dashboard route rather than a separate
page, so it's bookmarkable, survives a page refresh, and responds to the browser's back/forward
buttons. The search input (see below) still applies while drilled into a single bucket.

### Interacting with the config modal

The entire `TaskCard` is clickable — clicking anywhere on the card except its action buttons
(⚙ / ▶ / ✕) opens that task's `ConfigModal` (`client/src/components/ConfigModal.tsx`): a centered,
dimmed-backdrop dialog (never an inline side panel, so opening it never resizes the card or reflows
sibling cards). Unlike the read-only panel it replaced, every field is editable and persisted via an
explicit **Save** button that calls `PUT /api/tasks/:id`:

- **Daily** — `name`, `description`, `schedule` (cron expression), `actionType`, and config
  key/value rows. Existing config values are never echoed back to the browser (they may hold
  credentials), so blank rows mean "leave stored config unchanged," not "clear it."
- **Developmental** — `name`, `description`, `repoUrl`, `branch`, and `agentId`.
- **Routine** — a small `name`/`description` form saved independently, plus the existing
  `RoutineBuilder` step editor (`PUT /api/tasks/:id/steps`), with its available-task palette
  populated from every non-routine task on the dashboard (routines cannot nest).

Saves do not auto-close the modal, so the user can keep editing/saving without losing their place;
a "Saved" status message confirms success, and a server-provided error is shown inline on failure.
The modal closes via its ✕ button, a backdrop click, or the `Escape` key.

The card exposes `role="button"` and `tabIndex={0}` so it's reachable by keyboard, and responds to
both `Enter` and `Space` the same way it responds to a click. The ⚙ button remains as an explicit,
smaller affordance for the same action — it stops event propagation (as do ▶ and ✕) so clicking or
keyboard-activating an action button never also toggles the card's own modal.

Only one config modal is open across the whole dashboard at a time — opening a second one closes
whichever was previously open (see `useOpenPanel` / `openPanelStore.ts`). Changes propagate back to
the task list either optimistically (via the modal's own save) or via the SSE `task:updated` event
(see `useTaskEvents`).

### Connecting an integration

`IntegrationModal` (`client/src/components/IntegrationModal.tsx`) reuses the same `cm-overlay`/
`cm-panel` chrome as `ConfigModal` — same dimmed backdrop, centered card, ✕/backdrop/`Escape` close
affordances, and `cm-*` form styling, plus `ConfigModal`'s exported `FormRow`/`FormStatus` pieces —
rather than duplicating that layout. It renders one input per credential field defined on the
`Integration` catalog entry (`client/src/types.ts`), a link to the provider's setup page (opens in a
new tab), and a **Connect** (or **Save**, once already connected) button that persists via
`PUT /api/integrations/:id`. This component is invoked by the `/integrations` catalog grid page
(`pages/Integrations.tsx`) with the `Integration` the user clicked; it does not fetch the catalog
itself.

Credential fields are **write-only**: `GET /api/integrations` never returns a stored secret, so
every field always starts blank, even when editing an already-connected integration. Saving only
sends fields the user actually typed into — a field left blank keeps its stored value unchanged
rather than being cleared, and the write-only fields are cleared from React state immediately after
a successful save so plaintext credentials aren't held in memory longer than necessary.
Client-side validation requires every field to be filled in for a first-time connection.

Two other integration-connect components exist in the tree
(`components/IntegrationConnectModal.tsx` and `components/IntegrationConnectionPanel.tsx`, with their
own `.utils.ts` helpers) but are not currently mounted by any page — `IntegrationModal.tsx` above is
the one actually reachable from `/integrations`.

### Search behavior across buckets

The search input in `dashboard-controls` filters by task `name`, `id`, and `description`
(case-insensitive) and applies **simultaneously across all three buckets** — typing a query narrows
every bucket's contents at once, whether viewing the full grid or drilled into a single bucket. A
task must match the search term to remain visible in its bucket; buckets with no matching tasks show
the standard empty-state hint.

### Responsive design considerations

The bucket grid uses CSS Grid (`.dashboard-buckets` in `Dashboard.css`): three columns side-by-side
on desktop viewports, collapsing to fewer columns on tablet widths and to a single stacked column on
mobile so each bucket remains fully readable without horizontal scrolling. The drilled-in focused
view (`.dashboard-buckets--focused`) instead renders a single full-width bucket. Within a bucket,
`TaskCard`s reflow using the same `auto-fill`/`minmax` grid pattern already used by `.task-grid`, so
card width adapts smoothly between breakpoints.

## Metrics Page

`client/src/pages/MetricsPage.tsx` (`/metrics`) is a read-only view of task health at a glance. It
reuses the same data-loading pattern as the Dashboard — an initial `GET /api/tasks` snapshot kept
live via the `/api/tasks/events` SSE stream (`useTaskEvents`) — and introduces no new backend
endpoints.

- **Summary cards** — total task count, plus counts of `succeeded`, `running`, and `failed` tasks.
- **Failed Tasks table** — every task currently in `failed` status, sorted most-recently-updated
  first, with a link to `GET /api/tasks/:id/logs` (opened in a new tab) for quick triage.
- An empty-state message ("No failed tasks") replaces the table when there are no failures, and an
  error banner surfaces a failed initial fetch without crashing the page.

## Integrations

`client/src/pages/Integrations.tsx` (`/integrations`) is a catalog grid of the external tools tasks
and coding agents can connect to. v1 ships eight token/API-key integrations, each with its own
credential field(s) and a link to the provider's token-generation page:

| Integration | Credential fields | Setup page |
|-------------|--------------------|------------|
| GitHub | Personal Access Token | github.com fine-grained PAT settings |
| Slack | Bot Token | api.slack.com apps |
| Jira | Site URL, Account Email, API Token | Atlassian API token management |
| Notion | Internal Integration Token | notion.so/my-integrations |
| Linear | API Key | linear.app API settings |
| monday.com | API Token | monday.com developer apps |
| HubSpot | Private App Token | HubSpot private-app docs |
| Factory Nexus | API Key | app.factorynexus.com API key settings |

Unlike openworker (the source of this catalog), Routini is a self-hosted, multi-user web service:
there is no third-party OAuth broker for v1 — connecting is credentials-first, secrets are stored
server-side in the existing encrypted credential store, and access is scoped per-integration rather
than gated by interactive per-action approval prompts.

### Catalog grid and status badges

Each card shows a status badge — **Not connected**, **Connected**, or **Error** (a connected
integration whose most recent test failed) — sourced entirely from `GET /api/integrations`, which
never returns credential values. Clicking a card (or activating it with `Enter`/`Space`, mirroring
`TaskCard`'s keyboard support) opens `IntegrationModal`.

### Connect modal

`client/src/components/IntegrationModal.tsx` reuses `ConfigModal`'s centered overlay/panel chrome
(the `cm-*` classes and its exported `FormRow`/`FormStatus` pieces) rather than duplicating that
layout, per the catalog's shared card/modal design:

- A link to the provider's setup page for generating the credential.
- One input per credential field (rendered as `type="password"` for secret fields). Like the daily
  task config editor, fields are **write-only**: the server never echoes a stored value back, so
  once connected, leaving a field blank on a later save means "keep the currently stored value,"
  not "clear it." All fields are required on the first connect.
- Once connected, a **scoping panel** (checkboxes for allowed task types — `daily` / `developmental`
  / `routine` — and allowed agents — `claude` / `opencode` / `omnimancer`; defaults to all), a
  **Test connection** button, and **Disconnect**.

### Test connection

Test connection calls `POST /api/integrations/:id/test`, which delegates to the single
per-provider implementation in `server/src/services/integrationProviders.ts` and performs a
server-side live check against the provider using the already-stored credentials (GitHub `GET /user`,
Slack `auth.test`, Jira `GET /rest/api/3/myself`, Notion `GET /v1/users/me`, Linear's `viewer`
GraphQL query, monday.com's `me` GraphQL query, HubSpot account-info, Factory Nexus `GET /v1/me`).
The result (`lastTestOk` + `lastTestAt`) is persisted and flips the card's badge to **Error** on
failure — it never accepts credentials in the request body, only reads what is already stored.

### Security

- Secrets are encrypted at rest via the existing credential store (AES-256-GCM) under keys of the
  form `integration_<id>_<field>` (system scope, matching the store's `(userId, key)` model used
  elsewhere — see "Credential Store" below) and are **never** returned by `GET`, `PUT`, or `POST
  .../test` responses.
- `PUT`/`POST .../test`/`DELETE` all require authentication and CSRF (`requireAuth` + `requireCsrf`,
  the same pattern used by `tasks.ts` and `credentials.ts`).
- Jira's site URL is user-supplied, so the live-check runs it through the same SSRF guard used by
  the HTTP daily-task service (`https:`-only, no embedded credentials, private/loopback hostnames
  and their resolved IPs rejected) before making the request. The other seven providers use fixed,
  hardcoded API hostnames, not user input.
- Scoping (`taskTypes` / `agents`) is validated against a fixed enum and persisted server-side by
  this API — it is not merely a client-side hidden field. It is also enforced at task/container-spawn
  time: `server/src/services/integrations.ts`'s `getScopedIntegrationEnv`, called from
  `devTask.ts` on every developmental-task container spawn, only injects a connected integration's
  credential as an env var when the running task's type and agent fall within that integration's
  current scope — out-of-scope or disconnected integrations are silently omitted, never injected
  with a placeholder value.
- Non-secret status/scoping metadata (`connectedAt`, `lastTestAt`, `lastTestOk`, `scopes`) persists
  to sqlite via the `integration_metadata` table (see "Database Persistence" below) so it survives a
  restart; disconnecting removes both the stored credentials and this metadata row.

## API Reference

### General

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check `{ status, timestamp }` |
| `GET` | `/api/version` | Version info `{ version, name }` |

### Auth – `/api/auth`

| Method | Endpoint | Body / Notes |
|--------|----------|--------------|
| `POST` | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| `POST` | `/api/auth/logout` | `Authorization: Bearer <token>` |
| `GET` | `/api/auth/me` | `Authorization: Bearer <token>` → `User` |

### Tasks – `/api/tasks`

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/api/tasks` | Query: `?type=daily\|developmental\|routine`, `?status=idle\|queued\|running\|succeeded\|failed` |
| `GET` | `/api/tasks/:id` | Single task |
| `POST` | `/api/tasks` | Create task (type-specific body) |
| `PUT` | `/api/tasks/:id` | Partial update — see below |
| `DELETE` | `/api/tasks/:id` | Remove task |
| `POST` | `/api/tasks/:id/trigger` | Queue a task for execution |

#### `PUT /api/tasks/:id` — updatable fields

All fields are optional; only keys present in the request body are validated and applied — omitted
fields keep their existing stored value. Fields outside the task's own type are silently ignored
(e.g. sending `repoUrl` for a `daily` task has no effect). Server-managed fields (`id`, `type`,
`status`, `createdAt`) can never be changed via this endpoint.

| Field(s) | Applies to | Validation |
|----------|-----------|------------|
| `name` | all types | Ignored unless a non-empty string (blank/omitted keeps the existing name) |
| `description` | all types | Coerced to a string when present |
| `schedule` | `daily` | Non-empty string |
| `actionType` | `daily` | One of `ssh` / `email` / `http` |
| `config` | `daily` | Object of string key/value pairs (rejects arrays and non-string values) |
| `repoUrl` | `developmental` | Non-empty `https://` URL on an allow-listed git host, no embedded credentials (SSRF guard — see `validateRepoUrl`) |
| `branch` | `developmental` | Non-empty string |
| `agentId` | `developmental` | One of the supported agent IDs (see `AGENT_OPTIONS` / `VALID_AGENTS`) |

Routine `steps` are managed separately via `PUT /api/tasks/:id/steps` (see `RoutineBuilder.tsx`),
not through this endpoint.

#### Task body by type

**daily**
```json
{ "name": "...", "type": "daily", "schedule": "0 9 * * *", "actionType": "http|ssh|email", "config": {} }
```

**developmental**
```json
{ "name": "...", "type": "developmental", "repoUrl": "https://...", "branch": "main", "agentId": "claude" }
```

**routine**
```json
{ "name": "...", "type": "routine" }
```

### Settings – `/api/settings`

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/api/settings` | Returns `{ provider, model, defaultAgentId }` |
| `PUT` | `/api/settings` | Partial update of any field |

### Integrations – `/api/integrations`

All endpoints require authentication; `PUT`, `POST .../test`, and `DELETE` additionally require a
valid CSRF token (`requireCsrf`) when authenticating via cookie. No response from this router ever
includes a credential value — see "Integrations" above for the full connect/test/disconnect flow.

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/api/integrations` | Catalog (all 8 v1 integrations) + per-integration `{ status, connectedAt, lastTestAt, lastTestOk, scopes }` |
| `PUT` | `/api/integrations/:id` | Body: `{ credentials?: Record<field, string>, scopes?: { taskTypes?, agents? } }`. All credential fields are required on first connect; once connected, omitted fields keep their stored value and a scopes-only update is allowed. |
| `POST` | `/api/integrations/:id/test` | Runs the provider's live health check using stored credentials; 400 if not yet connected. Persists `lastTestAt`/`lastTestOk`. |
| `DELETE` | `/api/integrations/:id` | Disconnects: removes stored credentials and resets metadata to `not_connected` with default scopes. |

`:id` is one of `github` / `slack` / `jira` / `notion` / `linear` / `monday` / `hubspot` /
`factoryNexus`; an unknown id 404s on every route.

## Environment Variables

| Variable | Required in prod | Description |
|----------|:---:|-------------|
| `CREDENTIALS_MASTER_KEY` | ✅ | Master key for encrypting stored credentials (AES-256-GCM) |
| `ROUTINI_DB_PATH` | recommended | Filesystem path to the SQLite database file |
| `JWT_SECRET` | ✅ | Signs authentication JWTs (HS256, 24 h expiry) |
| `COOKIE_SECRET` | ✅ | Signs HTTP-only auth cookies (tamper detection) |
| `SEED_EMAIL` | recommended | Email for the seed developer account |
| `SEED_PASSWORD` | recommended | Password for the seed developer account |
| `CLIENT_URL` | recommended | Public origin of the frontend (CORS allow-list) |
| `PORT` | no | Backend listen port (default `3001`) |
| `NODE_ENV` | recommended | Runtime mode: `production`, `test`, or `development` |
| `SMTP_HOST` | optional | SMTP server hostname for email notifications (unset = no-op) |
| `SMTP_PORT` | no | SMTP port (default `587`) |
| `SMTP_SECURE` | no | `true` for implicit TLS (port 465); else STARTTLS (default `false`) |
| `SMTP_USER` | optional | SMTP auth username (SendGrid: literal `apikey`) |
| `SMTP_PASS` | optional | SMTP auth password / SendGrid API key |
| `SMTP_FROM` | no | Envelope `From` address (default `noreply@routini.dev`) |
| `SSH_PRIVATE_KEY` | optional | PEM private key for SSH daily tasks (preferred auth) |
| `SSH_KEY_PASSPHRASE` | optional | Passphrase for an encrypted `SSH_PRIVATE_KEY` |
| `SSH_PASSWORD` | optional | SSH password auth (used only when no private key is set) |
| `SSH_CONNECT_TIMEOUT_MS` | no | SSH connect/read timeout in ms (default `10000`) |
| `IMAP_PASS` | optional | Password for IMAP email-check daily tasks |

### Credential Store — `CREDENTIALS_MASTER_KEY`

Master key used to encrypt and decrypt stored credentials (SSH keys, IMAP/SMTP passwords, API tokens, etc.) with **AES-256-GCM** before they are persisted to the database. This includes the Integrations tab's credentials (see "Integrations" above), which are stored under system-scoped keys of the form `integration_<id>_<field>` (e.g. `integration_github_token`).

- **Development**: if unset, an ephemeral key is generated at process startup for local development only. Data encrypted with an ephemeral key cannot be decrypted after a restart — set an explicit key if you need encrypted data to persist across restarts locally.
- **Test**: set a fixed, non-secret dummy key (e.g. via a `.env.test` file or inline in the test command) so encryption/decryption is deterministic across test runs. Never reuse a production key value in tests.
- **Production**: `CREDENTIALS_MASTER_KEY` **must** be set explicitly. The server should fail to start in production if it is missing rather than silently falling back to a generated key.

#### Security requirements for `CREDENTIALS_MASTER_KEY` in production

- **Required, fail-closed**: never allow the app to boot in production without this variable set — do not fall back to a default or ephemeral key.
- **High entropy**: generate with a cryptographically secure random generator, at least 32 bytes (256 bits) — e.g. `openssl rand -hex 32`.
- **Secret storage only**: inject via a secrets manager or orchestrator secret (AWS Secrets Manager, Vault, Docker/Kubernetes secrets, etc.). Never commit it to source control, `.env` files checked into git, build images, or logs/error messages.
- **Per-environment keys**: use distinct keys for dev, staging, and production — never share a key across environments.
- **Rotation**: rotating the key requires re-encrypting all existing stored credentials, since data encrypted under the old key is not decryptable with a new one; plan a migration step for rotation rather than swapping the variable in place.

### Database Persistence — `ROUTINI_DB_PATH`

Filesystem path to the SQLite database file used for persistent storage (users, tasks, stored credentials, integration status/scoping metadata, etc.).

- **Development**: if unset, defaults to a local file under the server's working directory (e.g. `./data/routini.db`). The directory is created automatically if it does not exist.
- **Test**: set `ROUTINI_DB_PATH` to `:memory:` or a temporary file path so test runs are isolated from the development database and from each other.
- **Production**: point `ROUTINI_DB_PATH` at a path on a persistent volume/mount (e.g. `/data/routini.db` inside a container) so data survives restarts and redeploys. Ensure the process has read/write access to the containing directory.

### Authentication — `JWT_SECRET`

Secret used to sign and verify JSON Web Tokens (HS256). Tokens expire after 24 hours; a server-side revocation list tracks logout.

- **Development**: if unset, an ephemeral secret is generated at startup so the server boots without configuration. All tokens are invalidated on every restart.
- **Production**: the server **fails to start** if `JWT_SECRET` is missing. Generate with `openssl rand -base64 32`.

### Cookie Signing — `COOKIE_SECRET`

Secret used to sign HTTP-only authentication cookies so tampering is detectable.

- **Development**: if unset, cookies are unsigned (accepted but not tamper-proof).
- **Production**: must be set explicitly to a strong random string — e.g. `openssl rand -base64 32`.

### Seed Account — `SEED_EMAIL` & `SEED_PASSWORD`

Credentials for the bootstrap developer account created at startup.

- **Development**: if unset, defaults to `admin@routini.dev` / `changeme`.
- **Production**: set both to unique, strong values. The actual values are intentionally not documented here.

### CORS Origin — `CLIENT_URL`

The public origin the frontend is served from. Used to allow-list CORS requests (wildcard `*` is not permitted because credentials/cookies are enabled).

- **Development**: defaults to `http://localhost:5173`.
- **Production**: set to your deployed frontend URL (e.g. `https://example.com`).

### Server Port — `PORT`

Port the Express backend listens on.

- **Default**: `3001`.
- **Production**: typically left at the default and fronted by a reverse proxy (nginx) that maps `443 → 3001`.

### Runtime Mode — `NODE_ENV`

Controls runtime behavior and security defaults.

| Value | Effect |
|-------|--------|
| `production` | Enforces `JWT_SECRET`/`CREDENTIALS_MASTER_KEY` presence, enables `secure` cookies (HTTPS-only), uses 10 bcrypt rounds, disables test-only rate-limit skipping. |
| `test` | Uses 1 bcrypt round (speed), skips API and login rate limiters, prevents the server from calling `listen()` so supertest can bind its own port. |
| `development` (or unset) | Permissive defaults suitable for local development. |

### Email Notifications — `SMTP_*`

SMTP configuration for task-outcome notification emails. All values are read exclusively from environment variables — no secrets are accepted through any user-facing API.

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | Mail server hostname. When unset, email sending is a silent no-op (no transporter is created). | — |
| `SMTP_PORT` | SMTP port. | `587` |
| `SMTP_SECURE` | `true` for implicit TLS (typically port 465); otherwise STARTTLS is used. | `false` |
| `SMTP_USER` | Auth username. For SendGrid's SMTP relay use the literal string `apikey`. | — |
| `SMTP_PASS` | Auth password. For SendGrid, this is your SendGrid API key. | — |
| `SMTP_FROM` | Envelope `From` address used on outgoing notifications. | `noreply@routini.dev` |

- **Development**: if `SMTP_HOST` is unset, email notifications are skipped silently — no error is raised and tasks still succeed.
- **Test**: leave `SMTP_HOST` unset so the transport factory returns `null`; unit tests inject mock transporters directly.
- **Production**: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` via a secrets manager. Never commit credentials to source control. SMTP credentials are never written to logs or included in thrown error messages.

### SSH Daily Tasks — `SSH_*`

Credentials for SSH daily tasks (action type `ssh`). Credentials are read exclusively from environment variables to avoid storing secrets in the task database; only the non-secret connection parameters (`host`, `port`, `username`, `command`) are stored on the task.

| Variable | Description | Default |
|----------|-------------|---------|
| `SSH_PRIVATE_KEY` | PEM-encoded private key (preferred auth method). | — |
| `SSH_KEY_PASSPHRASE` | Passphrase for an encrypted private key. Only read when `SSH_PRIVATE_KEY` is set. | — |
| `SSH_PASSWORD` | Password auth. Used only when `SSH_PRIVATE_KEY` is not set. | — |
| `SSH_CONNECT_TIMEOUT_MS` | Connect/read timeout in milliseconds. Non-numeric or non-positive values fall back to the default. | `10000` |

- At least one of `SSH_PRIVATE_KEY` or `SSH_PASSWORD` must be set, otherwise SSH tasks fail with a clear configuration error.
- Credentials are never included in logs or error messages returned to the client.

### IMAP Email-Check Tasks — `IMAP_PASS`

Password for IMAP email-check daily tasks (action type `email`). Only the non-secret connection parameters (`host`, `port`, `username`, `mailbox`, `searchCriteria`, `tls`) are stored on the task; the password is always read from the environment.

| Variable | Description | Default |
|----------|-------------|---------|
| `IMAP_PASS` | Password used to authenticate to the IMAP server. | — |

- If `IMAP_PASS` is unset, IMAP tasks fail with a clear configuration error before opening a connection.
- The password is never included in logs or error messages returned to the client (sanitised from executor errors).

## Development Credentials

The seed account is configured via environment variables (see the [Environment Variables](#environment-variables) table above):

```bash
export SEED_EMAIL=yourname@example.com
export SEED_PASSWORD=your-local-password
export JWT_SECRET=a-long-random-secret-at-least-32-chars
export COOKIE_SECRET=another-strong-random-string
```

If the variables are not set, a default account is created and ephemeral secrets are generated for local development only.  
**Never deploy without setting these variables.** The actual values are intentionally not documented here.

### Authentication Security

Authentication uses **JWT (signed HS256)** with a 24-hour expiry and a server-side revocation list for logout.  
Passwords are hashed with **bcrypt** (10 rounds in production, 1 round in tests for speed).  
The login endpoint is **rate-limited** to 10 attempts per IP per 15 minutes.

Pre-production checklist:
- Set `JWT_SECRET` via environment variable (see [Environment Variables](#environment-variables))
- Set `COOKIE_SECRET` via environment variable
- Set `SEED_EMAIL` and `SEED_PASSWORD` to unique, strong values
- Set `CREDENTIALS_MASTER_KEY` to a high-entropy secret sourced from a secrets manager (see [Environment Variables](#environment-variables))
- Set `ROUTINI_DB_PATH` to a path on a persistent volume
- Set `CLIENT_URL` to the deployed frontend origin
- Serve the application behind HTTPS (TLS termination at the load balancer or reverse proxy)
- Replace the in-memory revocation list and user store with a persistent database

## License

MIT
