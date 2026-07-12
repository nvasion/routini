import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'

const request = supertest(app)

// ── POST /api/auth/login ─────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns a token and safe user for valid credentials', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.token.length).toBeGreaterThan(0)
    expect(res.body.user.email).toBe('admin@routini.dev')
    expect(typeof res.body.user.id).toBe('string')
    // password hash must never be exposed
    expect(res.body.user.passwordHash).toBeUndefined()
  })

  it('returns 401 for wrong password', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'wrongpassword' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 for unknown email', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'changeme' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 when email is missing', async () => {
    const res = await request.post('/api/auth/login').send({ password: 'changeme' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 when password is missing', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for an invalid email format', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'notanemail', password: 'changeme' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })
})

// ── POST /api/auth/logout ────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('logs out with a valid token and returns a message', async () => {
    const login = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const token = login.body.token as string

    const res = await request
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(typeof res.body.message).toBe('string')
  })

  it('succeeds gracefully without a token (idempotent)', async () => {
    const res = await request.post('/api/auth/logout')
    expect(res.status).toBe(200)
  })

  it('invalidates the token – /me returns 401 after logout', async () => {
    const login = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const token = login.body.token as string

    await request
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)

    const me = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(me.status).toBe(401)
  })
})

// ── GET /api/auth/me ─────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns the authenticated user for a valid token', async () => {
    const login = await request
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const token = login.body.token as string

    const res = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.email).toBe('admin@routini.dev')
    // No sensitive fields
    expect(res.body.passwordHash).toBeUndefined()
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/api/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 for an invalid token', async () => {
    const res = await request
      .get('/api/auth/me')
      .set('Authorization', 'Bearer thisisnotavalidtoken')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })
})
