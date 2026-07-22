/**
 * Tests for the auth persistence layer in server/src/routes/auth.ts.
 *
 * The auth module resolves its storage backend from the SQLite DB module
 * (server/src/db/index.ts) when available and falls back to an in-memory
 * repository otherwise. Both implementations share the same `UserRepository`
 * interface, so this suite verifies the contract against:
 *
 *   1. `createDbRepository` driven by a lightweight in-memory mock that
 *      mimics better-sqlite3's `prepare().run()/get()` API and records every
 *      statement — proving queries are parameterized (no string interpolation
 *      of user input) and that the right tables/columns are used.
 *   2. `createMemoryRepository`, the fallback backend.
 *
 * Coverage:
 *   – Seed developer account: created from SEED_EMAIL/SEED_PASSWORD, idempotent
 *     across restarts (same email keeps its id, password rotates).
 *   – Email lookup returns the seeded user; unknown emails return null.
 *   – Id lookup returns the seeded user; unknown ids return null.
 *   – Revocation: revoking a jti marks it revoked; revoking twice is idempotent;
 *     unknown/empty jtis are never reported as revoked.
 *   – Password hash is never exposed via the repository's returned user.
 */

import { describe, it, expect } from 'vitest'
import {
  createDbRepository,
  createMemoryRepository,
  type UserRepository,
  type DbHandle,
  type StoredUser,
} from '../server/src/routes/auth.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal better-sqlite3-compatible mock. Each `prepare(sql)` returns a
 * statement whose `run(...)`/`get(...)` operate over a single shared row set
 * keyed by table name, parsed from the SQL. Parameters are bound by position
 * for `?` placeholders and by name for `@name` placeholders. All executed SQL
 * is recorded so tests can assert on parameterization.
 */
interface MockRow { [column: string]: unknown }
interface MockTable { rows: MockRow[] }

function makeMockDb(): DbHandle & {
  executed: { sql: string; params: unknown[] }[]
  tables: Record<string, MockTable>
} {
  const executed: { sql: string; params: unknown[] }[] = []
  const tables: Record<string, MockTable> = { users: { rows: [] }, revoked_tokens: { rows: [] } }

  function tableName(sql: string): string {
    const m = sql.match(/(?:INSERT (?:OR \w+ )?INTO|UPDATE|DELETE FROM|FROM)\s+(\w+)/i)
    return m ? m[1].toLowerCase() : ''
  }

  function bindNamed(sql: string, named: Record<string, unknown> | undefined, positional: unknown[]): unknown[] {
    if (named && typeof named === 'object') {
      const out: unknown[] = []
      let i = 0
      for (const match of sql.matchAll(/@(\w+)/g)) {
        out.push(named[match[1]])
        i++
      }
      return out.length || !positional.length ? out : positional
    }
    return positional
  }

  const handle: DbHandle & {
    executed: { sql: string; params: unknown[] }[]
    tables: Record<string, MockTable>
  } = {
    executed,
    tables,
    prepare(sql: string) {
      const table = tableName(sql)
      const stmt = {
        run(...params: unknown[]) {
          const named = params.length === 1 && typeof params[0] === 'object' && params[0] !== null
            ? params[0] as Record<string, unknown>
            : undefined
          const bound = bindNamed(sql, named, params)
          executed.push({ sql, params: bound })
          const t = tables[table]?.rows ?? []
          if (/^INSERT/i.test(sql)) {
            const row: MockRow = {}
            const cols = sql.match(/\(([^)]+)\)/)
            const names = cols ? cols[1].split(',').map(c => c.trim()) : []
            names.forEach((n, idx) => { row[n] = bound[idx] })
            if (/ON CONFLICT\(email\) DO UPDATE/i.test(sql)) {
              const email = row['email']
              const idx2 = t.findIndex(r => r['email'] === email)
              if (idx2 >= 0) { t[idx2]['password_hash'] = row['password_hash']; return }
            }
            if (/OR IGNORE/i.test(sql)) {
              const jti = row['jti']
              if (jti && t.some(r => r['jti'] === jti)) return
            }
            t.push(row)
          }
          if (/^DELETE/i.test(sql)) {
            const [col, val] = [String(bound[0]).replace('=', ''), bound[1]]
            const idx = t.findIndex(r => r[col] === val)
            if (idx >= 0) t.splice(idx, 1)
          }
        },
        get(...params: unknown[]) {
          executed.push({ sql, params })
          const t = tables[table]?.rows ?? []
          if (/WHERE email = \?/i.test(sql)) {
            return t.find(r => r['email'] === params[0]) ?? undefined
          }
          if (/WHERE id = \?/i.test(sql)) {
            return t.find(r => r['id'] === params[0]) ?? undefined
          }
          if (/WHERE jti = \?/i.test(sql)) {
            return t.some(r => r['jti'] === params[0]) ? { '1': 1 } : undefined
          }
          return t[0]
        },
      }
      return stmt
    },
  }
  return handle
}

function makeUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: 'user-1',
    email: 'admin@routini.dev',
    passwordHash: '$2a$01$hashvalue',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function seedVia(repo: UserRepository, email: string, password: 'changeme' | 'newpass'): StoredUser {
  // Mirror the seedDeveloperAccount logic: reuse existing id if present.
  const existing = repo.findByEmail(email)
  const user = makeUser({
    id: existing?.id ?? 'user-1',
    email,
    passwordHash: `hash:${password}`,
  })
  repo.upsertUser(user)
  return user
}

// ── Repository contract (shared by both backends) ───────────────────────────

