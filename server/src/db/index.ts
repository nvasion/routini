// ─────────────────────────────────────────────────────────────────────────────
// Database bootstrap and tenancy facade
//
// openDb() picks the driver (DATABASE_URL → node-postgres, otherwise embedded
// PGlite), applies migrations as the owner, then returns a Db whose org() /
// system() helpers set the row-level-security context per transaction.
// ─────────────────────────────────────────────────────────────────────────────

import { createPgDriver, createPgliteDriver, openPglite, withOwnerClient } from './drivers.js'
import { migrate } from './migrations.js'
import type { Db, Driver, Queryable } from './types.js'

export type { Db, Queryable } from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OpenDbOptions {
  databaseUrl?: string
  /** PGlite data directory, or ':memory:'. Ignored when databaseUrl is set. */
  dataDir: string
  /** In-memory PGlite only: start from this dumped data directory (tests clone a migrated snapshot). */
  snapshot?: Blob | File
}

export async function openDb(opts: OpenDbOptions): Promise<Db> {
  if (opts.databaseUrl) {
    await withOwnerClient(opts.databaseUrl, (q) => migrate(q))
    return createDbFacade(createPgDriver(opts.databaseUrl))
  }
  const lite = await openPglite(opts.dataDir, opts.snapshot)
  await migrate({
    query: async (sql, params) => (await lite.query(sql, params as unknown[])).rows as never[],
    exec: async (sql) => {
      await lite.exec(sql)
    },
  })
  return createDbFacade(await createPgliteDriver(lite))
}

export function createDbFacade(driver: Driver): Db {
  const scoped = <T>(orgId: string | null, system: boolean, fn: (q: Queryable) => Promise<T>) =>
    driver.transaction(async (q) => {
      await q.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.system', $2, true)`,
        [orgId ?? '', system ? 'on' : 'off'],
      )
      return fn(q)
    })

  return {
    embedded: driver.embedded,
    query: (sql, params) => scoped(null, false, (q) => q.query(sql, params)),
    tx: (fn) => scoped(null, false, fn),
    org: (orgId, fn) => {
      if (!UUID_RE.test(orgId)) return Promise.reject(new Error('db.org() requires an org UUID'))
      return scoped(orgId, false, fn)
    },
    system: (fn) => scoped(null, true, fn),
    listen: (channel, handler) => driver.listen(channel, handler),
    close: () => driver.close(),
  }
}
