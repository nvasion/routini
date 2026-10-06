// Opt-in: the same tenancy guarantees on a real Postgres server, connected as a
// NON-superuser that owns the database (the managed-Postgres situation).
//   ROUTINI_TEST_PG_URL=postgres://owner:pw@localhost:5432/routini_test npx vitest run tests/pg-real.test.ts
// The database must be empty; the test drops everything it created afterwards.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDb, type Db } from '../server/src/db/index'
import { withOwnerClient } from '../server/src/db/drivers'
import { createOrg, deleteOrg } from '../server/src/repos/identity'
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
    // Drop what the test user created. Not the schema itself: on a managed
    // cluster the user only has CREATE on `public`, it does not own it.
    await withOwnerClient(url!, (q) =>
      q.query(`DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT c.oid::regclass AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = current_user LOOP
          EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', r.t);
        END LOOP;
        FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user LOOP
          EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.f);
        END LOOP;
        FOR r IN SELECT t.oid::regtype AS ty FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) = current_user LOOP
          EXECUTE format('DROP TYPE IF EXISTS %s CASCADE', r.ty);
        END LOOP;
      END $$`),
    )
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

  it('two worker processes: cron fires once and the org concurrency cap holds', async () => {
    // Two independent connection pools stand in for two processes.
    const { createContext } = await import('../server/src/http/common')
    const { loadConfig } = await import('../server/src/config')
    const { Worker } = await import('../server/src/engine/worker')
    const { schedulerTick } = await import('../server/src/engine/scheduler')
    const { createJob } = await import('../server/src/repos/jobs')
    const db2 = await openDb({ databaseUrl: url, dataDir: ':memory:' })
    const config = loadConfig({ NODE_ENV: 'test' })
    let running = 0
    let peak = 0
    const slow = {
      async execute() {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 150))
        running--
        return { status: 'succeeded' as const }
      },
    }
    const ctxA = createContext({ config, db, box }, { executors: { agent: slow } })
    const ctxB = createContext({ config, db: db2, box }, { executors: { agent: slow } })
    await db.query(`UPDATE orgs SET limits = '{"maxConcurrentRuns": 1}' WHERE id = $1`, [a])

    const job = await db.org(a, (q) =>
      createJob(q, a, null, {
        name: 'cron',
        description: '',
        enabled: true,
        trigger: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
        steps: [{ id: 's', name: 's', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'x' } }],
      }),
    )
    const due = new Date(new Date(job.nextRunAt!).getTime() + 1000)
    const fired = await Promise.all([schedulerTick(db, due), schedulerTick(db2, due)])
    expect(fired.sort()).toEqual([0, 1])

    // Two more runs, then drain with both workers at once: never more than one at a time.
    const { createRun } = await import('../server/src/repos/runs')
    await db.org(a, (q) => createRun(q, job, { kind: 'manual', userId: '00000000-0000-0000-0000-000000000000' }))
    await db.org(a, (q) => createRun(q, job, { kind: 'manual', userId: '00000000-0000-0000-0000-000000000000' }))
    const wA = new Worker(ctxA, ctxA.engine, { heartbeatMs: 20 })
    const wB = new Worker(ctxB, ctxB.engine, { heartbeatMs: 20 })
    await Promise.all([wA.drain(), wB.drain()])
    for (let i = 0; i < 100; i++) {
      const rows = await db.system((q) => q.query<{ status: string }>(`SELECT status FROM runs WHERE org_id = $1`, [a]))
      if (rows.every((r) => r.status === 'succeeded')) break
      await Promise.all([wA.drain(), wB.drain()])
    }
    const statuses = await db.system((q) => q.query<{ status: string }>(`SELECT status FROM runs WHERE org_id = $1`, [a]))
    expect(statuses.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(peak).toBe(1)
    await db2.close()
  }, 60_000)

  it('delivers NOTIFY to listeners', async () => {
    const got: string[] = []
    const stop = await db.listen('routini_test_chan', (p) => got.push(p))
    await db.tx((q) => q.query(`SELECT pg_notify('routini_test_chan', 'hi')`))
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await stop()
    expect(got).toEqual(['hi'])
  })

  // Account deletion: as the app role, deleting an org cascades through its
  // RLS-forced tenant rows (foreign-key actions run as the table owner).
  it('deleting an org removes its tenant rows and only those', async () => {
    const c = (await db.tx((q) => createOrg(q, { name: 'C', slugBase: 'pg-c', plan: 'free' }))).id
    await db.org(c, (q) => putSecret(q, box, c, 'kc', 'vc', null))
    await db.tx((q) => deleteOrg(q, c))
    expect(await db.query('SELECT 1 FROM orgs WHERE id = $1', [c])).toHaveLength(0)
    expect(await db.system((q) => q.query('SELECT 1 FROM credentials WHERE org_id = $1', [c]))).toHaveLength(0)
    expect(await db.org(a, (q) => getSecret(q, box, a, 'ka'))).toBe('va')
  })
})
