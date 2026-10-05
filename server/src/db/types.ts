// ─────────────────────────────────────────────────────────────────────────────
// Database interface
//
// Routini talks to Postgres through this small interface so the same code runs
// on a real server (node-postgres pool) and on embedded Postgres (PGlite) for
// zero-config development, single-box self-hosting and hermetic tests.
//
// Tenancy: every tenant table has row-level security keyed on the
// transaction-local setting `app.org_id`. Code reaches tenant rows only
// through `db.org(orgId, fn)`, which sets that context. `db.system(fn)` is the
// explicit, cross-org path for the scheduler and worker. Anything else
// (`db.tx`, `db.query`) sees only global tables — a forgotten org filter
// returns no rows rather than another org's data.
// ─────────────────────────────────────────────────────────────────────────────

/** Anything that can run a parameterised statement and return rows. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export type NotifyHandler = (payload: string) => void

export interface Db {
  /** Single statement, no tenant context (global tables only). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Transaction with no tenant context (global tables only). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  /** Transaction scoped to one org: tenant rows of that org are visible and writable. */
  org<T>(orgId: string, fn: (q: Queryable) => Promise<T>): Promise<T>
  /** Transaction with cross-org access. Only the scheduler, worker and bootstrap use this. */
  system<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  /** Subscribe to a NOTIFY channel. Resolves to an unsubscribe function. */
  listen(channel: string, handler: NotifyHandler): Promise<() => Promise<void>>
  /** True for embedded Postgres, which cannot be shared between processes. */
  readonly embedded: boolean
  close(): Promise<void>
}

/** The low-level operations each driver provides; tenancy is layered on top in createDbFacade. */
export interface Driver {
  readonly embedded: boolean
  /** Run fn inside BEGIN/COMMIT on one connection (ROLLBACK on throw). */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  listen(channel: string, handler: NotifyHandler): Promise<() => Promise<void>>
  close(): Promise<void>
}
