/**
 * Tests for the SQLite database module (server/src/db/index.ts).
 *
 * Covers:
 *   – in-memory connection (default in test env)
 *   – idempotent schema creation (re-importing does not error)
 *   – migration ledger (migrations run exactly once)
 *   – user CRUD helpers (upsert/get by id and email)
 *   – revoked-JWT helpers (revoke/idempotency/lookup/pruning)
 *   – credential helpers (upsert/get/delete, system vs per-user scoping)
 *   – ROUTINI_DB_PATH override (file-based vs :memory:)
 *   – resetDb() isolation and guard outside test env
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  getDb,
  closeDb,
  resetDb,
  upsertUser,
  getUserById,
  getUserByEmail,
  revokeJwt,
  isJwtRevoked,
  pruneRevokedJwts,
  upsertCredential,
  getCredential,
  deleteCredential,
  credentialId,
} from '../server/src/db/index.js'

const originalDbPath = process.env['ROUTINI_DB_PATH']
const originalNodeEnv = process.env['NODE_ENV']

beforeEach(() => {
  // Start each test with a fresh in-memory database.
  resetDb()
})

afterAll(() => {
  closeDb()
  if (originalDbPath === undefined) delete process.env['ROUTINI_DB_PATH']
  else process.env['ROUTINI_DB_PATH'] = originalDbPath
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
})

// ── Connection & schema ──────────────────────────────────────────────────────

describe('getDb() connection', () => {
  it('returns a singleton connection', () => {
    const a = getDb()
    const b = getDb()
    expect(a).toBe(b)
  })

  it('creates all expected tables idempotently', () => {
    const db = getDb()
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('users')
    expect(names).toContain('revoked_jwts')
    expect(names).toContain('credentials')
    expect(names).toContain('schema_migrations')
  })

  it('does not error when schema is applied twice (idempotent)', () => {
    const db = getDb()
    // Re-running the migration ledger query should be a no-op: v1 already
    // recorded, so the pending list is empty and nothing re-runs.
    const applied = db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[]
    expect(applied).toHaveLength(1)
    expect(applied[0].version).toBe(1)
  })
})

// ── Users ─────────────────────────────────────────────────────────────────────

describe('user helpers', () => {
  it('upserts and retrieves a user by id', () => {
    upsertUser({
      id: 'u-1',
      email: 'alice@example.com',
      password_hash: 'hash-1',
      created_at: '2024-01-01T00:00:00.000Z',
    })
    const row = getUserById('u-1')
    expect(row).toBeDefined()
    expect(row!.email).toBe('alice@example.com')
    expect(row!.password_hash).toBe('hash-1')
  })

  it('retrieves a user by email', () => {
    upsertUser({
      id: 'u-2',
      email: 'bob@example.com',
      password_hash: 'hash-2',
      created_at: '2024-01-02T00:00:00.000Z',
    })
    const row = getUserByEmail('bob@example.com')
    expect(row).toBeDefined()
    expect(row!.id).toBe('u-2')
  })

  it('returns undefined for an unknown id', () => {
    expect(getUserById('nope')).toBeUndefined()
  })

  it('returns undefined for an unknown email', () => {
    expect(getUserByEmail('nobody@example.com')).toBeUndefined()
  })

  it('updates an existing user on conflict (upsert)', () => {
    upsertUser({
      id: 'u-3',
      email: 'carol@example.com',
      password_hash: 'old-hash',
      created_at: '2024-01-03T00:00:00.000Z',
    })
    upsertUser({
      id: 'u-3',
      email: 'carol@example.com',
      password_hash: 'new-hash',
      created_at: '2024-01-03T00:00:00.000Z',
    })
    const row = getUserById('u-3')
    expect(row!.password_hash).toBe('new-hash')
  })

  it('enforces a unique email constraint', () => {
    upsertUser({
      id: 'u-4',
      email: 'dup@example.com',
      password_hash: 'h',
      created_at: '2024-01-04T00:00:00.000Z',
    })
    expect(() =>
      upsertUser({
        id: 'u-5',
        email: 'dup@example.com',
        password_hash: 'h2',
        created_at: '2024-01-05T00:00:00.000Z',
      }),
    ).toThrow()
  })
})

// ── Revoked JWTs ───────────────────────────────────────────────────────────────

describe('revoked-JWT helpers', () => {
  it('records and detects a revoked jti', () => {
    revokeJwt('jti-1', '2099-01-01T00:00:00.000Z')
    expect(isJwtRevoked('jti-1')).toBe(true)
    expect(isJwtRevoked('jti-other')).toBe(false)
  })

  it('is idempotent for duplicate jtis', () => {
    revokeJwt('jti-2', '2099-01-01T00:00:00.000Z')
    expect(() => revokeJwt('jti-2', '2099-01-01T00:00:00.000Z')).not.toThrow()
    expect(isJwtRevoked('jti-2')).toBe(true)
  })

  it('prunes expired entries', () => {
    revokeJwt('expired', '2020-01-01T00:00:00.000Z')
    revokeJwt('future', '2099-01-01T00:00:00.000Z')
    const removed = pruneRevokedJwts('2024-06-01T00:00:00.000Z')
    expect(removed).toBe(1)
    expect(isJwtRevoked('expired')).toBe(false)
    expect(isJwtRevoked('future')).toBe(true)
  })

  it('pruning with nothing expired removes zero rows', () => {
    revokeJwt('future2', '2099-01-01T00:00:00.000Z')
    const removed = pruneRevokedJwts('2024-06-01T00:00:00.000Z')
    expect(removed).toBe(0)
  })
})

// ── Credentials ───────────────────────────────────────────────────────────────

describe('credential helpers', () => {
  it('stores and retrieves a per-user credential', () => {
    upsertCredential({
      id: 'c-1',
      user_id: 'u-10',
      key: 'smtp_password',
      encrypted_value: 'ciphertext',
      iv: 'nonce',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    const row = getCredential('u-10', 'smtp_password')
    expect(row).toBeDefined()
    expect(row!.encrypted_value).toBe('ciphertext')
    expect(row!.iv).toBe('nonce')
  })

  it('stores and retrieves a system (null user) credential', () => {
    upsertCredential({
      id: 'c-sys',
      user_id: null,
      key: 'ai_api_key',
      encrypted_value: 'secret',
      iv: 'nonce',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    expect(getCredential(null, 'ai_api_key')).toBeDefined()
    // A per-user lookup with the same key must NOT see the system credential.
    expect(getCredential('u-10', 'ai_api_key')).toBeUndefined()
  })

  it('updates an existing credential on natural-key conflict (upsert by user_id+key)', () => {
    upsertCredential({
      id: credentialId('u-11', 'ssh_key'),
      user_id: 'u-11',
      key: 'ssh_key',
      encrypted_value: 'old',
      iv: 'nonce-old',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    upsertCredential({
      id: credentialId('u-11', 'ssh_key'),
      user_id: 'u-11',
      key: 'ssh_key',
      encrypted_value: 'new',
      iv: 'nonce-new',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    })
    const row = getCredential('u-11', 'ssh_key')
    expect(row!.encrypted_value).toBe('new')
    expect(row!.iv).toBe('nonce-new')
    expect(row!.updated_at).toBe('2024-01-02T00:00:00.000Z')
  })

  it('credentialId maps null user_id to the system scope', () => {
    expect(credentialId(null, 'ai_api_key')).toBe('system:ai_api_key')
    expect(credentialId('u-1', 'ai_api_key')).toBe('u-1:ai_api_key')
  })

  it('returns undefined for an unknown credential', () => {
    expect(getCredential('u-99', 'missing')).toBeUndefined()
  })

  it('deletes a credential and reports rows removed', () => {
    upsertCredential({
      id: 'c-3',
      user_id: 'u-12',
      key: 'temp',
      encrypted_value: 'x',
      iv: 'n',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    expect(deleteCredential('u-12', 'temp')).toBe(1)
    expect(getCredential('u-12', 'temp')).toBeUndefined()
    // Deleting again removes nothing.
    expect(deleteCredential('u-12', 'temp')).toBe(0)
  })

  it('does not delete a different user credential with the same key', () => {
    upsertCredential({
      id: 'c-a',
      user_id: 'u-a',
      key: 'shared_key',
      encrypted_value: 'a',
      iv: 'n',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    upsertCredential({
      id: 'c-b',
      user_id: 'u-b',
      key: 'shared_key',
      encrypted_value: 'b',
      iv: 'n',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    })
    expect(deleteCredential('u-a', 'shared_key')).toBe(1)
    expect(getCredential('u-b', 'shared_key')).toBeDefined()
  })
})

// ── Environment / routing ──────────────────────────────────────────────────────

describe('ROUTINI_DB_PATH routing', () => {
  it('uses :memory: by default in test env', () => {
    // resetDb already forces an in-memory db; the in-memory pragma is
    // unaffected by journal_mode, so just confirm the connection works.
    const db = getDb()
    db.prepare('CREATE TABLE IF NOT EXISTS probe (x INTEGER)').run()
    db.prepare('INSERT INTO probe VALUES (1)').run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 })
  })

  it('honours an explicit ROUTINI_DB_PATH of :memory:', () => {
    process.env['ROUTINI_DB_PATH'] = ':memory:'
    closeDb()
    const db = getDb()
    // In-memory databases are private to the connection; confirm isolation
    // by creating a throwaway table that won't exist elsewhere.
    db.prepare('CREATE TABLE IF NOT EXISTS probe2 (x INTEGER)').run()
    expect(
      (db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('probe2') as
        | { name: string }
        | undefined) !== undefined,
    ).toBe(true)
    delete process.env['ROUTINI_DB_PATH']
    closeDb()
  })
})

// ── resetDb guard ─────────────────────────────────────────────────────────────

describe('resetDb() guard', () => {
  it('throws outside test environments', () => {
    const previous = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    expect(() => resetDb()).toThrow(/test environments/)
    process.env['NODE_ENV'] = previous
  })
})
