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
│   │   │   └── credentialStore.ts # Encrypted credential store (CREDENTIALS_MASTER_KEY)
│   │   └── routes/
│   │       ├── auth.ts          # POST /login, /logout  GET /me
│   │       ├── tasks.ts         # CRUD + trigger for tasks
│   │       ├── settings.ts      # GET/PUT AI settings
│   │       └── credentials.ts   # CRUD for stored credentials
│   ├── vitest.config.ts         # Test runner config
│   └── package.json
├── client/                      # React frontend
│   ├── src/
│   │   ├── main.tsx             # React entry point
│   │   ├── App.tsx              # Router shell
│   │   ├── types.ts             # Client-side domain types
│   │   ├── components/
│   │   │   ├── Navbar.tsx / .css
│   │   │   └── TaskCard.tsx / .css
│   │   └── pages/
│   │       ├── Dashboard.tsx / .css   # Central task dashboard
│   │       ├── Login.tsx / .css       # Login page
│   │       └── Settings.tsx / .css   # AI settings page
│   └── package.json
├── tests/                       # Integration tests (supertest)
│   ├── api.test.ts              # Health + 404 tests
│   ├── auth.test.ts             # Auth endpoint tests
│   ├── tasks.test.ts            # Task CRUD + trigger tests
│   └── settings.test.ts        # Settings endpoint tests
├── Makefile
└── package.json
```

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

50 integration tests covering auth, tasks (CRUD + trigger), settings, and general API behaviour.

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
| `PUT` | `/api/tasks/:id` | Update `name` / `description` |
| `DELETE` | `/api/tasks/:id` | Remove task |
| `POST` | `/api/tasks/:id/trigger` | Queue a task for execution |

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

Master key used to encrypt and decrypt stored credentials (SSH keys, IMAP/SMTP passwords, API tokens, etc.) with **AES-256-GCM** before they are persisted to the database.

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

Filesystem path to the SQLite database file used for persistent storage (users, tasks, stored credentials, etc.).

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
