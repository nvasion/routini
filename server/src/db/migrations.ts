// ─────────────────────────────────────────────────────────────────────────────
// Schema migrations
//
// Append-only list. Each migration runs exactly once, in order, inside a
// transaction, recorded in schema_migrations. The runner holds a Postgres
// advisory lock so concurrent boots (several API/worker processes) never race.
//
// Tenant tables call `routini_tenant(<table>)` to enable and force row-level
// security with the standard org policy; see db/types.ts for the model.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from './types.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

const ADVISORY_LOCK_KEY = 72_617_111 // arbitrary, stable: "routini migrations"

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core: roles, tenancy, identity, credentials, integrations, settings',
    sql: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routini_app') THEN
    CREATE ROLE routini_app NOLOGIN;
  END IF;
END $$;
GRANT routini_app TO CURRENT_USER;

-- True when the row's org is the transaction's org, or the transaction runs in system context.
CREATE FUNCTION routini_org_visible(row_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT row_org = nullif(current_setting('app.org_id', true), '')::uuid
      OR current_setting('app.system', true) = 'on'
$$;

-- Enables and forces RLS on a tenant table with the standard org policy.
CREATE FUNCTION routini_tenant(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY org_isolation ON %s USING (routini_org_visible(org_id)) WITH CHECK (routini_org_visible(org_id))',
    tbl);
END $$;

-- ── Global tables (no RLS) ──────────────────────────────────────────────────

CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  plan       text NOT NULL DEFAULT 'free',
  limits     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text,
  display_name  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- External identities. Phase 0 writes provider 'local'; TynHub SSO adds 'tynhub'.
CREATE TABLE identities (
  provider   text NOT NULL,
  subject    text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

CREATE TABLE memberships (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE revoked_tokens (
  jti        text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

-- ── Tenant tables (RLS) ─────────────────────────────────────────────────────

-- Encrypted secrets (AES-256-GCM, see crypto/secrets.ts). Never returned over the API.
CREATE TABLE credentials (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key        text NOT NULL,
  ciphertext text NOT NULL,
  iv         text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
SELECT routini_tenant('credentials');

-- Non-secret connection metadata; the secrets themselves live in credentials.
CREATE TABLE integrations (
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  integration_id    text NOT NULL,
  connected_at      timestamptz,
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_message text,
  scopes            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, integration_id)
);
SELECT routini_tenant('integrations');

CREATE TABLE org_settings (
  org_id        uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  ai            jsonb NOT NULL DEFAULT '{}'::jsonb,
  notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT routini_tenant('org_settings');
`,
  },
  {
    version: 2,
    name: 'engine: hosts, jobs, runs, steps, events, approvals, queue',
    sql: `
-- Fleet inventory. SSH steps reference a host; its secret lives in credentials.
CREATE TABLE hosts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  host_group     text NOT NULL DEFAULT '' CHECK (length(host_group) <= 60),
  address        text NOT NULL CHECK (length(address) BETWEEN 1 AND 253),
  port           integer NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username       text NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  auth           text NOT NULL DEFAULT 'key' CHECK (auth IN ('key', 'password')),
  credential_key text,
  tags           text[] NOT NULL DEFAULT '{}',
  last_check     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
SELECT routini_tenant('hosts');

CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  trigger     jsonb NOT NULL,
  steps       jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX jobs_org_idx ON jobs (org_id) WHERE archived_at IS NULL;
CREATE INDEX jobs_due_idx ON jobs (next_run_at) WHERE enabled AND archived_at IS NULL AND next_run_at IS NOT NULL;
SELECT routini_tenant('jobs');

-- Per-org run numbers (#1, #2, …).
CREATE TABLE run_counters (
  org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  value  integer NOT NULL
);
SELECT routini_tenant('run_counters');

CREATE TABLE runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number           integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled')),
  trigger          jsonb NOT NULL,
  job_snapshot     jsonb NOT NULL,
  cost_usd         numeric(12, 6) NOT NULL DEFAULT 0,
  agent_seconds    integer NOT NULL DEFAULT 0,
  error            text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX runs_org_created_idx ON runs (org_id, number DESC);
CREATE INDEX runs_org_status_idx ON runs (org_id, status);
CREATE INDEX runs_job_idx ON runs (job_id, number DESC);
SELECT routini_tenant('runs');

CREATE TABLE run_steps (
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  idx         integer NOT NULL,
  step_id     text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'canceled')),
  attempt     integer NOT NULL DEFAULT 0,
  output      jsonb,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, idx)
);
SELECT routini_tenant('run_steps');

-- Append-only; the source of truth for timelines and SSE (id = Last-Event-ID).
CREATE TABLE run_events (
  id       bigserial PRIMARY KEY,
  org_id   uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_idx integer,
  ts       timestamptz NOT NULL DEFAULT now(),
  type     text NOT NULL,
  data     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX run_events_run_idx ON run_events (run_id, id);
SELECT routini_tenant('run_events');

CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_idx     integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'canceled')),
  message      text NOT NULL,
  min_role     text NOT NULL DEFAULT 'member',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  comment      text,
  UNIQUE (run_id, step_idx)
);
CREATE INDEX approvals_pending_idx ON approvals (org_id) WHERE status = 'pending';
SELECT routini_tenant('approvals');

-- One row = "advance this run". Claimed with FOR UPDATE SKIP LOCKED under a lease.
CREATE TABLE queue (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_until timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_ready_idx ON queue (available_at);
SELECT routini_tenant('queue');
`,
  },
  {
    version: 3,
    name: 'environments: persistent workspaces and their audit trail',
    sql: `
CREATE TABLE environments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  image            text NOT NULL,
  repo             jsonb,
  status           text NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed', 'deleting')),
  status_detail    text,
  container_id     text,
  volume           text NOT NULL,
  cpus             numeric(4, 2) NOT NULL DEFAULT 2,
  memory_mb        integer NOT NULL DEFAULT 4096,
  idle_minutes     integer NOT NULL DEFAULT 60 CHECK (idle_minutes BETWEEN 5 AND 10080),
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX environments_running_idx ON environments (status) WHERE status IN ('starting', 'running');
SELECT routini_tenant('environments');

CREATE TABLE environment_events (
  id             bigserial PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL DEFAULT now(),
  type           text NOT NULL,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX environment_events_env_idx ON environment_events (environment_id, id);
SELECT routini_tenant('environment_events');
`,
  },
  {
    version: 4,
    name: 'policy: org rules, policy approvals, egress settings',
    sql: `
CREATE TABLE org_policies (
  org_id     uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  rules      jsonb NOT NULL DEFAULT '[]'::jsonb,
  egress     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT routini_tenant('org_policies');

-- 'step' approvals come from approval steps; 'policy' approvals gate another step.
ALTER TABLE approvals ADD COLUMN source text NOT NULL DEFAULT 'step' CHECK (source IN ('step', 'policy'));
ALTER TABLE approvals ADD COLUMN rule text;
-- Set once a policy approval for the step is granted, so the step runs without re-gating.
ALTER TABLE run_steps ADD COLUMN policy_cleared boolean NOT NULL DEFAULT false;
`,
  },
]

/** Grants the app role access to everything a migration created. Runs after every migration. */
const GRANTS = `
GRANT USAGE ON SCHEMA public TO routini_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO routini_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO routini_app;
REVOKE ALL ON schema_migrations FROM routini_app;
`

/**
 * Applies pending migrations. `run` executes a batch of statements as the
 * connecting (owner) user in one transaction; drivers supply it.
 */
export async function migrate(
  owner: Queryable & { exec?: (sql: string) => Promise<void> },
  migrations: Migration[] = MIGRATIONS,
): Promise<number[]> {
  const exec = async (sql: string) => {
    if (owner.exec) await owner.exec(sql)
    else await owner.query(sql)
  }

  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  await owner.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
  try {
    const rows = await owner.query<{ version: number }>('SELECT version FROM schema_migrations')
    const applied = new Set(rows.map((r) => r.version))
    const done: number[] = []
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue
      await exec(
        `BEGIN;\n${m.sql}\n${GRANTS}\n` +
          `INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${quote(m.name)});\nCOMMIT;`,
      )
      done.push(m.version)
    }
    return done
  } catch (err) {
    await exec('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await owner.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