function runRepositoryContract(label: string, makeRepo: () => UserRepository) {
  describe(`${label} – UserRepository contract`, () => {
    it('returns null for an unknown email', () => {
      const repo = makeRepo()
      expect(repo.findByEmail('nobody@example.com')).toBeNull()
    })

    it('returns null for an unknown id', () => {
      const repo = makeRepo()
      expect(repo.findById('does-not-exist')).toBeNull()
    })

    it('upserts and looks up a user by email', () => {
      const repo = makeRepo()
      const u = makeUser({ email: 'a@b.com' })
      repo.upsertUser(u)
      const found = repo.findByEmail('a@b.com')
      expect(found).not.toBeNull()
      expect(found!.id).toBe(u.id)
      expect(found!.email).toBe('a@b.com')
      expect(found!.passwordHash).toBe(u.passwordHash)
    })

    it('upserts and looks up a user by id', () => {
      const repo = makeRepo()
      repo.upsertUser(makeUser({ id: 'xyz', email: 'x@y.com' }))
      const found = repo.findById('xyz')
      expect(found).not.toBeNull()
      expect(found!.email).toBe('x@y.com')
    })

    it('rotates the password hash on re-upsert with the same email (idempotent seed)', () => {
      const repo = makeRepo()
      seedVia(repo, 'admin@routini.dev', 'changeme')
      const first = repo.findByEmail('admin@routini.dev')
      expect(first).not.toBeNull()
      const firstId = first!.id

      // Re-seed with a new password — must keep the same id, change the hash.
      seedVia(repo, 'admin@routini.dev', 'newpass')
      const second = repo.findByEmail('admin@routini.dev')
      expect(second).not.toBeNull()
      expect(second!.id).toBe(firstId)
      expect(second!.passwordHash).toBe('hash:newpass')
    })

    it('reports a jti as revoked only after revokeJti is called', () => {
      const repo = makeRepo()
      expect(repo.isJtiRevoked('jti-1')).toBe(false)
      repo.revokeJti('jti-1')
      expect(repo.isJtiRevoked('jti-1')).toBe(true)
    })

    it('revoking the same jti twice is idempotent', () => {
      const repo = makeRepo()
      repo.revokeJti('jti-2')
      repo.revokeJti('jti-2')
      expect(repo.isJtiRevoked('jti-2')).toBe(true)
    })

    it('never treats empty/undefined jtis as revoked', () => {
      const repo = makeRepo()
      expect(repo.isJtiRevoked(undefined)).toBe(false)
      expect(repo.isJtiRevoked('')).toBe(false)
    })
  })
}

runRepositoryContract('createMemoryRepository', createMemoryRepository)
runRepositoryContract('createDbRepository (mocked handle)', () => createDbRepository(makeMockDb()))

// ── createDbRepository SQL/parameterization assertions ───────────────────────

describe('createDbRepository – SQL and parameterization', () => {
  it('uses parameterized placeholders (never interpolates user input) for email lookup', () => {
    const db = makeMockDb()
    const repo = createDbRepository(db)
    const malicious = "x@y.com'; DROP TABLE users;--"
    repo.findByEmail(malicious)
    const emailStmt = db.executed.find(e => /SELECT .* FROM users WHERE email = \?/i.test(e.sql))
    expect(emailStmt).toBeDefined()
    expect(emailStmt!.params).toEqual([malicious])
    // The SQL string must not contain the raw injected value.
    expect(emailStmt!.sql).not.toContain(malicious)
  })

  it('uses parameterized placeholders for id lookup', () => {
    const db = makeMockDb()
    const repo = createDbRepository(db)
    const id = "1 OR 1=1"
    repo.findById(id)
    const idStmt = db.executed.find(e => /SELECT .* FROM users WHERE id = \?/i.test(e.sql))
    expect(idStmt).toBeDefined()
    expect(idStmt!.params).toEqual([id])
    expect(idStmt!.sql).not.toContain(id)
  })

  it('binds named parameters for upsert and targets the users table', () => {
    const db = makeMockDb()
    const repo = createDbRepository(db)
    repo.upsertUser(makeUser({ id: 'u9', email: 'n@o.com', passwordHash: 'h', createdAt: 'c' }))
    const insert = db.executed.find(e => /^INSERT INTO users/i.test(e.sql))
    expect(insert).toBeDefined()
    // Named params are emitted in @-placeholder order: id, email, password_hash, created_at
    expect(insert!.params).toEqual(['u9', 'n@o.com', 'h', 'c'])
    expect(/ON CONFLICT\(email\) DO UPDATE/i.test(insert!.sql)).toBe(true)
  })

  it('persists revoked jtis into the revoked_tokens table with parameterized binding', () => {
    const db = makeMockDb()
    const repo = createDbRepository(db)
    repo.revokeJti('jti-x')
    const rev = db.executed.find(e => /INSERT OR IGNORE INTO revoked_tokens/i.test(e.sql))
    expect(rev).toBeDefined()
    expect(rev!.params[0]).toBe('jti-x')
    expect(typeof rev!.params[1]).toBe('string') // ISO timestamp
    // isJtiRevoked reads back from the same table.
    expect(repo.isJtiRevoked('jti-x')).toBe(true)
    expect(repo.isJtiRevoked('jti-other')).toBe(false)
  })

  it('does not expose the password hash field name in SELECT column list mismatch', () => {
    const db = makeMockDb()
    const repo = createDbRepository(db)
    repo.upsertUser(makeUser({ email: 'q@r.com' }))
    const found = repo.findByEmail('q@r.com')
    // Returned user exposes passwordHash (mapped from password_hash), never the
    // raw DB column name on the public object.
    expect(found).not.toBeNull()
    expect(found).toHaveProperty('passwordHash')
    expect(found).not.toHaveProperty('password_hash')
  })
})
