import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { app } from '../src/index.js'

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

// ── POST /api/auth/login ──────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns 200, user object, and csrfToken with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password' })
      .expect(200)

    expect(res.body.user).toMatchObject({ id: 1, username: 'admin' })
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(typeof res.body.csrfToken).toBe('string')
    expect(res.body.csrfToken).toHaveLength(64) // 32 bytes → 64 hex chars
  })

  it('sets an HttpOnly cookie on successful login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password' })
      .expect(200)

    const cookies: string[] = res.headers['set-cookie'] as unknown as string[]
    expect(cookies).toBeDefined()
    const tokenCookie = cookies.find((c: string) => c.startsWith('routini_token='))
    expect(tokenCookie).toBeDefined()
    expect(tokenCookie).toMatch(/HttpOnly/i)
    expect(tokenCookie).toMatch(/SameSite=Strict/i)
  })

  it('returns 401 with an unknown username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'password' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('returns 401 with a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' })
      .expect(401)

    expect(res.body.error).toBe('Invalid credentials')
  })

  it('returns 400 when username is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'password' })
      .expect(400)

    expect(res.body.error).toMatch(/required/i)
  })

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin' })
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
})

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .expect(401)

    expect(res.body.error).toMatch(/authentication required/i)
  })

  it('returns current user and csrfToken when authenticated', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.user).toMatchObject({ id: 1, username: 'admin' })
    expect(typeof res.body.csrfToken).toBe('string')
    expect(res.body.csrfToken).toHaveLength(64)
  })

  it('returns the same csrfToken across login and me', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies)
      .expect(200)

    expect(meRes.body.csrfToken).toBe(csrfToken)
  })

  it('returns 401 with a tampered token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', ['routini_token=invalid.token.here; Path=/; HttpOnly'])
      .expect(401)

    expect(res.body.error).toMatch(/invalid or expired/i)
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

    // The Set-Cookie header should clear the token cookie (Max-Age=0 or Expires in the past)
    const setCookies: string[] = res.headers['set-cookie'] as unknown as string[]
    const cleared = setCookies?.find((c: string) => c.startsWith('routini_token='))
    expect(cleared).toBeDefined()
    // Express clears cookie by setting Max-Age=0 or empty value
    expect(cleared).toMatch(/Max-Age=0|Expires=.*1970/i)
  })

  it('returns 200 even when called without a session', async () => {
    // Logout is idempotent — no auth required to call it
    const res = await request(app)
      .post('/api/auth/logout')
      .expect(200)

    expect(res.body.message).toMatch(/logged out/i)
  })
})

// ── CSRF protection on state-changing routes ──────────────────────────────────

describe('CSRF protection', () => {
  it('POST /api/items returns 403 without X-CSRF-Token header', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .send({ name: 'CSRF test' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/items returns 403 with a wrong CSRF token', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'completely-wrong-token')
      .send({ name: 'CSRF test' })
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('DELETE /api/items/:id returns 403 without X-CSRF-Token header', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .delete('/api/items/1')
      .set('Cookie', cookies)
      // deliberately omit X-CSRF-Token
      .expect(403)

    expect(res.body.error).toMatch(/csrf/i)
  })

  it('POST /api/items succeeds with the correct CSRF token', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'CSRF-protected item' })
      .expect(201)

    expect(res.body.name).toBe('CSRF-protected item')
  })
})

// ── Protected routes require auth ─────────────────────────────────────────────

describe('Protected item routes', () => {
  it('GET /api/items returns 401 without auth', async () => {
    await request(app).get('/api/items').expect(401)
  })

  it('POST /api/items returns 401 without auth', async () => {
    await request(app)
      .post('/api/items')
      .send({ name: 'Test' })
      .expect(401)
  })

  it('DELETE /api/items/:id returns 401 without auth', async () => {
    await request(app).delete('/api/items/1').expect(401)
  })

  it('GET /api/items returns 200 with valid auth', async () => {
    const { cookies } = await loginAsAdmin()

    const res = await request(app)
      .get('/api/items')
      .set('Cookie', cookies)
      .expect(200)

    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.count).toBe('number')
  })

  it('POST /api/items creates item when authenticated with CSRF token', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    const res = await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Auth Test Item' })
      .expect(201)

    expect(res.body).toMatchObject({ name: 'Auth Test Item' })
    expect(res.body.id).toBeTypeOf('number')
  })

  it('POST /api/items rejects blank name', async () => {
    const { cookies, csrfToken } = await loginAsAdmin()

    await request(app)
      .post('/api/items')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: '   ' })
      .expect(400)
  })

  it('GET /api/items/:id returns 400 for non-numeric id', async () => {
    const { cookies } = await loginAsAdmin()

    await request(app)
      .get('/api/items/abc')
      .set('Cookie', cookies)
      .expect(400)
  })
})

// ── Public routes remain accessible ──────────────────────────────────────────

describe('Public routes', () => {
  it('GET /health is accessible without auth', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
  })

  it('GET /api/version is accessible without auth', async () => {
    const res = await request(app).get('/api/version').expect(200)
    expect(res.body.version).toBe('0.1.0')
  })
})
