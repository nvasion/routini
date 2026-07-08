import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../server/src/app.js'

/**
 * Skeleton-level smoke tests. These exercise the pieces `createApp` wires
 * up when no auth dependencies are injected — the health probe and the
 * public version endpoint. Fuller behavior (items CRUD, auth flows) lives
 * in the auth-integration and route-specific test suites so this file
 * stays focused on the app factory itself.
 */
describe('createApp — skeleton', () => {
  let app: Express

  beforeAll(() => {
    app = createApp()
  })

  it('serves /health with an ok status and ISO timestamp', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
    // ISO 8601 round-trips through Date without becoming NaN.
    expect(Number.isNaN(new Date(res.body.timestamp).getTime())).toBe(false)
  })

  it('serves /api/version publicly', async () => {
    const res = await request(app).get('/api/version')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ version: '0.1.0', name: 'routini' })
  })

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
  })

  it('rejects requests from a disallowed Origin with 403', async () => {
    const res = await request(app)
      .get('/api/version')
      .set('Origin', 'https://evil.example.com')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Origin not allowed' })
  })
})
