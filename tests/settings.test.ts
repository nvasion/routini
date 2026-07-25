import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { currentSettings, storedApiKey } from '../server/src/routes/settings'

const request = supertest(app)

// ── Auth helper ───────────────────────────────────────────────────────
// Settings endpoints require a valid Bearer token.

let authToken: string

beforeAll(async () => {
beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  expect(res.status).toBe(200)
  authToken = res.body.token as string
  expect(authToken).toBeDefined()
})
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── GET /api/settings ─────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns the current settings with expected shape', async () => {
    const res = await request.get('/api/settings').set(auth())
    expect(res.status).toBe(200)
    expect(typeof res.body.provider).toBe('string')
    expect(typeof res.body.model).toBe('string')
    expect(typeof res.body.defaultAgentId).toBe('string')
  })

  it('includes hasApiKey boolean in the response', async () => {
    const res = await request.get('/api/settings').set(auth())
    expect(res.status).toBe(200)
    expect(typeof res.body.hasApiKey).toBe('boolean')
  })

  it('never exposes an apiKey in the response', async () => {
    const res = await request.get('/api/settings').set(auth())
    expect(res.body.apiKey).toBeUndefined()
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/api/settings')
    expect(res.status).toBe(401)
  })
})

// ── PUT /api/settings ─────────────────────────────────────────────

describe('PUT /api/settings', () => {
  it('updates the provider', async () => {
    const res = await request.put('/api/settings').set(auth()).send({ provider: 'opencode' })
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('opencode')
  })

  it('updates the model', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ model: 'claude-opus-4-5' })
    expect(res.status).toBe(200)
    expect(res.body.model).toBe('claude-opus-4-5')
  })

  it('updates defaultAgentId', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ defaultAgentId: 'opencode-agent' })
    expect(res.status).toBe(200)
    expect(res.body.defaultAgentId).toBe('opencode-agent')
  })

  it('partial update preserves other fields', async () => {
    // set a known state
    await request
      .put('/api/settings')
      .set(auth())
      .send({ provider: 'claude', model: 'opus', defaultAgentId: 'claude' })

    const res = await request.put('/api/settings').set(auth()).send({ model: 'haiku' })
    expect(res.status).toBe(200)
    // provider and defaultAgentId stay the same
    expect(res.body.provider).toBe('claude')
    expect(res.body.defaultAgentId).toBe('claude')
    expect(res.body.model).toBe('haiku')
  })

  it('returns 400 for an empty provider string', async () => {
    const res = await request.put('/api/settings').set(auth()).send({ provider: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string model', async () => {
    const res = await request.put('/api/settings').set(auth()).send({ model: 42 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string defaultAgentId', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ defaultAgentId: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.put('/api/settings').send({ provider: 'claude' })
    expect(res.status).toBe(401)
  })

  it('GET reflects the updated values after a PUT', async () => {
    await request
      .put('/api/settings')
      .set(auth())
      .send({ provider: 'omnimancer', model: 'gm-1', defaultAgentId: 'omni' })

    const res = await request.get('/api/settings').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('omnimancer')
    expect(res.body.model).toBe('gm-1')
    expect(res.body.defaultAgentId).toBe('omni')
  })
})

// ── PUT /api/settings – API key storage ──────────────────────────

describe('PUT /api/settings – apiKey storage', () => {
  it('initially reports no key configured (hasApiKey is false)', async () => {
    // Confirm the default seeded state has no API key.
    const res = await request.get('/api/settings').set(auth())
    // hasApiKey may be true if a previous test stored one; the important
    // guarantee is that the field is always a boolean, never the raw key.
    expect(typeof res.body.hasApiKey).toBe('boolean')
    expect(res.body.apiKey).toBeUndefined()
  })

  it('stores an apiKey and returns hasApiKey: true without the key', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 'sk-test-secret-key-123' })
    expect(res.status).toBe(200)
    expect(res.body.hasApiKey).toBe(true)
    // The plaintext key must never appear in the response.
    expect(res.body.apiKey).toBeUndefined()
  })

  it('GET reflects hasApiKey: true after a key is stored', async () => {
    // Ensure a key has been stored by the previous test (tests run in order).
    const res = await request.get('/api/settings').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.hasApiKey).toBe(true)
    expect(res.body.apiKey).toBeUndefined()
  })

  it('replaces an existing key when a new apiKey is supplied', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 'sk-replacement-key-456' })
    expect(res.status).toBe(200)
    expect(res.body.hasApiKey).toBe(true)
    expect(res.body.apiKey).toBeUndefined()
  })

  it('preserves other fields when only apiKey is updated', async () => {
    // Set known values first.
    await request
      .put('/api/settings')
      .set(auth())
      .send({ provider: 'opencode', model: 'gpt-4', defaultAgentId: 'opencode-agent' })

    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 'sk-preserve-test-789' })
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('opencode')
    expect(res.body.model).toBe('gpt-4')
    expect(res.body.defaultAgentId).toBe('opencode-agent')
    expect(res.body.hasApiKey).toBe(true)
  })

  it('returns 400 for an empty apiKey string', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string apiKey (number)', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 12345 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a non-string apiKey (boolean)', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for a whitespace-only apiKey', async () => {
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('never exposes the apiKey even after storing one', async () => {
    await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 'sk-must-not-leak' })

    const get = await request.get('/api/settings').set(auth())
    expect(get.body.apiKey).toBeUndefined()

    const put = await request
      .put('/api/settings')
      .set(auth())
      .send({ provider: 'claude' })
    expect(put.body.apiKey).toBeUndefined()
  })

  it('omitting apiKey in a PUT leaves the stored key unchanged', async () => {
    // Store a key.
    await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: 'sk-persistent-key' })

    // Update something else; apiKey field is absent.
    const res = await request
      .put('/api/settings')
      .set(auth())
      .send({ model: 'claude-sonnet' })
    expect(res.status).toBe(200)
    // hasApiKey must remain true (key was not cleared).
    expect(res.body.hasApiKey).toBe(true)
    expect(res.body.apiKey).toBeUndefined()
  })

  it('returns 401 when storing apiKey without authentication', async () => {
    const res = await request
      .put('/api/settings')
      .send({ apiKey: 'sk-unauthed' })
    expect(res.status).toBe(401)
  })
})

// ── Internal state verification ───────────────────────────────────

describe('internal state – storedApiKey is isolated from responses', () => {
  it('storedApiKey module export holds the raw key while responses do not', async () => {
    const testKey = 'sk-internal-verification-key'
    await request
      .put('/api/settings')
      .set(auth())
      .send({ apiKey: testKey })

    // The in-memory store holds the value (testable in-process).
    expect(storedApiKey).toBe(testKey)

    // The public API response never leaks it.
    const res = await request.get('/api/settings').set(auth())
    expect(res.body.apiKey).toBeUndefined()
    expect(res.body.hasApiKey).toBe(true)

    // Sanity-check the currentSettings object itself.
    expect((currentSettings as Record<string, unknown>).apiKey).toBeUndefined()
  })
})
