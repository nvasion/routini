/**
 * HTTP-level tests for the integrations API router
 * (server/src/routes/integrations.ts), exercised through the assembled
 * Express app with supertest.
 *
 * Only DELETE /api/integrations/:id (disconnect) is implemented by this
 * router so far — GET (catalog+status), PUT (save credentials/scopes), and
 * POST /:id/test are separate PRD tasks. These tests therefore seed
 * connected-integration state directly through the credential store and the
 * integration_metadata table (the same primitives PUT will use) rather than
 * through the API, then assert DELETE tears it all back down.
 *
 * Coverage:
 *   – Authentication is required (401 without a token).
 *   – DELETE removes every credential field for a multi-field integration (Jira).
 *   – DELETE removes the single credential field for a single-field integration.
 *   – DELETE resets persisted metadata (integration_metadata row is gone).
 *   – DELETE is idempotent: disconnecting an already-disconnected/never-connected
 *     integration still returns 200 with the default reset view.
 *   – DELETE never echoes any secret value back in the response.
 *   – DELETE on an unknown integration id returns 404 and touches no state.
 *   – CSRF is enforced for cookie-authenticated requests and bypassed for Bearer auth.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb } from '../server/src/db/index.js'
import { saveCredential, getCredentialSecret } from '../server/src/services/credentials.js'
import { upsertIntegrationMetadata, getIntegrationMetadata } from '../server/src/db/index.js'
import { integrationCredentialKey } from '../server/src/routes/integrations.js'

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

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

/** Seeds a "connected" jira integration: 3 credential fields + a metadata row. */
function seedConnectedJira() {
  saveCredential(null, integrationCredentialKey('jira', 'apiToken'), 'jira-secret-token')
  saveCredential(null, integrationCredentialKey('jira', 'siteUrl'), 'https://acme.atlassian.net')
  saveCredential(null, integrationCredentialKey('jira', 'email'), 'ops@acme.example')
  upsertIntegrationMetadata({
    id: 'jira',
    status: 'connected',
    connected_at: '2024-01-01T00:00:00.000Z',
    last_test_at: '2024-01-02T00:00:00.000Z',
    last_test_ok: 1,
    scopes: JSON.stringify({ taskTypes: ['developmental'], agents: ['claude'] }),
    updated_at: '2024-01-02T00:00:00.000Z',
  })
}

/** Seeds a "connected" github integration: single credential field + metadata row. */
function seedConnectedGithub() {
  saveCredential(null, integrationCredentialKey('github', 'token'), 'ghp_supersecrettoken')
  upsertIntegrationMetadata({
    id: 'github',
    status: 'connected',
    connected_at: '2024-01-01T00:00:00.000Z',
    last_test_at: null,
    last_test_ok: null,
    scopes: JSON.stringify({ taskTypes: ['daily', 'routine'], agents: ['opencode'] }),
    updated_at: '2024-01-01T00:00:00.000Z',
  })
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects unauthenticated DELETE requests with 401', async () => {
    const res = await request.delete('/api/integrations/github')
    expect(res.status).toBe(401)
  })
})

// ── DELETE /api/integrations/:id ──────────────────────────────────────────────

describe('DELETE /api/integrations/:id', () => {
  it('removes every credential field for a multi-field integration (jira)', async () => {
    seedConnectedJira()

    const res = await request.delete('/api/integrations/jira').set(auth())

    expect(res.status).toBe(200)
    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'apiToken'))).toBeUndefined()
    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'siteUrl'))).toBeUndefined()
    expect(getCredentialSecret(null, integrationCredentialKey('jira', 'email'))).toBeUndefined()
  })

  it('removes the credential field for a single-field integration (github)', async () => {
    seedConnectedGithub()

    const res = await request.delete('/api/integrations/github').set(auth())

    expect(res.status).toBe(200)
    expect(getCredentialSecret(null, integrationCredentialKey('github', 'token'))).toBeUndefined()
  })

  it('resets persisted metadata back to the default disconnected state', async () => {
    seedConnectedGithub()

    const res = await request.delete('/api/integrations/github').set(auth())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'github',
      status: 'not_connected',
      connectedAt: null,
      lastTestAt: null,
      lastTestOk: null,
    })
    expect(res.body.scopes).toBeDefined()
    // The metadata row itself is removed — absence is the canonical "never
    // connected" state read by the (separately implemented) GET endpoint.
    expect(getIntegrationMetadata('github')).toBeUndefined()
  })

  it('never echoes any secret value back in the response', async () => {
    seedConnectedJira()

    const res = await request.delete('/api/integrations/jira').set(auth())

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('jira-secret-token')
    expect(serialized).not.toContain('acme.atlassian.net')
    expect(serialized).not.toContain('ops@acme.example')
  })

  it('is idempotent: disconnecting a never-connected integration still returns 200', async () => {
    const res = await request.delete('/api/integrations/linear').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('not_connected')
  })

  it('is idempotent: disconnecting twice in a row succeeds both times', async () => {
    seedConnectedGithub()
    const first = await request.delete('/api/integrations/github').set(auth())
    const second = await request.delete('/api/integrations/github').set(auth())
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.status).toBe('not_connected')
  })

  it('does not disturb a different integration\'s stored credentials', async () => {
    seedConnectedJira()
    seedConnectedGithub()

    await request.delete('/api/integrations/jira').set(auth())

    expect(getCredentialSecret(null, integrationCredentialKey('github', 'token'))).toBe(
      'ghp_supersecrettoken',
    )
    expect(getIntegrationMetadata('github')?.status).toBe('connected')
  })

  it('returns 404 for an unknown integration id', async () => {
    const res = await request.delete('/api/integrations/not-a-real-integration').set(auth())
    expect(res.status).toBe(404)
  })

  it('touches no state when the integration id is unknown', async () => {
    seedConnectedGithub()
    await request.delete('/api/integrations/bogus').set(auth())

    expect(getCredentialSecret(null, integrationCredentialKey('github', 'token'))).toBe(
      'ghp_supersecrettoken',
    )
    expect(getIntegrationMetadata('github')?.status).toBe('connected')
  })
})

// ── CSRF ──────────────────────────────────────────────────────────────────────

describe('DELETE /api/integrations/:id – CSRF enforcement with cookie auth', () => {
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
    seedConnectedGithub()
    const agent = makeAgent()
    await loginWithCookie(agent)

    const res = await agent.delete('/api/integrations/github')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  it('returns 200 with the correct X-CSRF-Token', async () => {
    seedConnectedGithub()
    const agent = makeAgent()
    const csrfToken = await loginWithCookie(agent)

    const res = await agent.delete('/api/integrations/github').set('x-csrf-token', csrfToken)
    expect(res.status).toBe(200)
  })

  it('succeeds with Bearer auth and no X-CSRF-Token header', async () => {
    seedConnectedGithub()
    const res = await request.delete('/api/integrations/github').set(auth())
    expect(res.status).toBe(200)
  })
})
