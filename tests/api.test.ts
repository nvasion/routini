import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'

const request = supertest(app)

describe('GET /health', () => {
  it('returns status ok with an ISO timestamp', async () => {
    const res = await request.get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
    expect(new Date(res.body.timestamp).getTime()).not.toBeNaN()
  })
})

describe('GET /api/version', () => {
  it('returns version and name', async () => {
    const res = await request.get('/api/version')
    expect(res.status).toBe(200)
    expect(res.body.version).toBe('0.1.0')
    expect(res.body.name).toBe('routini')
  })
})

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request.get('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })

  it('returns JSON for unknown routes', async () => {
    const res = await request.get('/no-such-path')
    expect(res.status).toBe(404)
    expect(res.type).toMatch(/json/)
  })
})
