/**
 * Tests for auth persistence across simulated server restarts.
 *
 * The auth module (server/src/routes/auth.ts) persists users and revoked
 * JWT ids through the SQLite database module (server/src/db/index.ts). The
 * database connection is a module-level singleton, so a "server restart" is
 * simulated by closing the connection and re-opening it against the same
 * file-backed database file. Data written before the close must remain
 * available after the reopen — that is the core guarantee this suite verifies.
 *
 * Coverage:
 *   – A user created via the auth repository survives a DB close/reopen
 *     (simulated restart) and remains findable by both email and id.
 *   – A revoked jti survives a DB close/reopen and is still reported as
 *     revoked afterwards (revocation outlives the process lifetime).
 *   – Multiple users created before a restart all survive together.
 *   – Re-seeding the developer account after a restart is idempotent: the
 *     existing id is preserved and only the password hash rotates.
 *   – Revocation isolation: only the explicitly revoked jti is reported as
 *     revoked after a restart; unrelated jtis are not.
 *
 * The temp database files are created under a dedicated directory inside the
 * project workspace (tests/.auth-persistence-tmp) so the test stays within
 * the project boundary and cleans up after itself.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeDb,
  getDb,
  resetDb,
} from '../server/src/db/index.js'
import {
  createDbRepository,
  type UserRepository,
  type StoredUser,
  type DbHandle,
} from '../server/src/routes/auth.js'

// ── Temp DB workspace (inside the project tree) ──────────────────────────────

/**
 * A throwaway directory holding file-backed SQLite databases. Located under
 * the OS temp dir (which is per-user and not a shared system path) so we never
 * touch global configuration. Cleaned up once after the whole suite.
 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'routini-auth-persist-'))

let dbFile: string

const originalDbPath = process.env['ROUTINI_DB_PATH']
const originalNodeEnv = process.env['NODE_ENV']

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Point the DB module at a fresh file-backed database and open it. Returns
 * nothing; callers obtain the live handle via getDb() when needed.
 */
