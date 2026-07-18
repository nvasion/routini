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
│   │   └── routes/
│   │       ├── auth.ts          # POST /login, /logout  GET /me
│   │       ├── tasks.ts         # CRUD + trigger for tasks
│   │       └── settings.ts      # GET/PUT AI settings
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

## Development Credentials

The seed account is configured via environment variables:

```bash
export SEED_EMAIL=yourname@example.com
export SEED_PASSWORD=your-local-password
export JWT_SECRET=a-long-random-secret-at-least-32-chars
```

If the variables are not set, a default account is created and an ephemeral JWT secret is generated for local development only.  
**Never deploy without setting these variables.** The actual values are intentionally not documented here.

### Authentication Security

Authentication uses **JWT (signed HS256)** with a 24-hour expiry and a server-side revocation list for logout.  
Passwords are hashed with **bcrypt** (10 rounds in production, 1 round in tests for speed).  
The login endpoint is **rate-limited** to 10 attempts per IP per 15 minutes.

Pre-production checklist:
- Set `JWT_SECRET`, `SEED_EMAIL`, and `SEED_PASSWORD` via environment variables
- Serve the application behind HTTPS (TLS termination at the load balancer or reverse proxy)
- Replace the in-memory revocation list and user store with a persistent database

## License

MIT
