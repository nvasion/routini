// Opt-in: the same tenancy guarantees on a real Postgres server, connected as a
// NON-superuser that owns the database (the managed-Postgres situation).
//   ROUTINI_TEST_PG_URL=postgres://owner:pw@localhost:5432/routini_test npx vitest run tests/pg-real.test.ts
// The database must be empty; the test drops everything it created afterwards.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDb, type Db } from '../server/src/db/index'
import { withOwnerClient } from '../server/src/db/drivers'
import { createOrg } from '../server/src/repos/identity'
import { getSecret, putSecret } from '../server/src/repos/credentials'
import { createSecretBox } from '../server/src/crypto/secrets'
import { TEST_MASTER_KEY } from './helpers/testApp'

const url = process.env['ROUTINI_TEST_PG_URL']
const box = createSecretBox(TEST_MASTER_KEY)

describe.skipIf(!url)('real Postgres (non-superuser owner)', () => {
  let db: Db
  let a: string
  let b: string

  beforeAll(async () => {
    db = await openDb({ databaseUrl: url, dataDir: ':memory:' })
    a = (await db.tx((q) => createOrg(q, { name: 'A', slugBase: 'pg-a', plan: 'free' }))).id
    b = (await db.tx((q) => createOrg(q, { name: 'B', slugBase: 'pg-b', plan: 'free' }))).id
    await db.org(a, (q) => putSecret(q, box, a, 'ka', 'va', null))
    await db.org(b, (q) => putSecret(q, box, b, 'kb', 'vb', null))
  })

  afterAll(async () => {
    await db?.close()
    await withOwnerClient(url!, (q) => q.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'))
  })

  it('connects as a non-superuser and runs queries as routini_app', async () => {
    const [row] = await db.tx((q) => q.query<{ cu: string; su: boolean }>(
      `SELECT current_user AS cu, (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS su`,
    ))
    expect(row).toEqual({ cu: 'routini_app', su: false })
  })

  it('isolates orgs and hides tenant rows without context', async () => {
    expect(await db.org(a, (q) => q.query('SELECT key FROM credentials'))).toEqual([{ key: 'ka' }])
    expect(await db.query('SELECT key FROM credentials')).toEqual([])
    expect((await db.system((q) => q.query('SELECT key FROM credentials'))).length).toBe(2)
    await expect(
      db.org(a, (q) => q.query(`INSERT INTO credentials (org_id, key, ciphertext, iv) VALUES ($1, 'x', 'c', 'i')`, [b])),
    ).rejects.toThrow(/row-level security/)
    expect(await db.org(b, (q) => getSecret(q, box, b, 'kb'))).toBe('vb')
  })

  it('re-opening does not re-run migrations', async () => {
    const again = await openDb({ databaseUrl: url, dataDir: ':memory:' })
    expect((await again.system((q) => q.query('SELECT id FROM orgs'))).length).toBe(2)
    await again.close()
  })

  it('delivers NOTIFY to listeners', async () => {
    const got: string[] = []
    const stop = await db.listen('routini_test_chan', (p) => got.push(p))
    await db.tx((q) => q.query(`SELECT pg_notify('routini_test_chan', 'hi')`))
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await stop()
    expect(got).toEqual(['hi'])
  })
})