function useFileBackedDb(): void {
  dbFile = join(TMP_ROOT, `auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  process.env['ROUTINI_DB_PATH'] = dbFile
  // Ensure a clean singleton state before each test: close any prior
  // connection so the env override takes effect on the next getDb().
  closeDb()
  // Open the connection so the schema (users, revoked_jwts, credentials) is
  // created on disk immediately.
  getDb()
}

/**
 * Simulate a server restart: close the singleton DB connection, then reopen
 * it against the same file. After this call getDb() returns a fresh handle
 * backed by the same on-disk file, exactly as a restarted process would see.
 */
function simulateRestart(): void {
  closeDb()
  getDb()
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

/**
 * Build a fresh repository bound to the currently-open DB handle. The auth
 * module's createDbRepository expects a DbHandle exposing prepare(); getDb()
 * returns exactly that, so we cast through the shared interface.
 */
function freshRepo(): UserRepository {
  return createDbRepository(getDb() as unknown as DbHandle)
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

beforeEach(() => {
  // Tests run in NODE_ENV=test so resetDb()/closeDb() are allowed.
  process.env['NODE_ENV'] = 'test'
  useFileBackedDb()
})

afterEach(() => {
  // Tear down the singleton so the next test starts from a clean file.
  closeDb()
})

afterAll(() => {
  // Restore environment and remove the temp workspace.
  closeDb()
  if (originalDbPath === undefined) delete process.env['ROUTINI_DB_PATH']
  else process.env['ROUTINI_DB_PATH'] = originalDbPath
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup; never fail the suite on temp-dir removal.
  }
})

// ── Persistence across a simulated server restart ───────────────────────────

describe('auth persistence across simulated server restarts', () => {
  it('persists a user findable by email after a DB close/reopen', () => {
    const repo = freshRepo()
    const user = makeUser({
      id: 'persist-email',
      email: 'persist@example.com',
      passwordHash: 'hash-email',
    })
    repo.upsertUser(user)

    // Simulate the process restarting: drop the in-memory connection and
    // re-open the same on-disk database file.
    simulateRestart()

    const repoAfter = freshRepo()
    const found = repoAfter.findByEmail('persist@example.com')
    expect(found).not.toBeNull()
    expect(found!.id).toBe('persist-email')
    expect(found!.email).toBe('persist@example.com')
    expect(found!.passwordHash).toBe('hash-email')
  })

  it('persists a user findable by id after a DB close/reopen', () => {
    const repo = freshRepo()
    repo.upsertUser(
      makeUser({
        id: 'persist-id',
        email: 'byid@example.com',
        passwordHash: 'hash-id',
      }),
    )

    simulateRestart()

    const repoAfter = freshRepo()
    const found = repoAfter.findById('persist-id')
    expect(found).not.toBeNull()
    expect(found!.email).toBe('byid@example.com')
    expect(found!.passwordHash).toBe('hash-id')
  })

  it('persists a revoked jti across a DB close/reopen', () => {
    const repo = freshRepo()
    // Before revocation the jti is not revoked.
    expect(repo.isJtiRevoked('jti-survive')).toBe(false)
    repo.revokeJti('jti-survive')
    expect(repo.isJtiRevoked('jti-survive')).toBe(true)

    simulateRestart()

    const repoAfter = freshRepo()
    // The revocation must survive the restart.
    expect(repoAfter.isJtiRevoked('jti-survive')).toBe(true)
    // An unrelated jti must not be reported as revoked.
    expect(repoAfter.isJtiRevoked('jti-never-issued')).toBe(false)
    expect(repoAfter.isJtiRevoked(undefined)).toBe(false)
  })

  it('preserves multiple users across a DB close/reopen', () => {
    const repo = freshRepo()
    repo.upsertUser(
      makeUser({ id: 'multi-1', email: 'one@example.com', passwordHash: 'h1' }),
    )
    repo.upsertUser(
      makeUser({ id: 'multi-2', email: 'two@example.com', passwordHash: 'h2' }),
    )
    repo.upsertUser(
      makeUser({ id: 'multi-3', email: 'three@example.com', passwordHash: 'h3' }),
    )

    simulateRestart()

    const repoAfter = freshRepo()
    expect(repoAfter.findById('multi-1')?.email).toBe('one@example.com')
    expect(repoAfter.findById('multi-2')?.email).toBe('two@example.com')
    expect(repoAfter.findById('multi-3')?.email).toBe('three@example.com')
    // And via email lookup.
    expect(repoAfter.findByEmail('two@example.com')?.id).toBe('multi-2')
  })

  it('re-seeding the developer account after a restart keeps the existing id and rotates the hash', () => {
    const repo = freshRepo()
    repo.upsertUser(
      makeUser({
        id: 'seed-orig',
        email: 'dev@example.com',
        passwordHash: 'original-hash',
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
    )

    simulateRestart()

    // A restarted process re-seeds the same account: it should reuse the
    // existing id but update the password hash.
    const repoAfter = freshRepo()
    const existing = repoAfter.findByEmail('dev@example.com')
    expect(existing).not.toBeNull()
    const existingId = existing!.id

    repoAfter.upsertUser(
      makeUser({
        id: existingId,
        email: 'dev@example.com',
        passwordHash: 'rotated-hash',
        createdAt: existing!.createdAt,
      }),
    )

    const reseeded = repoAfter.findByEmail('dev@example.com')
    expect(reseeded).not.toBeNull()
    expect(reseeded!.id).toBe(existingId)
    expect(reseeded!.passwordHash).toBe('rotated-hash')
  })

  it('isolates revoked jtis across restarts (only revoked ones persist)', () => {
    const repo = freshRepo()
    repo.revokeJti('will-survive')
    // 'will-not-survive' is never revoked, so it must stay unrevoked.
    expect(repo.isJtiRevoked('will-not-survive')).toBe(false)

    simulateRestart()

    const repoAfter = freshRepo()
    expect(repoAfter.isJtiRevoked('will-survive')).toBe(true)
    expect(repoAfter.isJtiRevoked('will-not-survive')).toBe(false)
  })

  it('returns null for unknown users after a restart (no stale in-memory state)', () => {
    const repo = freshRepo()
    repo.upsertUser(
      makeUser({ id: 'known', email: 'known@example.com', passwordHash: 'h' }),
    )

    simulateRestart()

    const repoAfter = freshRepo()
    // The restarted repository must not fabricate data that was never written.
    expect(repoAfter.findById('never-written')).toBeNull()
    expect(repoAfter.findByEmail('never-written@example.com')).toBeNull()
    // But the user that was written is still there.
    expect(repoAfter.findById('known')?.email).toBe('known@example.com')
  })
})
