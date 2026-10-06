# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What Routini is

An AI engineer platform: **Trigger → Job → Run → Steps**. Steps are actions
(http/ssh/imap), coding agents in containers, or approvals. Runs are durable in
Postgres and executed by a lease-based queue worker. Multi-tenant by org, with
row-level security. A React console (inbox, runs, jobs, dock) sits on top.
README.md is the user-facing overview; `tynhub-prds/PRD-routini-phase0-foundation.md`
(in the TynHub workspace) is the design of record.

## Commands

```bash
make install        # all dependencies
make dev            # API :3001 (embedded Postgres, inline worker) + console :5173
make test           # server + client tests — run before every commit
make test-pg        # opt-in: ROUTINI_TEST_PG_URL=postgres://… (non-superuser owner)
make test-docker    # opt-in: real agent containers (needs Docker)
make agents         # build agent images
cd server && npx tsc --noEmit -p .   # typecheck server
cd client && npx tsc --noEmit -p .   # typecheck client
```

On this machine Node and Docker live in WSL (Ubuntu-24.04); run commands there.

## Rules that keep the system correct

- **Tenancy.** Tenant rows are read and written only inside `db.org(orgId, q => …)`.
  Repository functions take `orgId` and filter by it as well. `db.system(…)` is for
  the scheduler, worker and bootstrap only. A new tenant table needs `org_id` and
  `SELECT routini_tenant('<table>')` in its migration.
- **Migrations** are append-only entries in `server/src/db/migrations.ts`. Never
  edit a shipped migration; add a new version.
- **Run state** changes go through `repos/runs.ts` helpers (`setRunStatus`,
  `updateStep`, `appendEvent`) so every change emits an event + NOTIFY. Executors
  run outside transactions.
- **Secrets** never appear in API responses, events or logs. Use the credential
  store (write-only API), register values with `ctx.addSecret`/`ctx.secret` in
  executors, and let `utils/redact.ts` scrub output.
- **Network safety.** HTTP/SSH targets on private addresses are allowed only in
  `selfhost` mode. HTTP never follows redirects. Repo URLs go through
  `utils/repoUrl.ts`.
- **Agent images** must follow the contract in `agents/README.md`. Keep shell
  scripts LF (`.gitattributes`) and portable (BusyBox in the fake image).
- **UI colours** come only from tokens in `client/src/styles/tokens.css`; status
  colours mean the same in every theme, and in the Routini theme red is identity
  only (in content, red = failed).

## Code style

TypeScript strict, ES modules. Server: small modules, explicit errors
(`HttpError` for client-safe messages), validation that reports the exact field.
Client: functional components, pure logic in separate tested modules
(`jobForm.ts`, `timeline.ts`, `format.ts`). Match surrounding comment density.
Write tests for new behaviour: server integration tests in `tests/` via
`tests/helpers/testApp.ts`; client tests next to the code.
