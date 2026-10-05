# Routini

**An AI engineer platform.** Routini runs jobs for you: scheduled checks, server
chores, incident triage and coding work done by agents that open pull
requests. Every run is recorded step by step, anything risky waits for a person
to approve it, and you can watch it all happen live.

Open source under the [AGPL-3.0](LICENSE). Self-host it, or use it hosted on
TynHub at routini.tynhub.com.

## How it works

```
Trigger ─▶ Job ─▶ Run ─▶ Steps
manual        trigger    action    http · ssh · imap
cron (tz)     + steps    agent     a coding agent in a container → PR
webhook                  approval  waits for a person
```

- A **job** is a trigger plus an ordered list of steps. Each step has a `when`
  rule (`on_success` · `on_failure` · `always`, relative to the last step that
  ran), and optional retries and timeout.
- A **run** is one execution. It is durable: every transition is stored in
  Postgres, so restarts, crashes and multiple workers are safe. A step left
  running by a dead worker is retried or failed as "worker lost".
- **Approvals** park the run without holding a worker. Approve or deny from the
  inbox or the run page; the step's `minRole` decides who may.
- **Agent steps** run Claude Code in an ephemeral container (see
  [agents/](agents/README.md)), stream what it does into the timeline, run your
  done-check (e.g. `npm test`), push a branch and open the pull request.
- Every log line, output and error is **redacted** against the secrets that
  step was given.
- **Environments** are persistent workspaces: a container plus a `/workspace`
  volume, optionally with your repository cloned in. Open a terminal in one from
  the console, or point agent steps at it (`environmentId`). Agents then work in
  their own git worktree inside it, so your checkout is untouched and you can
  inspect the result. Stopping keeps `/workspace`; idle environments stop on
  their own.

## The console

Inbox (what needs you, what's live, what's next) · Runs · live run timeline ·
Jobs and the job editor · Integrations · Settings. The right-hand **dock** shows
your servers with health checks, and a live view of any run; it collapses or
pops out into its own window. Three themes: **Routini** (default), **TynHub
dark** and **TynHub light**.

## Quick start (development)

Needs Node 22 and, for agent steps, Docker.

```bash
make install
make dev          # API on :3001 (embedded Postgres, worker inline) + console on :5173
```

Open http://localhost:5173 and sign in as `admin@routini.dev` / `changeme`
(created on first boot in development only). Data lives in `server/data/pg`.

To run agent steps locally, build the image and add a model key in
Settings → Models:

```bash
make agents
```

## Self-hosting with Docker

```bash
cp .env.example .env        # set JWT_SECRET, COOKIE_SECRET, CREDENTIALS_MASTER_KEY
make agents                 # build routini/agent-claude:latest
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
docker compose up --build -d
```

Open http://localhost and create the first account: it owns the server, and
further signups are closed (`ROUTINI_SIGNUP`). The stack is Postgres, the API,
a worker (`docker compose up --scale worker=3` for more) and nginx.

The API and the worker reach Docker (the API runs environments and their terminals; the worker runs agent containers). Mounting the socket gives them
root-equivalent access to that host, so for production point `DOCKER_HOST` at a
separate runner host (`ssh://…` or TLS `tcp://…`) instead.

Back up the database and `CREDENTIALS_MASTER_KEY` together: without the key,
stored secrets cannot be decrypted.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | Postgres. Unset: embedded Postgres (PGlite) in `ROUTINI_DATA_DIR`, with the worker inline. |
| `ROUTINI_DATA_DIR` | `./data/pg` | Embedded Postgres directory. |
| `ROUTINI_MODE` | `selfhost` | `hosted` = plan limits, open signup, private network targets blocked. |
| `ROUTINI_SIGNUP` | `first-user-only` (hosted: `open`) | or `closed`. |
| `ROUTINI_INLINE_WORKER` | on without `DATABASE_URL` | Run scheduler + queue in the API process. |
| `JWT_SECRET`, `COOKIE_SECRET` | required in production | Session signing. |
| `CREDENTIALS_MASTER_KEY` | required in production | 32 bytes (hex/base64). Encrypts every stored secret. |
| `CLIENT_URL` | `http://localhost:5173` | Console origin (CORS). |
| `DOCKER_HOST` | local socket | Where agent containers run. |
| `ROUTINI_AGENT_IMAGE_CLAUDE` | `routini/agent-claude:latest` | Agent image (also `_OMNIMANCER`, `_OPENCODE`). |
| `ROUTINI_WORKER_CONCURRENCY` | `4` | Runs per worker process. |
| `ROUTINI_ENV_IMAGES` | agent images | Hosted mode: images environments may use (comma separated). Self-host allows any image. |
| `SEED_EMAIL`, `SEED_PASSWORD` | dev: admin@routini.dev / changeme | First account on an empty database. |
| `SMTP_*` | — | Run-finished emails (per-org settings decide who gets them). |

