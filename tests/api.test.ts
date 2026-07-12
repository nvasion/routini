import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { app } from '../server/src/index.js'

// ── Helper ────────────────────────────────────────────────────────────────────

/** Log in and return both the session cookie AND the CSRF token. */
async function loginAsAdmin(): Promise<{ cookies: string[]; csrfToken: string }> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'password' })
    .expect(200)

  const cookies = res.headers['set-cookie'] as unknown as string[]
  const csrfToken = res.body.csrfToken as string
  return { cookies, csrfToken }
}

// ── Auth API ──────────────────────────────────────────────────────────────────

describe('Auth API', () => {
  it('POST /api/auth/login succeeds with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password' })
      .expect(200)

    expect(res.body.user).toMatchObject({ id: 1, username: 'admin' })
    expect(res.body.user).not.toHaveProperty('passwordHash')
  })

  it('POST /api/auth/login returns a csrfToken in the body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password' })
      .expect(200)

    expect(typeof res.body.csrfToken).toBe('string')
    expect(res.body.csrfToken).toHaveLength(64) // 32 random bytes → 64 hex chars
  })

  it('POST /api/auth/login sets an HttpOnly SameSite=Strict cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password' })
      .expect(200)

    const cookies: string[] = res.headers['set-cookie'] as unknown as string[]
    const tokenCookie = cookies.find((c: string) => c.startsWith('routini_token='))
    expect(tokenCookie).toBeDefined()
    expect(tokenCookie).toMatch(/HttpOnly/i)
    expect(tokenCookie).toMatch(/SameSite=Strict/i) // CSRF mitigation layer 1
  })

  it('POST /api/auth/login returns 401 with wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('POST /api/auth/login returns 401 with unknown username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'password' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('POST /api/auth/login returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin' })
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('GET /api/auth/me returns 401 without a session', async () => {
    const res = await request(app).get('/api/auth/me').expect(401)
    expect(res.body.error).toMatch(/authentication required/i)
  })

  it('GET /api/auth/me returns user and csrfToken with a valid session', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.user).toMatchObject({ id: 1, username: 'admin' })
    // CSRF token from /me must match the one issued at login
    expect(res.body.csrfToken).toBe(csrfToken)
  })

  it('GET /api/auth/me returns 401 with a tampered token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', ['routini_token=invalid.token.here; Path=/; HttpOnly'])
      .expect(401)
  })

  it('POST /api/auth/logout clears the cookie', async () => {
    const { cookies } = await loginAsAdmin()
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.message).toMatch(/logged out/i)
    const setCookies: string[] = res.headers['set-cookie'] as unknown as string[]
    const cleared = setCookies?.find((c: string) => c.startsWith('routini_token='))
    expect(cleared).toMatch(/Max-Age=0|Expires=.*1970/i)
  })

  it('POST /api/auth/logout succeeds even without a session', async () => {
    const res = await request(app).post('/api/auth/logout').expect(200)
    expect(res.body.message).toMatch(/logged out/i)
  })
})

// ── CSRF protection ───────────────────────────────────────────────────────────

describe('CSRF protection on state-changing routes', () => {
  it('POST /api/items returns 403 when X-CSRF-Token header is absent', async () => {
    const { cookies } = await loginAsAdmin()
    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .send({ name: 'CSRF attack' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/items returns 403 with an incorrect X-CSRF-Token', async () => {
    const { cookies } = await loginAsAdmin()
    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'forged-token')
      .send({ name: 'CSRF attack' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('DELETE /api/items/:id returns 403 when X-CSRF-Token header is absent', async () => {
    const { cookies } = await loginAsAdmin()
    const res = await request(app)
      .delete('/api/items/1')
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })
})

// ── Items API ─────────────────────────────────────────────────────────────────

describe('Items API', () => {
  it('GET /api/items returns 401 without auth', async () => {
    await request(app).get('/api/items').expect(401)
  })

  it('POST /api/items returns 401 without auth', async () => {
    await request(app).post('/api/items').send({ name: 'Test' }).expect(401)
  })

  it('DELETE /api/items/:id returns 401 without auth', async () => {
    await request(app).delete('/api/items/1').expect(401)
  })

  it('GET /api/items returns items list when authenticated', async () => {
    const { cookies } = await loginAsAdmin()
    const res = await request(app)
      .get('/api/items')
      .set('Cookie', cookies)
      .expect(200)

    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.count).toBe('number')
    expect(res.body.count).toBe(res.body.items.length)
  })

  it('POST /api/items creates an item when authenticated with CSRF token', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()
    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Integration Test Item' })
      .expect(201)

    expect(res.body.name).toBe('Integration Test Item')
    expect(typeof res.body.id).toBe('number')
    expect(typeof res.body.createdAt).toBe('string')
  })

  it('POST /api/items rejects a blank name', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()
    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: '   ' })
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('DELETE /api/items/:id deletes an item when authenticated with CSRF token', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    // Create an item to delete
    const createRes = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'To Delete' })
      .expect(201)

    const id: number = createRes.body.id

    await request(app)
      .delete(`/api/items/${id}`)
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .expect(200)

    // Verify it's gone
    await request(app)
      .get(`/api/items/${id}`)
      .set('Cookie', cookies)
      .expect(404)
  })

  it('DELETE /api/items/:id returns 404 for a nonexistent item', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()
    await request(app)
      .delete('/api/items/999999')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .expect(404)
  })

  it('GET /api/items/:id returns 400 for a non-numeric id', async () => {
    const { cookies } = await loginAsAdmin()
    await request(app)
      .get('/api/items/abc')
      .set('Cookie', cookies)
      .expect(400)
  })
})

// ── Public routes ─────────────────────────────────────────────────────────────

describe('Public routes', () => {
  it('GET /health returns ok without auth', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
  })

  it('GET /api/version returns version without auth', async () => {
    const res = await request(app).get('/api/version').expect(200)
    expect(res.body).toMatchObject({ version: '0.1.0', name: 'routini' })
  })
})
