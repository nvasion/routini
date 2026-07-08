# routini

A full-stack TypeScript application

## Features

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
│   │   ├── App.css            # Red / orange / black theme
│   │   ├── auth/
│   │   │   ├── AuthContext.tsx  # useAuth() hook
│   │   │   └── authApi.ts       # login/logout/session fetches
│   │   └── pages/
│   │       ├── Login.tsx        # Login form
│   │       └── Dashboard.tsx    # Item list (auth required)
│   └── package.json
├── tests/                     # Vitest tests
├── Makefile                   # Build commands
└── package.json               # Root scripts
```

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Install all dependencies
make install
# or
npm run install:all
```

### Development

Start both server and client:

```bash
make dev
# or
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

The Vite dev server proxies `/api` and `/health` to the backend so cookies work
as a same-origin request during development.

### Building

```bash
make build
# or
npm run build
```

### Production

```bash
make start
# or
npm run start
```

## Configuration

The auth module reads configuration from environment variables. Sensible defaults
are used in development; production requires `JWT_SECRET` **and** a non-default
`DEFAULT_ADMIN_PASSWORD` to be set — the server refuses to start otherwise.

| Variable                          | Default             | Description                                                                                          |
|-----------------------------------|---------------------|------------------------------------------------------------------------------------------------------|
| `JWT_SECRET`                      | (dev fallback)      | HMAC secret for signing tokens. **Required in production**, ≥ 32 chars.                              |
| `JWT_TTL_SECONDS`                 | `3600` (1 hour)     | Token / cookie lifetime. Capped at 24 hours. Kept short deliberately — see *Session lifetime* below. |
| `DEFAULT_ADMIN_USERNAME`          | `admin`             | Seeded on server start when the user store is empty.                                                 |
| `DEFAULT_ADMIN_PASSWORD`          | `changeme` (dev)    | Seeded admin password. **Must be overridden in production or the server refuses to start.**          |
| `USER_STORE_PATH`                 | (in-memory)         | Absolute path to a JSON file. When set, users + sessions survive restarts.                           |
| `LOGIN_RATE_LIMIT_MAX`            | `10`                | Max failed login attempts per (client IP, username) inside the window.                               |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `60`                | Sliding window for the login rate limiter.                                                           |
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

## Theme

The UI uses the routini palette:

- `--color-red: #ff0000ff`
- `--color-orange: #ffa500ff`
- `--color-black: #000000ff`

All theme tokens are declared as **8-digit hex** (`#rrggbbaa`) in
`client/src/App.css` — one consistent format for opaque and translucent
colors alike — and applied to buttons, headers, borders, focus rings, and the
login card accent.

## Author

Developer

## License

MIT
