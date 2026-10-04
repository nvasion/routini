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