## Multi-tenancy and security

- Everything belongs to an **org**; people have a role in each (owner, admin,
  member, viewer). Non-members get 404 for an org's resources.
- Tenant tables use Postgres **row-level security**: every query runs as a
  restricted role, and a query without the org context sees no tenant rows. This
  is tested on embedded Postgres and on a real Postgres with a non-superuser
  owner.
- Secrets (model keys, integration tokens, SSH keys, webhook secrets) are
  AES-256-GCM encrypted, bound to their org and key, and write-only over the
  API.
- **Limits** per org: concurrent runs, agent minutes per day, model budget per
  day. Plans set the ceiling; admins can tighten it. Self-hosted orgs default to
  10 concurrent runs and no daily caps; hosted free orgs to 2 and 120 minutes.
- Known gap (Phase 2): an agent container can read the tokens it is given. A
  credential broker and egress proxy will keep them out of the sandbox.

## API

Session: `POST /api/auth/signup | login | logout`, `GET /api/auth/me`. Browser
sessions use an HTTP-only cookie plus an `X-CSRF-Token` header on mutations;
scripts can use `Authorization: Bearer <token>` instead.

Under `/api/orgs/:org`:

| Area | Endpoints |
|---|---|
| Org | `GET/PUT /`, `GET/POST /members`, `PUT/DELETE /members/:userId` |
| Jobs | `GET/POST /jobs`, `GET/PUT/DELETE /jobs/:id`, `POST /jobs/:id/run` |
| Runs | `GET /runs`, `GET /runs/:run`, `GET /runs/:run/events`, `GET /runs/:run/stream` (SSE, resumes from `Last-Event-ID`), `POST /runs/:run/cancel`, `POST /runs/:run/rerun`, `POST /runs/:run/steps/:idx/approve` and `…/deny` |
| Inbox | `GET /inbox`, `GET /stream` (SSE of run changes) |
| Hosts | `GET/POST /hosts`, `GET/PUT/DELETE /hosts/:id`, `POST /hosts/:id/check` |
| Environments | `GET/POST /environments`, `GET/PUT/DELETE /environments/:id`, `POST /environments/:id/start`, `…/stop`, `…/exec`; WebSocket `…/terminal` |
| Integrations | `GET /integrations`, `PUT/DELETE /integrations/:id`, `POST /integrations/:id/test` |
| Settings | `GET/PUT /settings`, `GET /credentials`, `PUT/DELETE /credentials/:key` |

Webhook triggers: `POST /api/hooks/:org/:jobId` with
`Authorization: Bearer <secret>` (works with Alertmanager) or
`X-Routini-Signature: sha256=<HMAC of the body>`. The JSON body is kept on the
run.

## Development

```
server/src/
  config.ts  bootstrap.ts  index.ts (API)  worker.ts (worker)  app.ts
  db/        Postgres + PGlite drivers, migrations, tenancy (org/system transactions)
  repos/     data access: identity, credentials, integrations, settings, jobs, runs, hosts
  engine/    spec, engine (run state machine), worker (queue), scheduler, executors,
             agent (+ agentStream parser), hub (SSE fan-out), notify
  routes/    org-scoped HTTP APIs, hooks
  http/      auth, org context, SSE, errors
  services/  http / ssh / imap / email executors, Docker
client/src/  lib (api, auth, theme, hooks), shell (top bar, nav, dock), pages, styles
agents/      agent image contract, Claude Code image, fake replay image
tests/       server tests (Vitest); client tests live next to their code
```

```bash
make test           # server (embedded Postgres) + client
make test-pg        # needs ROUTINI_TEST_PG_URL: real Postgres, non-superuser owner
make test-docker    # needs Docker: real agent containers with the fake image
```

## License

[AGPL-3.0-only](LICENSE). If you run a modified Routini as a network service,
you must offer its source to the service's users.
