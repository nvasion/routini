/**
 * CSRF protection and cookie-based authentication integration tests.
 *
 * The server implements the Double-Submit Cookie pattern:
 *   1. On successful login, a random csrfToken is embedded in the JWT and
 *      returned in the response body (but NOT in the cookie itself).
 *   2. Browser clients store the csrfToken in sessionStorage.
 *   3. Every state-changing request (POST/PUT/DELETE) made via cookie auth
 *      must include the csrfToken in the X-CSRF-Token header.
 *   4. Bearer-token clients are exempt — they cannot be targeted by CSRF
 *      because the token is not automatically sent by the browser.
 *
 * Coverage:
 *   – Login response: csrfToken field, cookie name/attributes (HttpOnly, SameSite)
 *   – Cookie-auth GET endpoints succeed without a CSRF header
 *   – Cookie-auth state-changing endpoints reject missing / wrong CSRF headers (403)
 *   – Cookie-auth state-changing endpoints succeed with the correct CSRF header
 *   – Bearer auth bypasses CSRF validation for all state-changing endpoints
 *   – CSRF token is unique per login session (not reused)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a new supertest agent with its own independent cookie jar. */
function makeAgent() {
  return supertest.agent(app)
}

type Agent = ReturnType<typeof makeAgent>

/**
 * Logs in via cookie-based auth and returns the CSRF token from the response
 * body. The agent automatically stores the HttpOnly cookie for subsequent
 * requests.
 */
async function loginWithCookie(agent: Agent): Promise<{ csrfToken: string }> {
  const res = await agent
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  expect(res.status).toBe(200)
  expect(typeof res.body.csrfToken).toBe('string')
  return { csrfToken: res.body.csrfToken as string }
}

