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

## Project structure

```
routini/
├── server/                # Express.js backend (TypeScript, ESM)
│   ├── src/
│   │   ├── app.ts         # createApp() factory (used by index + tests)
│   │   ├── config.ts      # Env parsing / typed AppConfig
│   │   ├── index.ts       # Boot entrypoint (calls app.listen)
│   │   └── routes.ts      # /api routers
│   ├── vitest.config.ts   # Vitest config (points at ../tests too)
│   └── package.json
├── client/                # React frontend (TypeScript, Vite)
│   ├── src/
│   │   ├── main.tsx       # React entrypoint
│   │   └── App.tsx        # Root component
│   └── package.json
├── tests/                 # Cross-cutting integration tests (supertest)
│   ├── api.test.ts
│   └── config.test.ts
├── .env.example           # Documented env vars (copy to .env, git-ignored)
├── .gitignore             # Excludes node_modules, caches, .env, build/
├── Makefile               # Convenience task runner
└── package.json           # Root scripts (dev, build, test, install:all)
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

## Build & production

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

The suite uses [Vitest](https://vitest.dev) and
[supertest](https://github.com/ladjs/supertest) to drive the Express app
in-process, so no port is bound during tests. It covers:

- Happy paths for `/health`, `/api/version`, and `/api/items` CRUD.
- Validation errors (missing / non-string / empty / oversized name,
  negative and non-numeric ids).
- 404 responses for unknown items and unknown routes.

## API surface

The initial skeleton exposes a small demonstration surface that will be
replaced by the task-CRUD API in a later PRD step.

| Method | Endpoint          | Description                                 |
| ------ | ----------------- | ------------------------------------------- |
| GET    | `/health`         | Liveness probe (JSON with ISO timestamp)    |
| GET    | `/api/version`    | Application name and version                |
| GET    | `/api/items`      | List demo items                             |
| GET    | `/api/items/:id`  | Fetch a single item (400 on invalid id)     |
| POST   | `/api/items`      | Create an item (`name`: non-empty ≤200 chr) |
| DELETE | `/api/items/:id`  | Delete an item                              |

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
- **JSON body limit** of `1mb` on all endpoints guards against trivial
  payload-DoS on unauthenticated routes.
- **Error handler** logs the underlying cause server-side but only sends
  a generic message to the client — no stack traces or internal state
  leak across the wire.
- **`.gitignore`** blocks `node_modules/`, npm caches, `dist/`/`build/`,
  and every `.env*` variant so credentials never accidentally enter git.

## Architecture notes

- `createApp(config?)` in `server/src/app.ts` returns a fully wired
  Express app. `index.ts` only handles process concerns (config load,
  `listen`). This split keeps the app trivially testable via supertest
  and lets tests override the CORS allowlist per-case.
- Environment parsing lives in `server/src/config.ts` behind a single
  `loadConfig()` factory so `process.env` reads have one seam.
- Input validation is centralized in small type guards in `routes.ts`
  (`parseId`, `isValidName`) rather than duplicated per handler.

## License

MIT
