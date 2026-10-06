// Signup policies, login, sessions (Bearer + cookie/CSRF), logout revocation, seeding.

import { describe, it, expect, afterEach } from 'vitest'
import supertest from 'supertest'
import { makeTestApp, type TestApp } from './helpers/testApp'
import { seedFirstAccount } from '../server/src/bootstrap'

let t: TestApp
afterEach(async () => {
  await t?.close()
})

describe('signup', () => {
  it('creates a user, an owned org, and a session', async () => {
    t = await makeTestApp()
    const res = await t.request.post('/api/auth/signup').send({ email: 'Ada@Example.com', password: 'password123', orgName: 'Analytical Engines' })
    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({ email: 'Ada@Example.com' })
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(res.body.orgs).toEqual([expect.objectContaining({ slug: 'analytical-engines', role: 'owner' })])
    expect(res.headers['set-cookie']?.[0]).toMatch(/routini_token=.*HttpOnly.*SameSite=Strict/i)
  })

  it('rejects a duplicate email case-insensitively', async () => {
    t = await makeTestApp()
    await t.signup('dup@example.com')
    const res = await t.request.post('/api/auth/signup').send({ email: 'DUP@example.com', password: 'password123' })
    expect(res.status).toBe(409)
  })

  it('validates email and password length', async () => {
    t = await makeTestApp()
    expect((await t.request.post('/api/auth/signup').send({ email: 'nope', password: 'password123' })).status).toBe(400)
    expect((await t.request.post('/api/auth/signup').send({ email: 'a@b.co', password: 'short' })).status).toBe(400)
    expect((await t.request.post('/api/auth/signup').send({})).status).toBe(400)
  })

  it('first-user-only allows exactly one signup', async () => {
    t = await makeTestApp({ config: { signup: 'first-user-only' } })
    const results = await Promise.all(
      ['one@example.com', 'two@example.com', 'three@example.com'].map((email) =>
        t.request.post('/api/auth/signup').send({ email, password: 'password123' }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403])
  })

  it('closed refuses every signup', async () => {
    t = await makeTestApp({ config: { signup: 'closed' } })
    expect((await t.request.post('/api/auth/signup').send({ email: 'a@example.com', password: 'password123' })).status).toBe(403)
  })

  it('suffixes the org slug when it is taken', async () => {
    t = await makeTestApp()
    const a = await t.signup('sam@one.com')
    const b = await t.signup('sam@two.com')
    expect(a.orgSlug).toBe('sam')
    expect(b.orgSlug).toBe('sam-2')
  })
})

describe('login and sessions', () => {
  it('logs in with the right password only, with the same error for unknown emails', async () => {
    t = await makeTestApp()
    await t.signup('lin@example.com')
    const ok = await t.request.post('/api/auth/login').send({ email: 'LIN@example.com', password: 'password123' })
    expect(ok.status).toBe(200)
    expect(ok.body.orgs).toHaveLength(1)
    const bad = await t.request.post('/api/auth/login').send({ email: 'lin@example.com', password: 'wrong-password' })
    const unknown = await t.request.post('/api/auth/login').send({ email: 'ghost@example.com', password: 'password123' })
    expect(bad.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(bad.body).toEqual(unknown.body)
  })

  it('GET /me requires a session and returns memberships', async () => {
    t = await makeTestApp()
    const u = await t.signup('me@example.com')
    expect((await t.request.get('/api/auth/me')).status).toBe(401)
    const me = await u.get('/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe('me@example.com')
    expect(me.body.orgs[0].role).toBe('owner')
  })

  it('logout revokes the token for good', async () => {
    t = await makeTestApp()
    const u = await t.signup('out@example.com')
    expect((await u.get('/api/auth/me')).status).toBe(200)
    expect((await u.post('/api/auth/logout')).status).toBe(200)
    expect((await u.get('/api/auth/me')).status).toBe(401)
  })

  it('rejects tampered and garbage tokens', async () => {
    t = await makeTestApp()
    const u = await t.signup('tamper@example.com')
    const parts = u.token.split('.')
    const forged = [parts[0], Buffer.from(JSON.stringify({ sub: u.userId, jti: 'x', csrf: 'y' })).toString('base64url'), parts[2]].join('.')
    const r = supertest(t.app)
    expect((await r.get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401)
    expect((await r.get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401)
  })
})

describe('cookie sessions and CSRF', () => {
  it('requires the CSRF header on mutations when authenticated by cookie', async () => {
    t = await makeTestApp()
    const agent = t.request // supertest agent keeps cookies
    const signup = await agent.post('/api/auth/signup').send({ email: 'cookie@example.com', password: 'password123' })
    const slug = signup.body.orgs[0].slug
    expect((await agent.get(`/api/orgs/${slug}`)).status).toBe(200)
    const without = await agent.put(`/api/orgs/${slug}`).send({ name: 'Renamed' })
    expect(without.status).toBe(403)
    const wrong = await agent.put(`/api/orgs/${slug}`).set('X-CSRF-Token', 'nope').send({ name: 'Renamed' })
    expect(wrong.status).toBe(403)
    const ok = await agent.put(`/api/orgs/${slug}`).set('X-CSRF-Token', signup.body.csrfToken).send({ name: 'Renamed' })
    expect(ok.status).toBe(200)
    expect(ok.body.org.name).toBe('Renamed')
  })
})

describe('seeding', () => {
  it('creates the seed account on an empty database only', async () => {
    t = await makeTestApp({ config: { seed: { email: 'seed@example.com', password: 'seed-password' } } })
    expect(await seedFirstAccount(t.ctx)).toBe(true)
    expect(await seedFirstAccount(t.ctx)).toBe(false)
    const login = await t.request.post('/api/auth/login').send({ email: 'seed@example.com', password: 'seed-password' })
    expect(login.status).toBe(200)
    expect(login.body.orgs[0].slug).toBe('default')
  })

  it('does nothing when users already exist', async () => {
    t = await makeTestApp({ config: { seed: { email: 'seed@example.com', password: 'seed-password' } } })
    await t.signup('first@example.com')
    expect(await seedFirstAccount(t.ctx)).toBe(false)
  })
})
