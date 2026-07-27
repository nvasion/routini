/**
 * HTTP-level tests for PUT /api/integrations/:id
 * (server/src/routes/integrations.ts), exercised through the assembled
 * Express app with supertest.
 *
 * Coverage:
 *   – Authentication is required (401 without a token).
 *   – CSRF is enforced for cookie-based auth, bypassed for Bearer auth.
 *   – 404 for an unknown integration id.
 *   – Per-integration required-field validation (400 on missing/blank fields,
 *     unknown fields, non-string values, over-length values).
 *   – Jira's siteUrl is validated: must be a valid https URL and must not
 *     resolve to a private/loopback host (SSRF guard).
 *   – A successful PUT persists credentials write-only: they are never echoed
 *     back in the response, and the credential store now holds the
 *     `integration_<id>_<field>` keys.
 *   – Scoping (taskTypes/agents) defaults to "all" when omitted, accepts a
 *     restricted subset, rejects invalid values, and honours an explicit
 *     empty list.
 *   – connectedAt is set once and preserved across a later reconnect; a
 *     credential update clears any previously persisted test result.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb } from '../server/src/db/index.js'
import { getCredentialSecret } from '../server/src/services/credentials.js'
import { integrationCredentialKey, integrationMetadata } from '../server/src/routes/integrations.js'

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
  integrationMetadata.clear()
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects an unauthenticated PUT with 401', async () => {
    const res = await request
      .put('/api/integrations/github')
      .send({ credentials: { token: 'ghp_x' } })
    expect(res.status).toBe(401)
  })
})

// ── CSRF ──────────────────────────────────────────────────────────────────────

describe('CSRF enforcement with cookie auth', () => {
  function makeAgent() {
    return supertest.agent(app)
  }

  async function loginWithCookie(agent: ReturnType<typeof makeAgent>) {
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@routini.dev', password: 'changeme' })
    return res.body.csrfToken as string
  }

  it('returns 403 with no X-CSRF-Token header', async () => {
    const agent = makeAgent()
    await loginWithCookie(agent)
    const res = await agent
      .put('/api/integrations/github')
      .send({ credentials: { token: 'ghp_x' } })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('succeeds with the correct X-CSRF-Token header', async () => {
    const agent = makeAgent()
    const csrfToken = await loginWithCookie(agent)
    const res = await agent
      .put('/api/integrations/github')
      .set('x-csrf-token', csrfToken)
      .send({ credentials: { token: 'ghp_x' } })
    expect(res.status).toBe(200)
  })
})

// ── Unknown integration ────────────────────────────────────────────────────────

describe('PUT /api/integrations/:id – unknown integration', () => {
  it('returns 404 for an id not in the catalog', async () => {
    const res = await request
      .put('/api/integrations/bogus')
      .set(auth())
      .send({ credentials: { token: 'x' } })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Unknown integration/)
  })
})

// ── Required-field validation ─────────────────────────────────────────────────

describe('PUT /api/integrations/:id – required-field validation', () => {
  it('rejects a missing required field with 400', async () => {
    const res = await request.put('/api/integrations/github').set(auth()).send({ credentials: {} })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Missing required field.*token/)
  })

  it('rejects a blank required field with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: '   ' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Missing required field/)
  })

  it('rejects multi-field integrations missing any one required field', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { siteUrl: 'https://acme.atlassian.net', email: 'a@acme.com' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/apiToken/)
  })

  it('accepts all required fields for a multi-field integration', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({
        credentials: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'a@acme.com',
          apiToken: 'jira-token-123',
        },
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
  })

  it('rejects an unknown credential field with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x', extra: 'nope' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown credential field/)
  })

  it('rejects a non-string field value with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 12345 } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must be a string/)
  })

  it('rejects an over-length field value with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'x'.repeat(5000) } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at most/)
  })

  it('rejects a non-object credentials payload with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: 'not-an-object' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must be an object/)
  })
})

// ── Jira siteUrl SSRF guard ────────────────────────────────────────────────────

describe('PUT /api/integrations/jira – siteUrl validation', () => {
  const validFields = { email: 'a@acme.com', apiToken: 'jira-token-123' }

  it('rejects a non-https siteUrl with 400', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { ...validFields, siteUrl: 'http://acme.atlassian.net' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/https/)
  })

  it('rejects a malformed siteUrl with 400', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { ...validFields, siteUrl: 'not a url' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/valid URL/)
  })

  it('rejects a siteUrl resolving to a loopback host with 400', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { ...validFields, siteUrl: 'https://localhost' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/private or loopback/)
  })

  it('rejects a siteUrl resolving to a private IP literal with 400', async () => {
    const res = await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({ credentials: { ...validFields, siteUrl: 'https://192.168.1.5' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/private or loopback/)
  })
})

// ── Write-only persistence ─────────────────────────────────────────────────────

describe('PUT /api/integrations/:id – write-only credential persistence', () => {
  it('never echoes the credential value back in the response', async () => {
    const res = await request
      .put('/api/integrations/linear')
      .set(auth())
      .send({ credentials: { apiKey: 'lin_super_secret_value' } })

    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('lin_super_secret_value')
  })

  it('persists each field to the encrypted credential store under integration_<id>_<field>', async () => {
    await request
      .put('/api/integrations/jira')
      .set(auth())
      .send({
        credentials: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'a@acme.com',
          apiToken: 'jira-secret-abc',
        },
      })

    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'siteUrl'))).toBe(
      'https://acme.atlassian.net',
    )
    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'email'))).toBe('a@acme.com')
    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'apiToken'))).toBe(
      'jira-secret-abc',
    )
  })

  it('replaces a previously stored value on a subsequent PUT', async () => {
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'first' } })
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'second' } })

    expect(getCredentialSecret(null, integrationCredentialKey('github', 'token'))).toBe('second')
  })
})

// ── Scoping ────────────────────────────────────────────────────────────────────

describe('PUT /api/integrations/:id – scoping', () => {
  it('defaults scopes to all task types and all agents when omitted', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' } })

    expect(res.status).toBe(200)
    expect(res.body.scopes.taskTypes.sort()).toEqual(['daily', 'developmental', 'routine'])
    expect(res.body.scopes.agents.sort()).toEqual(['claude', 'omnimancer', 'opencode'])
  })

  it('accepts a restricted scope subset', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({
        credentials: { token: 'ghp_x' },
        scopes: { taskTypes: ['developmental'], agents: ['claude'] },
      })

    expect(res.status).toBe(200)
    expect(res.body.scopes.taskTypes).toEqual(['developmental'])
    expect(res.body.scopes.agents).toEqual(['claude'])
  })

  it('honours an explicit empty scope list ("none")', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' }, scopes: { taskTypes: [], agents: [] } })

    expect(res.status).toBe(200)
    expect(res.body.scopes.taskTypes).toEqual([])
    expect(res.body.scopes.agents).toEqual([])
  })

  it('rejects an invalid task type in scopes with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' }, scopes: { taskTypes: ['bogus'] } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scopes\.taskTypes/)
  })

  it('rejects an invalid agent in scopes with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' }, scopes: { agents: ['not-an-agent'] } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scopes\.agents/)
  })

  it('rejects a non-array scopes list with 400', async () => {
    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_x' }, scopes: { taskTypes: 'daily' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must be an array/)
  })
})

// ── connectedAt / lastTest reset semantics ─────────────────────────────────────

describe('PUT /api/integrations/:id – status metadata', () => {
  it('sets connectedAt on first connect and preserves it across a later update', async () => {
    const first = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_first' } })
    expect(first.body.connectedAt).toEqual(expect.any(String))

    const second = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_second' }, scopes: { taskTypes: ['daily'] } })

    expect(second.body.connectedAt).toBe(first.body.connectedAt)
    expect(second.body.scopes.taskTypes).toEqual(['daily'])
  })

  it('clears a previously persisted test result when credentials are updated', async () => {
    await request.put('/api/integrations/github').set(auth()).send({ credentials: { token: 'ghp_x' } })

    // Simulate a prior successful test (normally set by POST /:id/test).
    const meta = integrationMetadata.get('github')!
    integrationMetadata.set('github', { ...meta, lastTestAt: '2026-01-01T00:00:00.000Z', lastTestOk: true })

    const res = await request
      .put('/api/integrations/github')
      .set(auth())
      .send({ credentials: { token: 'ghp_y' } })

    expect(res.body.lastTestAt).toBeNull()
    expect(res.body.lastTestOk).toBeNull()
  })
})
