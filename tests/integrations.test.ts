/**
 * HTTP-level tests for the integrations API
 * (server/src/routes/integrations.ts), exercised through the assembled
 * Express app with supertest.
 *
 * Coverage:
 *   – GET returns the full catalog with status metadata and never leaks
 *     secret material.
 *   – PUT validates required fields, persists credentials + scoping, and
 *     rejects invalid scope values / unknown integration ids.
 *   – POST /:id/test (the primary endpoint under test) requires the
 *     integration to be connected first, performs the live provider check
 *     (global fetch is mocked so no real network calls are made), persists
 *     lastTestAt/lastTestOk, and reflects the result in subsequent GETs.
 *   – DELETE removes stored credentials and resets metadata so the
 *     integration reverts to "not_connected".
 *   – Authentication is required on every route.
 *
 * GitHub is used as the representative provider for the full CRUD + test
 * lifecycle because its check is a single fixed-host fetch with no
 * additional SSRF/DNS step; Jira's SSRF-sensitive siteUrl validation (the one
 * provider whose check depends on a real DNS lookup) is covered exhaustively
 * at the unit level in tests/integrationProviders.test.ts instead, so these
 * HTTP-level tests never need real network/DNS access.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb } from '../server/src/db/index.js'
import { resetIntegrationsState } from '../server/src/routes/integrations.js'

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
  resetIntegrationsState()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

/** Stubs global fetch to return a fixed status/JSON body for every call. */
function stubFetchJson(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ status, json: async () => body }),
  )
}

function stubFetchReject(err: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))
}

async function connectGithub(token = 'gh-fine-grained-pat') {
  return request.put('/api/integrations/github').set(auth()).send({ token })
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await request.get('/api/integrations')
    expect(res.status).toBe(401)
  })

  it('rejects an unauthenticated PUT with 401', async () => {
    const res = await request.put('/api/integrations/github').send({ token: 'x' })
    expect(res.status).toBe(401)
  })

  it('rejects an unauthenticated test with 401', async () => {
    const res = await request.post('/api/integrations/github/test')
    expect(res.status).toBe(401)
  })

  it('rejects an unauthenticated DELETE with 401', async () => {
    const res = await request.delete('/api/integrations/github')
    expect(res.status).toBe(401)
  })
})

// ── GET /api/integrations ──────────────────────────────────────────────────────

describe('GET /api/integrations', () => {
  it('returns all seven v1 integrations as not_connected', async () => {
    const res = await request.get('/api/integrations').set(auth())
    expect(res.status).toBe(200)
    const ids = res.body.integrations.map((i: { id: string }) => i.id)
    expect(ids.sort()).toEqual(['github', 'hubspot', 'jira', 'linear', 'monday', 'notion', 'slack'])
    for (const integration of res.body.integrations) {
      expect(integration.status).toBe('not_connected')
      expect(integration.connectedAt).toBeNull()
      expect(integration.lastTestAt).toBeNull()
      expect(integration.lastTestOk).toBeNull()
    }
  })

  it('includes default scopes covering all task types and agents', async () => {
    const res = await request.get('/api/integrations').set(auth())
    const github = res.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.scopes.taskTypes.sort()).toEqual(['daily', 'developmental', 'routine'])
    expect(github.scopes.agents.sort()).toEqual(['claude', 'omnimancer', 'opencode'])
  })

  it('never includes credential field values, only field metadata', async () => {
    await connectGithub('super-secret-pat-value')
    const res = await request.get('/api/integrations').set(auth())
    expect(JSON.stringify(res.body)).not.toContain('super-secret-pat-value')
    const github = res.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.fields).toEqual([{ key: 'token', label: expect.any(String), required: true }])
  })
})

// ── PUT /api/integrations/:id ──────────────────────────────────────────────────

