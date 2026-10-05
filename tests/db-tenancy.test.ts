// Postgres layer: migrations, row-level security, persistence across restart.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../server/src/db/index'
import { migrate, MIGRATIONS } from '../server/src/db/migrations'
import { openPglite } from '../server/src/db/drivers'
import { createOrg } from '../server/src/repos/identity'
import { putSecret, getSecret, listSecrets } from '../server/src/repos/credentials'
import { createSecretBox } from '../server/src/crypto/secrets'
import { TEST_MASTER_KEY } from './helpers/testApp'

const box = createSecretBox(TEST_MASTER_KEY)

describe('row-level security', () => {
  let db: Db
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    db = await openDb({ dataDir: ':memory:' })
    orgA = (await db.tx((q) => createOrg(q, { name: 'A', slugBase: 'org-a', plan: 'free' }))).id
    orgB = (await db.tx((q) => createOrg(q, { name: 'B', slugBase: 'org-b', plan: 'free' }))).id
    await db.org(orgA, (q) => putSecret(q, box, orgA, 'a-secret', 'value-a', null))
    await db.org(orgB, (q) => putSecret(q, box, orgB, 'b-secret', 'value-b', null))
  })
  afterAll(() => db.close())

  it('an org context sees only its own rows', async () => {
    const keys = await db.org(orgA, (q) => q.query<{ key: string }>('SELECT key FROM credentials'))
    expect(keys.map((k) => k.key)).toEqual(['a-secret'])
  })

  it('a query with no org context sees no tenant rows, even without a WHERE clause', async () => {
    expect(await db.query('SELECT * FROM credentials')).toEqual([])
    expect(await db.tx((q) => q.query('SELECT * FROM credentials'))).toEqual([])
  })

  it('a repository call made in the wrong org context finds nothing', async () => {
    // Org B's context asking for org A's rows: the explicit filter and RLS disagree, so nothing comes back.
    expect(await db.org(orgB, (q) => listSecrets(q, orgA))).toEqual([])
  })

  it('system context sees every org', async () => {
    const rows = await db.system((q) => q.query<{ key: string }>('SELECT key FROM credentials ORDER BY key'))
    expect(rows.map((r) => r.key)).toEqual(['a-secret', 'b-secret'])
  })

  it('rejects writing a row for another org', async () => {
    await expect(
      db.org(orgA, (q) => q.query(`INSERT INTO credentials (org_id, key, ciphertext, iv) VALUES ($1, 'x', 'c', 'i')`, [orgB])),
    ).rejects.toThrow(/row-level security/)
  })

  it('db.org() refuses a non-UUID org id', async () => {
    await expect(db.org("'; DROP TABLE orgs; --", async () => 1)).rejects.toThrow(/UUID/)
  })

  it('the app role cannot read the migration ledger', async () => {
    await expect(db.query('SELECT * FROM schema_migrations')).rejects.toThrow(/permission denied/)
  })

  it('secrets are bound to their org: a ciphertext copied to another org fails to decrypt', async () => {
    await db.system((q) =>
      q.query(
        `INSERT INTO credentials (org_id, key, ciphertext, iv)
         SELECT $2, 'stolen', ciphertext, iv FROM credentials WHERE org_id = $1 AND key = 'a-secret'`,
        [orgA, orgB],
      ),
    )
    await expect(db.org(orgB, (q) => getSecret(q, box, orgB, 'stolen'))).rejects.toThrow()
    expect(await db.org(orgA, (q) => getSecret(q, box, orgA, 'a-secret'))).toBe('value-a')
  })
})

describe('embedded Postgres on disk', () => {
  it('keeps data across a restart and does not re-apply migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routini-pg-'))
    try {
      const first = await openDb({ dataDir: dir })
      const org = await first.tx((q) => createOrg(q, { name: 'Persist', slugBase: 'persist', plan: 'free' }))
      await first.org(org.id, (q) => putSecret(q, box, org.id, 'k', 'survives', null))
      await first.close()

      const second = await openDb({ dataDir: dir })
      expect(await second.org(org.id, (q) => getSecret(q, box, org.id, 'k'))).toBe('survives')
      const versions = await second.system((q) => q.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs'))
      expect(versions[0]!.n).toBe('1')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('migrate() is idempotent', async () => {
    const lite = await openPglite(':memory:')
    const owner = {
      query: async (sql: string, params?: unknown[]) => (await lite.query(sql, params)).rows as never[],
      exec: async (sql: string) => {
        await lite.exec(sql)
      },
    }
    expect(await migrate(owner)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(await migrate(owner)).toEqual([])
    await lite.close()
  })
})
