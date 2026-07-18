/**
 * Cookie-based auth integration tests — server smoke suite.
 *
 * Covers:
 *   – Email-based login (admin@routini.dev / changeme seed credentials)
 *   – HTTP-only cookie attributes (HttpOnly, SameSite=Strict)
 *   – CSRF protection on state-changing endpoints (Double-Submit Cookie pattern)
 *   – Protected route enforcement (401 without auth)
 *   – Logout cookie clearing and session invalidation
 *
 * The broader test suites in /workspace/tests/auth.test.ts and
 * /workspace/tests/csrf.test.ts cover additional scenarios including Bearer
 * token auth and exhaustive CSRF cases for every endpoint.
 *
 * Default seed credentials: admin@routini.dev / changeme
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { app } from '../src/index.js'

// ── Helper ────────────────────────────────────────────────────────────────────

/** Log in via cookie and return the session cookie array and CSRF token. */
async function loginAsAdmin(): Promise<{ cookies: string[]; csrfToken: string }> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
    .expect(200)

  const cookies = res.headers['set-cookie'] as unknown as string[]
  const csrfToken = res.body.csrfToken as string
  return { cookies, csrfToken }
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns 200, safe user object, and csrfToken for valid email credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
      .expect(200)

    // User object: id is a UUID string, email matches login email
    expect(res.body.user).toMatchObject({ email: 'admin@routini.dev' })
    expect(typeof res.body.user.id).toBe('string')
    // passwordHash must never appear in any response
    expect(res.body.user).not.toHaveProperty('passwordHash')
    // CSRF token: 32 random bytes encoded as 64 lowercase hex chars
    expect(typeof res.body.csrfToken).toBe('string')
    expect(res.body.csrfToken).toHaveLength(64)
    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/)
    // Raw JWT for Bearer / programmatic clients
    expect(typeof res.body.token).toBe('string')
  })

  it('sets an HttpOnly, SameSite=Strict cookie on successful login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
      .expect(200)

    const cookies: string[] = res.headers['set-cookie'] as unknown as string[]
    expect(cookies).toBeDefined()
    const tokenCookie = cookies.find((c: string) => c.startsWith('routini_token='))
    expect(tokenCookie).toBeDefined()
    expect(tokenCookie).toMatch(/HttpOnly/i)
    expect(tokenCookie).toMatch(/SameSite=Strict/i)
    expect(tokenCookie).toMatch(/Max-Age=\d+/)
  })

  it('returns 401 with an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'changeme' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('returns 401 with a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'wrong' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'changeme' })
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev' })
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('returns 400 when body is empty', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({})
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('returns 400 for a malformed email (no @ sign)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'notanemail', password: 'changeme' })
      .expect(400)

    expect(res.body.error).toMatch(/email/i)
  })
})

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .expect(401)

    expect(res.body.error).toMatch(/authentication required/i)
  })

  it('returns the safe user object when authenticated via cookie', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.email).toBe('admin@routini.dev')
    expect(typeof res.body.id).toBe('string')
    expect(res.body).not.toHaveProperty('passwordHash')
  })

  it('returns 401 with a tampered token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', ['routini_token=invalid.token.here; Path=/; HttpOnly'])
      .expect(401)

    expect(res.body.error).toBeDefined()
  })
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the auth cookie', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.message).toMatch(/logged out/i)

    // The Set-Cookie header clears the cookie with Max-Age=0
    const setCookies: string[] = res.headers['set-cookie'] as unknown as string[]
    const cleared = setCookies?.find((c: string) => c.startsWith('routini_token='))
    expect(cleared).toBeDefined()
    expect(cleared).toMatch(/Max-Age=0|Expires=.*1970/i)
  })

  it('returns 200 even when called without a session (idempotent)', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .expect(200)

    expect(res.body.message).toMatch(/logged out/i)
  })

  it('rejects requests after logout (cookie cleared)', async () => {
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'admin@routini.dev', password: 'changeme' })
    await agent.post('/api/auth/logout')

    const res = await agent.get('/api/auth/me')
    expect(res.status).toBe(401)
  })
})

// ── CSRF protection on state-changing routes ──────────────────────────────────

describe('CSRF protection (Double-Submit Cookie pattern)', () => {
  it('POST /api/tasks returns 403 without X-CSRF-Token header', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .send({ name: 'CSRF test', type: 'routine' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/tasks returns 403 with a wrong CSRF token', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'completely-wrong-token')
      .send({ name: 'CSRF test', type: 'routine' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/tasks returns 403 with an empty CSRF token', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', '')
      .send({ name: 'CSRF test', type: 'routine' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/tasks succeeds with the correct CSRF token', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'CSRF-protected task', type: 'routine' })
      .expect(201)

    expect(res.body.name).toBe('CSRF-protected task')
  })

  it('DELETE /api/tasks/:id returns 403 without X-CSRF-Token header', async () => {
    // Create a task with Bearer token first (no CSRF required for Bearer)
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Target for CSRF delete test', type: 'routine' })
      .expect(201)
    const taskId: string = created.body.id

    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('DELETE /api/tasks/:id succeeds with the correct CSRF token', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Target for CSRF delete success', type: 'routine' })
      .expect(201)
    const taskId: string = created.body.id

    const { cookies, csrfToken } = await loginAsAdmin()

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .expect(200)

    expect(res.body.id).toBe(taskId)
  })

  it('GET /api/tasks succeeds without X-CSRF-Token (GET is CSRF-safe)', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .get('/api/tasks')
      .set('Cookie', cookies)
      // no X-CSRF-Token header needed for GET
      .expect(200)

    expect(Array.isArray(res.body.tasks)).toBe(true)
  })
})

// ── Protected routes require auth ─────────────────────────────────────────────

describe('Protected task routes – require authentication', () => {
  it('GET /api/tasks returns 401 without auth', async () => {
    await request(app).get('/api/tasks').expect(401)
  })

  it('POST /api/tasks returns 401 without auth', async () => {
    await request(app)
      .post('/api/tasks')
      .send({ name: 'Test', type: 'routine' })
      .expect(401)
  })

  it('DELETE /api/tasks/:id returns 401 without auth', async () => {
    await request(app).delete('/api/tasks/some-id').expect(401)
  })

  it('GET /api/tasks returns items when authenticated with cookie', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .get('/api/tasks')
      .set('Cookie', cookies)
      .expect(200)

    expect(Array.isArray(res.body.tasks)).toBe(true)
    expect(typeof res.body.count).toBe('number')
  })

  it('POST /api/tasks creates a task when authenticated with Bearer token', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Auth Test Task', type: 'routine' })
      .expect(201)

    expect(res.body).toMatchObject({ name: 'Auth Test Task', type: 'routine' })
    expect(typeof res.body.id).toBe('string')
  })
})

// ── Public routes remain accessible ──────────────────────────────────────────

describe('Public routes – no auth required', () => {
  it('GET /health is accessible without auth', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
  })

  it('POST /api/auth/login is accessible without prior auth', async () => {
    // The login endpoint itself must not require authentication
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
      .expect(200)
    expect(res.body.user).toBeDefined()
  })
})
