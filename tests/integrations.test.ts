/**
 * HTTP-level tests for the Integrations API router
 * (server/src/routes/integrations.ts), exercised through the assembled
 * Express app with supertest.
 *
 * Coverage:
 *   – Authentication is required on every endpoint (401 without a token).
 *   – GET returns the full catalog with per-integration status/scopes and
 *     never leaks secret material anywhere in the payload.
 *   – PUT validates required fields, rejects unknown field keys and invalid
 *     scopes, stores credentials write-only, and flips status to "connected".
 *   – PUT on an already-connected integration allows a scopes-only update
 *     without resupplying credentials.
 *   – POST /:id/test requires the integration to be connected first, persists
 *     lastTestAt/lastTestOk, and flips status to "error" on a failed check —
 *     using an injected global fetch mock so no real network call is made.
 *   – DELETE removes stored credentials and resets metadata back to
 *     "not_connected" with default scopes.
 *   – Unknown integration ids 404 on every route.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb } from '../server/src/db/index.js'

const request = supertest(app)

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

beforeEach(() => {
  process.env['NODE_ENV'] = 'test'
  resetDb()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects unauthenticated list requests with 401', async () => {
    const res = await request.get('/api/integrations')
    expect(res.status).toBe(401)
  })

  it('rejects unauthenticated writes with 401', async () => {
    const res = await request
      .put('/api/integrations/github')
      .send({ credentials: { token: 'x' } })
    expect(res.status).toBe(401)
  })
})

// ── GET /api/integrations ─────────────────────────────────────────────────────

describe('GET /api/integrations', () => {
  it('returns all eight v1 integrations, not connected by default', async () => {
    const res = await request.get('/api/integrations').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.integrations).toHaveLength(8)
    const ids = res.body.integrations.map((i: { id: string }) => i.id).sort()
    expect(ids).toEqual(
      ['factoryNexus', 'github', 'hubspot', 'jira', 'linear', 'monday', 'notion', 'slack'].sort(),
    )
    for (const integration of res.body.integrations) {
      expect(integration.status).toBe('not_connected')
      expect(integration.connectedAt).toBeNull()
      expect(integration.lastTestAt).toBeNull()
      expect(integration.lastTestOk).toBeNull()
      expect(integration.scopes.taskTypes).toEqual(
        expect.arrayContaining(['daily', 'developmental', 'routine']),
      )
      expect(integration.scopes.agents).toEqual(
        expect.arrayContaining(['claude', 'opencode', 'omnimancer']),
      )
    }
  })

  it('describes credential fields by name/label/secret without values', async () => {
    const res = await request.get('/api/integrations').set(auth())
    const github = res.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.fields).toEqual([{ key: 'token', label: 'Personal Access Token', secret: true }])
  })
})

// ── PUT /api/integrations/:id ─────────────────────────────────────────────────

describe('PUT /api/integrations/:id', () => {
  it('404s for an unknown integration id', async () => {
    const res = await request
      .put('/api/integrations/bogus')
      .set(auth())
      .send({ credentials: { token: 'x' } })
    expect(res.status).toBe(404)
  })

  it('rejects a first connect missing a required field with 400', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { apiToken: 'tok' } }) // missing siteUrl, email
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Missing required field/)
  })

  it('rejects an unknown credential field key with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x', extra: 'nope' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown credential field/)
  })

  it('rejects an empty-string field value with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: '   ' } })
    expect(res.status).toBe(400)
  })

  it('connects on a valid PUT and never echoes the secret back', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_super_secret_value' } })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(typeof res.body.connectedAt).toBe('string')
    expect(JSON.stringify(res.body)).not.toContain('ghp_super_secret_value')
  })

  it('rejects invalid scopes with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' }, scopes: { taskTypes: ['not-a-type'] } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scopes/)
  })

  it('persists custom scopes on connect', async () => {
    const res = await request
      .put('/api/integrations/slack')
      .set(auth())
      .send({
        credentials: { botToken: 'xoxb-x' },
        scopes: { taskTypes: ['daily'], agents: ['claude'] },
      })
    expect(res.status).toBe(200)
    expect(res.body.scopes).toEqual({ taskTypes: ['daily'], agents: ['claude'] })
  })

  it('allows a scopes-only update once connected, without resupplying credentials', async () => {
    await request
      .put('/api/integrations/slack')
      .set(auth())
      .send({ credentials: { botToken: 'xoxb-x' } })

    const res = await request
      .put('/api/integrations/slack')
      .set(auth())
      .send({ scopes: { taskTypes: ['routine'], agents: ['opencode'] } })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(res.body.scopes).toEqual({ taskTypes: ['routine'], agents: ['opencode'] })
  })
})

// ── POST /api/integrations/:id/test ───────────────────────────────────────────

describe('POST /api/integrations/:id/test', () => {
  it('rejects testing an integration that is not connected with 400', async () => {
    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(400)
  })

  it('404s for an unknown integration id', async () => {
    const res = await request.post('/api/integrations/bogus/test').set(auth())
    expect(res.status).toBe(404)
  })

  it('records a successful test and reports status=connected', async () => {
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'ghp_x' } })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    )

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(res.body.lastTestOk).toBe(true)
    expect(typeof res.body.lastTestAt).toBe('string')
  })

  it('records a failed test and reports status=error', async () => {
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'ghp_x' } })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response),
    )

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('error')
    expect(res.body.lastTestOk).toBe(false)
  })

  it('never leaks the stored secret in the test response', async () => {
    await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_super_secret_value' } })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    )

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(JSON.stringify(res.body)).not.toContain('ghp_super_secret_value')
  })
})

// ── DELETE /api/integrations/:id ──────────────────────────────────────────────

describe('DELETE /api/integrations/:id', () => {
  it('disconnects: removes credentials and resets metadata to defaults', async () => {
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'ghp_x' } })

    const del = await request.delete('/api/integrations/github').set(auth())
    expect(del.status).toBe(200)
    expect(del.body.status).toBe('not_connected')
    expect(del.body.connectedAt).toBeNull()
    expect(del.body.scopes.taskTypes).toEqual(
      expect.arrayContaining(['daily', 'developmental', 'routine']),
    )

    // A subsequent test attempt must report "not connected" again.
    const test = await request.post('/api/integrations/github/test').set(auth())
    expect(test.status).toBe(400)
  })

  it('404s for an unknown integration id', async () => {
    const res = await request.delete('/api/integrations/bogus').set(auth())
    expect(res.status).toBe(404)
  })

  it('is safe to call on an integration that was never connected', async () => {
    const res = await request.delete('/api/integrations/hubspot').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('not_connected')
  })
})
