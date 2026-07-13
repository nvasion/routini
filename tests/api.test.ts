/**
 * Integration smoke tests via index.ts (the real server entry point).
 *
 * Detailed auth, task, and settings tests live in their own files.
 * These tests verify that the app wired up in app.ts is correctly
 * re-exported by index.ts and that key cross-cutting concerns
 * (health check, 404 handler, auth enforcement on all protected routes)
 * work end-to-end from the server entry point.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { app } from '../server/src/index.js'

// ── Public routes ─────────────────────────────────────────────────

describe('Public routes', () => {
  it('GET /health returns ok without auth', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
  })

  it('GET /nonexistent returns 404 with JSON error', async () => {
    const res = await request(app).get('/nonexistent').expect(404)
    expect(res.body.error).toBeDefined()
  })
})

// ── Auth enforcement ──────────────────────────────────────────────
// These checks confirm that protected route prefixes reject unauthenticated
// requests at the app-mount level (middleware applied in app.ts).

describe('Auth enforcement on protected routes', () => {
  it('GET /api/tasks returns 401 without a Bearer token', async () => {
    const res = await request(app).get('/api/tasks').expect(401)
    expect(res.body.error).toBeDefined()
  })

  it('POST /api/tasks returns 401 without a Bearer token', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ name: 'Unauthenticated task', type: 'routine' })
      .expect(401)
    expect(res.body.error).toBeDefined()
  })

  it('GET /api/settings returns 401 without a Bearer token', async () => {
    const res = await request(app).get('/api/settings').expect(401)
    expect(res.body.error).toBeDefined()
  })

  it('PUT /api/settings returns 401 without a Bearer token', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ provider: 'opencode' })
      .expect(401)
    expect(res.body.error).toBeDefined()
  })
})

// ── Auth login (smoke test) ───────────────────────────────────────
// Full auth test coverage is in tests/auth.test.ts.  This confirms the
// auth router is reachable from the index.ts entry point.

describe('Auth login (reachable via index.ts)', () => {
  it('POST /api/auth/login returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' })
      .expect(401)
    expect(res.body.error).toBeDefined()
  })

  it('POST /api/auth/login returns a token for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
      .expect(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.token.length).toBeGreaterThan(0)
  })
})
