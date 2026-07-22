/**
 * HTTP-level tests for the credentials API router
 * (server/src/routes/credentials.ts), exercised through the assembled Express
 * app with supertest.
 *
 * The router is mounted at /api/credentials and enforces authentication on
 * every endpoint; state-changing routes additionally run requireCsrf, which is
 * a no-op for Bearer-authenticated requests (CSRF only applies to cookie auth).
 * These tests authenticate with a Bearer token from the seeded developer
 * account.
 *
 * Coverage:
 *   – Authentication is required (401 without a token).
 *   – PUT creates/replaces a credential and returns metadata only — the secret
 *     value is never echoed back.
 *   – GET (single + list) returns metadata only and reconstructs type/name.
 *   – The optional ?type= list filter is honoured.
 *   – DELETE is idempotent and reports the resulting state.
 *   – Input validation returns 400 for bad type, name, and value (edge cases
 *     and error paths, not just the happy path).
 *
 * The credentials service persists into the in-memory SQLite database; each
 * test starts from a fresh DB via resetDb() so credentials never leak between
 * cases.  The auth layer uses its in-memory repository, so resetting the DB
 * does not disturb the seeded login account.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb } from '../server/src/db/index.js'

const request = supertest(app)

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

beforeEach(() => {
  // Fresh credential store for each test (auth uses its own in-memory repo, so
  // this does not affect the logged-in session).
  process.env['NODE_ENV'] = 'test'
  resetDb()
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects unauthenticated list requests with 401', async () => {
    const res = await request.get('/api/credentials')
    expect(res.status).toBe(401)
  })

  it('rejects unauthenticated writes with 401', async () => {
    const res = await request.put('/api/credentials/ssh/prod').send({ value: 'x' })
    expect(res.status).toBe(401)
  })
})

// ── PUT (create/replace) ──────────────────────────────────────────────────────

describe('PUT /api/credentials/:type/:name', () => {
  it('creates a credential and returns metadata without the secret', async () => {
    const res = await request
      .put('/api/credentials/smtp/mailer')
      .set(auth())
      .send({ value: 'super-secret-password' })

    expect(res.status).toBe(201)
    expect(res.body.type).toBe('smtp')
    expect(res.body.name).toBe('mailer')
    expect(typeof res.body.id).toBe('string')
    expect(typeof res.body.createdAt).toBe('string')
    // The secret must never be echoed back anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain('super-secret-password')
    expect(res.body.value).toBeUndefined()
  })

  it('replaces an existing credential in place (same id)', async () => {
    const first = await request
      .put('/api/credentials/apikey/openai')
      .set(auth())
      .send({ value: 'sk-first' })
    const second = await request
      .put('/api/credentials/apikey/openai')
      .set(auth())
      .send({ value: 'sk-second' })

    expect(second.status).toBe(201)
    expect(second.body.id).toBe(first.body.id)
  })

  it('rejects an invalid credential type with 400', async () => {
    const res = await request
      .put('/api/credentials/telnet/host')
      .set(auth())
      .send({ value: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid credential type/)
  })

  it('rejects a missing value with 400', async () => {
    const res = await request.put('/api/credentials/ssh/host').set(auth()).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/value must be a non-empty string/)
  })

  it('rejects a name containing the key separator with 400', async () => {
    const res = await request
      .put('/api/credentials/ssh/bad:name')
      .set(auth())
      .send({ value: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/':' character/)
  })
})

// ── GET (single) ──────────────────────────────────────────────────────────────

describe('GET /api/credentials/:type/:name', () => {
  it('returns metadata for an existing credential', async () => {
    await request
      .put('/api/credentials/imap/inbox')
      .set(auth())
      .send({ value: 'imap-pass' })

    const res = await request.get('/api/credentials/imap/inbox').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.type).toBe('imap')
    expect(res.body.name).toBe('inbox')
    expect(JSON.stringify(res.body)).not.toContain('imap-pass')
  })

  it('returns 404 for a credential that does not exist', async () => {
    const res = await request.get('/api/credentials/ssh/missing').set(auth())
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid type', async () => {
    const res = await request.get('/api/credentials/bogus/x').set(auth())
    expect(res.status).toBe(400)
  })
})

// ── GET (list) ────────────────────────────────────────────────────────────────

describe('GET /api/credentials', () => {
  beforeEach(async () => {
    await request.put('/api/credentials/ssh/a').set(auth()).send({ value: 'v1' })
    await request.put('/api/credentials/ssh/b').set(auth()).send({ value: 'v2' })
    await request.put('/api/credentials/smtp/c').set(auth()).send({ value: 'v3' })
  })

  it('lists all credentials as metadata only', async () => {
    const res = await request.get('/api/credentials').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(3)
    expect(res.body.credentials).toHaveLength(3)
    // No secret material anywhere in the payload.
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('v1')
    expect(serialized).not.toContain('v2')
    expect(serialized).not.toContain('v3')
  })

  it('filters the list by ?type=', async () => {
    const res = await request.get('/api/credentials?type=ssh').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.credentials.every((c: { type: string }) => c.type === 'ssh')).toBe(true)
  })

  it('rejects an invalid ?type= filter with 400', async () => {
    const res = await request.get('/api/credentials?type=nope').set(auth())
    expect(res.status).toBe(400)
  })
})

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/credentials/:type/:name', () => {
  it('deletes an existing credential and reports deleted=true', async () => {
    await request.put('/api/credentials/apikey/temp').set(auth()).send({ value: 'x' })

    const res = await request.delete('/api/credentials/apikey/temp').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)

    // A subsequent fetch must 404.
    const after = await request.get('/api/credentials/apikey/temp').set(auth())
    expect(after.status).toBe(404)
  })

  it('is idempotent: deleting a missing credential reports deleted=false', async () => {
    const res = await request.delete('/api/credentials/apikey/nope').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(false)
  })

  it('rejects an invalid type with 400', async () => {
    const res = await request.delete('/api/credentials/bad/x').set(auth())
    expect(res.status).toBe(400)
  })
})
