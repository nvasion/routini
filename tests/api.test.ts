import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../server/src/app.js'

let app: Express

beforeAll(() => {
  app = createApp()
})

describe('GET /health', () => {
  it('returns ok status with a parseable ISO timestamp', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false)
  })
})

describe('GET /api/version', () => {
  it('returns the application name and version', async () => {
    const res = await request(app).get('/api/version')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ version: '0.1.0', name: 'routini' })
  })
})

describe('Items API — happy paths', () => {
  it('GET /api/items returns list with matching count', async () => {
    const res = await request(app).get('/api/items')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.count).toBe(res.body.items.length)
  })

  it('POST /api/items creates an item and echoes the persisted shape', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ name: 'Test Item' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Test Item')
    expect(typeof res.body.id).toBe('number')
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false)
  })

  it('DELETE /api/items/:id removes the item and it becomes unfetchable', async () => {
    const created = await request(app)
      .post('/api/items')
      .send({ name: 'To Delete' })

    const del = await request(app).delete(`/api/items/${created.body.id}`)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ message: 'Item deleted', id: created.body.id })

    const get = await request(app).get(`/api/items/${created.body.id}`)
    expect(get.status).toBe(404)
  })
})

describe('Items API — validation & error paths', () => {
  it('POST /api/items rejects an empty name with 400', async () => {
    const res = await request(app).post('/api/items').send({ name: '' })
    expect(res.status).toBe(400)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /api/items rejects a whitespace-only name with 400', async () => {
    const res = await request(app).post('/api/items').send({ name: '   ' })
    expect(res.status).toBe(400)
  })

  it('POST /api/items rejects a missing name with 400', async () => {
    const res = await request(app).post('/api/items').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/items rejects a non-string name with 400', async () => {
    const res = await request(app).post('/api/items').send({ name: 42 })
    expect(res.status).toBe(400)
  })

  it('POST /api/items rejects an over-long name with 400', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ name: 'x'.repeat(201) })
    expect(res.status).toBe(400)
  })

  it('GET /api/items/:id returns 400 on a non-numeric id', async () => {
    const res = await request(app).get('/api/items/not-a-number')
    expect(res.status).toBe(400)
  })

  it('GET /api/items/:id returns 400 on a negative id', async () => {
    const res = await request(app).get('/api/items/-1')
    expect(res.status).toBe(400)
  })

  it('GET /api/items/:id returns 404 on an unknown id', async () => {
    const res = await request(app).get('/api/items/9999999')
    expect(res.status).toBe(404)
  })

  it('DELETE /api/items/:id returns 400 on an invalid id', async () => {
    const res = await request(app).delete('/api/items/not-a-number')
    expect(res.status).toBe(400)
  })

  it('DELETE /api/items/:id returns 404 on an unknown id', async () => {
    const res = await request(app).delete('/api/items/9999999')
    expect(res.status).toBe(404)
  })
})

describe('Unknown routes', () => {
  it('return 404 with a JSON error body', async () => {
    const res = await request(app).get('/no-such-route')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Not Found')
  })
})

describe('Security baseline', () => {
  it('sets Helmet security headers on responses', async () => {
    const res = await request(app).get('/health')
    // Helmet's most defensible defaults — presence proves the middleware
    // is wired in; specific values are helmet's concern, not ours.
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-dns-prefetch-control']).toBeDefined()
    expect(res.headers['x-frame-options']).toBeDefined()
  })

  it('allows a request with no Origin header (same-origin / server-to-server)', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
  })

  it('accepts a request from an allowlisted Origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:5173')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('rejects a request from an origin not on the allowlist with 403', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example.com')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Origin not allowed' })
  })
})

describe('Security baseline — configurable allowlist', () => {
  it('honors a custom allowlist passed via config', async () => {
    const { createApp: createAppFn } = await import('../server/src/app.js')
    const customApp = createAppFn({
      port: 3001,
      allowedOrigins: ['https://custom.example.com'],
      isProduction: false,
    })
    const ok = await request(customApp)
      .get('/health')
      .set('Origin', 'https://custom.example.com')
    expect(ok.status).toBe(200)

    const bad = await request(customApp)
      .get('/health')
      .set('Origin', 'http://localhost:5173')
    expect(bad.status).toBe(403)
  })
})
