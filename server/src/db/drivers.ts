// ─────────────────────────────────────────────────────────────────────────────
// Database drivers: node-postgres (pg) and embedded Postgres (PGlite)
//
// Both drivers run every application connection as the NOLOGIN role
// `routini_app` (created by migration 0001) so row-level security applies even
// when the connecting user owns the tables or, with PGlite, is a superuser.
// Migrations run before that switch, as the connecting user.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import type { Driver, NotifyHandler, Queryable } from './types.js'

export const APP_ROLE = 'routini_app'

// ── node-postgres ────────────────────────────────────────────────────────────

/**
 * Connection settings for `url`. With DATABASE_CA_CERT (a PEM, e.g. App
 * Platform's ${db.CA_CERT}), TLS is verified against that CA: the chain must
 * lead to it, though the host name is not checked, so private and public
 * endpoints of a managed cluster both work. Any sslmode in the URL is dropped
 * then, because node-postgres would let it override the CA (and treats
 * sslmode=require as verify-full against the system store).
 */
export function pgConfig(url: string, env: NodeJS.ProcessEnv = process.env): pg.ClientConfig {
  const ca = env['DATABASE_CA_CERT']?.trim()
  if (!ca) return { connectionString: url }
  const u = new URL(url)
  for (const key of ['sslmode', 'ssl', 'sslrootcert', 'uselibpqcompat']) u.searchParams.delete(key)
  return { connectionString: u.toString(), ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined } }
}

/** Pool size per process (ROUTINI_DB_POOL_MAX, default 10). Keep it small on shared clusters. */
export function poolMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['ROUTINI_DB_POOL_MAX'])
  return Number.isInteger(n) && n > 0 ? n : 10
}

/** Opens a single unpooled client as the connecting user, for migrations. */
export async function withOwnerClient<T>(url: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = new pg.Client(pgConfig(url))
  await client.connect()
  try {
    return await fn({ query: async (sql, params) => (await client.query(sql, params as unknown[])).rows })
  } finally {
    await client.end()
  }
}

export function createPgDriver(url: string, opts: { max?: number } = {}): Driver {
  const pool = new pg.Pool({ ...pgConfig(url), max: opts.max ?? poolMax() })
  // node-postgres queues statements per client, so this runs before any query
  // issued on a freshly connected client.
  pool.on('connect', (client) => {
    client.query(`SET ROLE ${APP_ROLE}`).catch((err: Error) => {
      console.error('[db] failed to SET ROLE on new connection:', err.message)
    })
  })

  return {
    embedded: false,
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: async (sql, params) => (await client.query(sql, params as unknown[])).rows,
        })
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    async listen(channel: string, handler: NotifyHandler) {
      assertChannel(channel)
      // LISTEN needs a dedicated connection that is never returned to the pool.
      const client = new pg.Client(pgConfig(url))
      await client.connect()
      client.on('notification', (msg) => {
        if (msg.channel === channel) handler(msg.payload ?? '')
      })
      await client.query(`LISTEN ${channel}`)
      return async () => {
        await client.end().catch(() => {})
      }
    },
    async close() {
      await pool.end()
    },
  }
}

// ── PGlite (embedded) ────────────────────────────────────────────────────────

export async function openPglite(dataDir: string, snapshot?: Blob | File): Promise<PGlite> {
  if (dataDir !== ':memory:') return PGlite.create({ dataDir })
  return snapshot ? PGlite.create({ loadDataDir: snapshot }) : PGlite.create()
}

/** Creates a migrated in-memory database and dumps it, for fast cloning (tests). */
export async function createMigratedSnapshot(
  migrateFn: (owner: Queryable & { exec(sql: string): Promise<void> }) => Promise<unknown>,
): Promise<Blob | File> {
  const lite = await PGlite.create()
  await migrateFn({
    query: async (sql, params) => (await lite.query(sql, params as unknown[])).rows as never[],
    exec: async (sql) => {
      await lite.exec(sql)
    },
  })
  const dump = await lite.dumpDataDir('none')
  await lite.close()
  return dump
}

/** Wraps an already-migrated PGlite instance. Switches the session to the app role. */
export async function createPgliteDriver(lite: PGlite): Promise<Driver> {
  await lite.exec(`SET ROLE ${APP_ROLE}`)
  return {
    embedded: true,
    async transaction(fn) {
      return lite.transaction(async (tx) =>
        fn({ query: async (sql, params) => (await tx.query(sql, params as unknown[])).rows as never[] }),
      )
    },
    async listen(channel: string, handler: NotifyHandler) {
      assertChannel(channel)
      const unsubscribe = await lite.listen(channel, handler)
      return async () => {
        await unsubscribe()
      }
    },
    async close() {
      await lite.close()
    },
  }
}

/** Channel names are interpolated into LISTEN, so restrict them to identifiers. */
function assertChannel(channel: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) {
    throw new Error(`Invalid notification channel name: ${channel}`)
  }
}