describe('PUT /api/integrations/:id', () => {
  it('returns 404 for an unknown integration id', async () => {
    const res = await request.put('/api/integrations/bogus').set(auth()).send({ token: 'x' })
    expect(res.status).toBe(404)
  })

  it('rejects a partial credential update missing a required field', async () => {
    // Jira requires apiToken + siteUrl + email together.
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ apiToken: 'tok' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/siteUrl|email/)
  })

  it('rejects an empty-string field value', async () => {
    const res = await request.put('/api/integrations/github').set(auth()).send({ token: '   ' })
    expect(res.status).toBe(400)
  })

  it('connects an integration when all required fields are provided, without echoing secrets', async () => {
    const res = await connectGithub('my-pat-value')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(typeof res.body.connectedAt).toBe('string')
    expect(JSON.stringify(res.body)).not.toContain('my-pat-value')
  })

  it('rejects invalid scopes.taskTypes values', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ token: 'x', scopes: { taskTypes: ['not-a-real-type'] } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/taskTypes/)
  })

  it('rejects invalid scopes.agents values', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ token: 'x', scopes: { agents: ['not-a-real-agent'] } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/agents/)
  })

  it('persists a narrowed scope selection', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ token: 'x', scopes: { taskTypes: ['developmental'], agents: ['claude'] } })
    expect(res.status).toBe(200)
    expect(res.body.scopes).toEqual({ taskTypes: ['developmental'], agents: ['claude'] })
  })

  it('allows a scopes-only update on an already-connected integration', async () => {
    await connectGithub()
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ scopes: { taskTypes: ['daily'] } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(res.body.scopes.taskTypes).toEqual(['daily'])
  })

  it('clears a previous test result when credentials are replaced', async () => {
    await connectGithub()
    stubFetchJson(200, { login: 'octocat' })
    await request.post('/api/integrations/github/test').set(auth())

    const reconnect = await connectGithub('a-new-pat')
    expect(reconnect.body.lastTestAt).toBeNull()
    expect(reconnect.body.lastTestOk).toBeNull()
    // connectedAt is preserved across a credential rotation, not reset.
    expect(typeof reconnect.body.connectedAt).toBe('string')
  })
})

// ── POST /api/integrations/:id/test ────────────────────────────────────────────

describe('POST /api/integrations/:id/test', () => {
  it('returns 404 for an unknown integration id', async () => {
    const res = await request.post('/api/integrations/bogus/test').set(auth())
    expect(res.status).toBe(404)
  })

  it('returns 400 when the integration has no stored credentials yet', async () => {
    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not connected/i)
  })

  it('persists a successful result and reports ok:true', async () => {
    await connectGithub()
    stubFetchJson(200, { login: 'octocat' })

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe('connected')
    expect(typeof res.body.lastTestAt).toBe('string')
    expect(res.body.lastTestOk).toBe(true)
  })

  it('reflects the persisted success in a subsequent GET', async () => {
    await connectGithub()
    stubFetchJson(200, { login: 'octocat' })
    await request.post('/api/integrations/github/test').set(auth())

    const res = await request.get('/api/integrations').set(auth())
    const github = res.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.status).toBe('connected')
    expect(github.lastTestOk).toBe(true)
    expect(typeof github.lastTestAt).toBe('string')
  })

  it('persists a failed result, reports ok:false, and flips status to error', async () => {
    await connectGithub()
    stubFetchJson(401, { message: 'Bad credentials' })

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.status).toBe('error')
    expect(res.body.lastTestOk).toBe(false)

    const list = await request.get('/api/integrations').set(auth())
    const github = list.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.status).toBe('error')
  })

  it('handles Slack-style 200-with-ok:false auth failures as ok:false', async () => {
    await request.put('/api/integrations/slack').set(auth()).send({ botToken: 'xoxb-bad' })
    stubFetchJson(200, { ok: false, error: 'invalid_auth' })

    const res = await request.post('/api/integrations/slack/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.message).toMatch(/invalid_auth/)
  })

  it('reports ok:false (not a 5xx) when the provider is unreachable', async () => {
    await connectGithub()
    stubFetchReject(new Error('ECONNREFUSED'))

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.lastTestOk).toBe(false)
  })

  it('never includes the stored credential value in the test response', async () => {
    await connectGithub('super-secret-pat-value')
    stubFetchJson(401, {})
    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(JSON.stringify(res.body)).not.toContain('super-secret-pat-value')
  })
})

// ── DELETE /api/integrations/:id ───────────────────────────────────────────────

describe('DELETE /api/integrations/:id', () => {
  it('returns 404 for an unknown integration id', async () => {
    const res = await request.delete('/api/integrations/bogus').set(auth())
    expect(res.status).toBe(404)
  })

  it('removes credentials and resets metadata to not_connected', async () => {
    await connectGithub()
    stubFetchJson(200, { login: 'octocat' })
    await request.post('/api/integrations/github/test').set(auth())

    const res = await request.delete('/api/integrations/github').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('not_connected')
    expect(res.body.connectedAt).toBeNull()
    expect(res.body.lastTestAt).toBeNull()
    expect(res.body.lastTestOk).toBeNull()
  })

  it('is idempotent — disconnecting an already-disconnected integration succeeds', async () => {
    const res = await request.delete('/api/integrations/github').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('not_connected')
  })

  it('requires reconnecting before a subsequent test can run', async () => {
    await connectGithub()
    await request.delete('/api/integrations/github').set(auth())

    const res = await request.post('/api/integrations/github/test').set(auth())
    expect(res.status).toBe(400)
  })
})