// ═════════════════════════════════════════════════════════════════════════════
// Login response shape + cookie attributes
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/login – csrfToken and cookie attributes', () => {
  it('includes a non-empty csrfToken in the JSON body', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    expect(res.status).toBe(200)
    expect(typeof res.body.csrfToken).toBe('string')
    expect(res.body.csrfToken.length).toBeGreaterThan(0)
  })

  it('csrfToken is a 64-character lowercase hex string (32 random bytes)', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different login requests produce different csrfTokens', async () => {
    const [r1, r2] = await Promise.all([
      supertest(app)
        .post('/api/auth/login')
        .send({ email: 'admin@routini.dev', password: 'changeme' }),
      supertest(app)
        .post('/api/auth/login')
        .send({ email: 'admin@routini.dev', password: 'changeme' }),
    ])
    expect(r1.body.csrfToken).not.toBe(r2.body.csrfToken)
  })

  it('sets a cookie named routini_token', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    const cookies = (res.headers['set-cookie'] ?? []) as string[]
    expect(cookies.some(c => c.startsWith('routini_token='))).toBe(true)
  })

  it('the cookie has the HttpOnly attribute', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    const cookies = (res.headers['set-cookie'] ?? []) as string[]
    const tokenCookie = cookies.find(c => c.startsWith('routini_token='))
    expect(tokenCookie).toBeDefined()
    expect(tokenCookie).toMatch(/HttpOnly/i)
  })

  it('the cookie has SameSite=Strict to defend against CSRF at the browser level', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    const cookies = (res.headers['set-cookie'] ?? []) as string[]
    const tokenCookie = cookies.find(c => c.startsWith('routini_token='))
    expect(tokenCookie).toMatch(/SameSite=Strict/i)
  })

  it('the cookie has a Max-Age attribute (persistent session)', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })

    const cookies = (res.headers['set-cookie'] ?? []) as string[]
    const tokenCookie = cookies.find(c => c.startsWith('routini_token='))
    expect(tokenCookie).toMatch(/Max-Age=\d+/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GET endpoints: no CSRF header required even with cookie auth
// ═════════════════════════════════════════════════════════════════════════════

describe('GET endpoints via cookie auth – CSRF header not required', () => {
  it('GET /api/tasks succeeds with cookie auth and no X-CSRF-Token', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent.get('/api/tasks')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.tasks)).toBe(true)
  })

  it('GET /api/settings succeeds with cookie auth and no X-CSRF-Token', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent.get('/api/settings')
    expect(res.status).toBe(200)
    expect(typeof res.body.provider).toBe('string')
  })

  it('GET /api/notifications/settings succeeds with cookie auth and no X-CSRF-Token', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent.get('/api/notifications/settings')
    expect(res.status).toBe(200)
    expect(typeof res.body.enabled).toBe('boolean')
  })

  it('GET /api/auth/me succeeds with cookie auth and no X-CSRF-Token', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent.get('/api/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.email).toBe('admin@routini.dev')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/tasks – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks – CSRF enforcement with cookie auth', () => {
  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent
      .post('/api/tasks')
      .send({ name: 'No CSRF', type: 'routine' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 403 with a wrong X-CSRF-Token value', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent
      .post('/api/tasks')
      .set('x-csrf-token', 'totally-wrong-csrf-token')
      .send({ name: 'Wrong CSRF', type: 'routine' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 403 with an empty X-CSRF-Token value', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent
      .post('/api/tasks')
      .set('x-csrf-token', '')
      .send({ name: 'Empty CSRF', type: 'routine' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 201 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .post('/api/tasks')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'CSRF-Protected Routine', type: 'routine' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('CSRF-Protected Routine')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/tasks/:id – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('PUT /api/tasks/:id – CSRF enforcement with cookie auth', () => {
  let taskId: string

  beforeAll(async () => {
    // Create a task via Bearer token (no CSRF required) to use in the PUT tests.
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await supertest(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'CSRF PUT Target', type: 'routine' })
    taskId = created.body.id as string
  })

  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.put(`/api/tasks/${taskId}`).send({ name: 'New Name' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .put(`/api/tasks/${taskId}`)
      .set('x-csrf-token', csrfToken)
      .send({ name: 'CSRF-Updated Name' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('CSRF-Updated Name')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/tasks/:id/steps – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('PUT /api/tasks/:id/steps – CSRF enforcement with cookie auth', () => {
  let routineId: string

  beforeAll(async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await supertest(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'CSRF Steps Target', type: 'routine' })
    routineId = created.body.id as string
  })

  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.put(`/api/tasks/${routineId}/steps`).send({ steps: [] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .put(`/api/tasks/${routineId}/steps`)
      .set('x-csrf-token', csrfToken)
      .send({ steps: [] })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('routine')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/tasks/:id – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/tasks/:id – CSRF enforcement with cookie auth', () => {
  it('returns 403 with no X-CSRF-Token header', async () => {
    // Create a task to target
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await supertest(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'CSRF Delete Target 1', type: 'routine' })
    const taskId = created.body.id as string

    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent.delete(`/api/tasks/${taskId}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await supertest(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'CSRF Delete Target 2', type: 'routine' })
    const taskId = created.body.id as string

    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)
    const res = await agent.delete(`/api/tasks/${taskId}`).set('x-csrf-token', csrfToken)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(taskId)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/tasks/:id/trigger – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks/:id/trigger – CSRF enforcement with cookie auth', () => {
  let taskId: string

  beforeAll(async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    const bearer = loginRes.body.token as string

    const created = await supertest(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'CSRF Trigger Target', type: 'routine' })
    taskId = created.body.id as string
  })

  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.post(`/api/tasks/${taskId}/trigger`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .post(`/api/tasks/${taskId}/trigger`)
      .set('x-csrf-token', csrfToken)

    expect(res.status).toBe(200)
    expect(res.body.task.id).toBe(taskId)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/settings – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('PUT /api/settings – CSRF enforcement with cookie auth', () => {
  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.put('/api/settings').send({ model: 'claude-haiku' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .put('/api/settings')
      .set('x-csrf-token', csrfToken)
      .send({ model: 'claude-haiku' })

    expect(res.status).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/notifications/settings – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('PUT /api/notifications/settings – CSRF enforcement with cookie auth', () => {
  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.put('/api/notifications/settings').send({ enabled: false })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .put('/api/notifications/settings')
      .set('x-csrf-token', csrfToken)
      .send({ enabled: false })

    expect(res.status).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/notifications/test – CSRF enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/notifications/test – CSRF enforcement with cookie auth', () => {
  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent
      .post('/api/notifications/test')
      .send({ recipientEmail: 'test@example.com' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 503 (SMTP not configured) – not 403 – when CSRF is supplied', async () => {
    // 503 means the CSRF check passed and the request reached the SMTP check.
    // This validates that the correct X-CSRF-Token unlocks the endpoint.
    const agent = makeAgent()
    const { csrfToken } = await loginWithCookie(agent)

    const res = await agent
      .post('/api/notifications/test')
      .set('x-csrf-token', csrfToken)
      .send({ recipientEmail: 'test@example.com' })

    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/smtp/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Bearer auth – CSRF not required for any state-changing endpoint
// ═════════════════════════════════════════════════════════════════════════════

describe('Bearer auth – CSRF header not required', () => {
  let bearerToken: string

  beforeAll(async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    bearerToken = res.body.token as string
  })

  function bearer() {
    return { Authorization: `Bearer ${bearerToken}` }
  }

  it('POST /api/tasks succeeds with Bearer token and no X-CSRF-Token header', async () => {
    const res = await supertest(app)
      .post('/api/tasks')
      .set(bearer())
      .send({ name: 'Bearer No CSRF', type: 'routine' })

    expect(res.status).toBe(201)
    expect(res.body.type).toBe('routine')
  })

  it('PUT /api/settings succeeds with Bearer token and no X-CSRF-Token header', async () => {
    const res = await supertest(app)
      .put('/api/settings')
      .set(bearer())
      .send({ provider: 'claude' })

    expect(res.status).toBe(200)
  })

  it('PUT /api/notifications/settings succeeds with Bearer token and no X-CSRF-Token header', async () => {
    const res = await supertest(app)
      .put('/api/notifications/settings')
      .set(bearer())
      .send({ enabled: false })

    expect(res.status).toBe(200)
  })

  it('DELETE /api/tasks/:id succeeds with Bearer token and no X-CSRF-Token header', async () => {
    const created = await supertest(app)
      .post('/api/tasks')
      .set(bearer())
      .send({ name: 'Bearer Delete Me', type: 'routine' })
    const id = created.body.id as string

    const res = await supertest(app).delete(`/api/tasks/${id}`).set(bearer())
    expect(res.status).toBe(200)
  })

  it('POST /api/tasks/:id/trigger succeeds with Bearer token and no X-CSRF-Token header', async () => {
    const created = await supertest(app)
      .post('/api/tasks')
      .set(bearer())
      .send({ name: 'Bearer Trigger Me', type: 'routine' })
    const id = created.body.id as string

    const res = await supertest(app).post(`/api/tasks/${id}/trigger`).set(bearer())
    expect(res.status).toBe(200)
    expect(res.body.task.status).toBe('queued')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Cookie invalidation on logout
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/logout – cookie cleared', () => {
  it('clears the routini_token cookie on logout', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.post('/api/auth/logout')
    expect(res.status).toBe(200)

    // Express clears the cookie by setting Max-Age=0 or an Expires in the past.
    const cookies = (res.headers['set-cookie'] ?? []) as string[]
    const cleared = cookies.find(c => c.startsWith('routini_token='))
    expect(cleared).toBeDefined()
    expect(cleared).toMatch(/Max-Age=0|Expires=.*1970/i)
  })

  it('subsequent requests after logout are rejected with 401', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    await agent.post('/api/auth/logout')

    // The agent no longer has a valid session — the cookie was cleared.
    const res = await agent.get('/api/tasks')
    expect(res.status).toBe(401)
  })
})
