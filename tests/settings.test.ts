import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'

const request = supertest(app)

// ── GET /api/settings ─────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns the current settings with expected shape', async () => {
    const res = await request.get('/api/settings')
    expect(res.status).toBe(200)
    expect(typeof res.body.provider).toBe('string')
    expect(typeof res.body.model).toBe('string')
    expect(typeof res.body.defaultAgentId).toBe('string')
  })

  it('never exposes an apiKey in the response', async () => {
    const res = await request.get('/api/settings')
    expect(res.body.apiKey).toBeUndefined()
  })
})

// ── PUT /api/settings ─────────────────────────────────────────────

describe('PUT /api/settings', () => {
  it('updates the provider', async () => {
    const res = await request.put('/api/settings').send({ provider: 'opencode' })
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('opencode')
  })

  it('updates the model', async () => {
    const res = await request
      .put('/api/settings')
      .send({ model: 'claude-opus-4-5' })
    expect(res.status).toBe(200)
    expect(res.body.model).toBe('claude-opus-4-5')
  })

  it('updates defaultAgentId', async () => {
    const res = await request
      .put('/api/settings')
      .send({ defaultAgentId: 'opencode-agent' })
    expect(res.status).toBe(200)
    expect(res.body.defaultAgentId).toBe('opencode-agent')
  })

  it('partial update preserves other fields', async () => {
    // set a known state
    await request
      .put('/api/settings')
      .send({ provider: 'claude', model: 'opus', defaultAgentId: 'claude' })

    const res = await request.put('/api/settings').send({ model: 'haiku' })
    expect(res.status).toBe(200)
    // provider and defaultAgentId stay the same
    expect(res.body.provider).toBe('claude')
    expect(res.body.defaultAgentId).toBe('claude')
    expect(res.body.model).toBe('haiku')
  })

  it('returns 400 for an empty provider string', async () => {
    const res = await request.put('/api/settings').send({ provider: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string model', async () => {
    const res = await request.put('/api/settings').send({ model: 42 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string defaultAgentId', async () => {
    const res = await request
      .put('/api/settings')
      .send({ defaultAgentId: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('GET reflects the updated values after a PUT', async () => {
    await request
      .put('/api/settings')
      .send({ provider: 'omnimancer', model: 'gm-1', defaultAgentId: 'omni' })

    const res = await request.get('/api/settings')
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('omnimancer')
    expect(res.body.model).toBe('gm-1')
    expect(res.body.defaultAgentId).toBe('omni')
  })
})
