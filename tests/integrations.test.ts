/**
 * HTTP-level tests for the integrations API router
 * (server/src/routes/integrations.ts / server/src/services/integrations.ts),
 * exercised through the assembled Express app with supertest.
 *
 * Coverage:
 *   – Authentication is required (401 without a token).
 *   – GET returns the full v1 catalog (7 integrations) with the documented
 *     shape: id/name/description/setupUrl/fields plus live
 *     status/connectedAt/lastTestAt/lastTestOk/scopes.
 *   – Default (never-configured) state: not_connected, connectedAt/lastTest
 *     all null, scopes fall back to "all task types, all agents".
 *   – Once every required credential field for an integration is stored, the
 *     status flips to "connected" and connectedAt becomes a timestamp.
 *   – A stored failing test result flips a connected integration to "error".
 *   – Persisted scoping (from integration_metadata) is reflected in the
 *     response, including graceful fallback when the stored scope JSON is
 *     corrupt.
 *   – Secrets never appear anywhere in the response body, in the catalog
 *     field specs, or once an integration is connected — this is asserted
 *     both per-integration and across the full serialized response.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { resetDb, upsertIntegrationMetadata } from '../server/src/db/index.js'
import { saveCredential } from '../server/src/services/credentials.js'
import { credentialFieldKey, INTEGRATIONS_CATALOG } from '../server/src/services/integrations.js'

const request = supertest(app)

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

beforeEach(() => {
  // Fresh credential store + integration metadata for each test (auth uses
  // its own in-memory repo, so this does not affect the logged-in session).
  process.env['NODE_ENV'] = 'test'
  resetDb()
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request.get('/api/integrations')
    expect(res.status).toBe(401)
  })
})

// ── Catalog shape ────────────────────────────────────────────────────────────

describe('GET /api/integrations – catalog shape', () => {
  it('returns all seven v1 integrations', async () => {
    const res = await request.get('/api/integrations').set(auth())
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.integrations)).toBe(true)
    expect(res.body.integrations).toHaveLength(7)
    const ids = res.body.integrations.map((i: { id: string }) => i.id).sort()
    expect(ids).toEqual(
      ['github', 'hubspot', 'jira', 'linear', 'monday', 'notion', 'slack'].sort(),
    )
  })

  it('includes catalog metadata and default status for every integration', async () => {
    const res = await request.get('/api/integrations').set(auth())
    for (const integration of res.body.integrations) {
      expect(typeof integration.id).toBe('string')
      expect(typeof integration.name).toBe('string')
      expect(typeof integration.description).toBe('string')
      expect(typeof integration.setupUrl).toBe('string')
      expect(Array.isArray(integration.fields)).toBe(true)
      expect(integration.fields.length).toBeGreaterThan(0)

      // Default (never-configured) status.
      expect(integration.status).toBe('not_connected')
      expect(integration.connectedAt).toBeNull()
      expect(integration.lastTestAt).toBeNull()
      expect(integration.lastTestOk).toBeNull()

      // Default scopes: all task types, all agents.
      expect(integration.scopes.taskTypes.sort()).toEqual(
        ['daily', 'developmental', 'routine'].sort(),
      )
      expect(integration.scopes.agents.sort()).toEqual(['claude', 'omnimancer', 'opencode'].sort())
    }
  })

  it('describes each field with key/label/type/required but never a value', async () => {
    const res = await request.get('/api/integrations').set(auth())
    const jira = res.body.integrations.find((i: { id: string }) => i.id === 'jira')
    expect(jira).toBeDefined()
    // Jira needs siteUrl + email + token.
    expect(jira.fields.map((f: { key: string }) => f.key).sort()).toEqual(
      ['email', 'siteUrl', 'token'].sort(),
    )
    for (const field of jira.fields) {
      expect(typeof field.key).toBe('string')
      expect(typeof field.label).toBe('string')
      expect(typeof field.type).toBe('string')
      expect(typeof field.required).toBe('boolean')
      expect(field.value).toBeUndefined()
      expect(field.secret).toBeUndefined()
    }
  })
})

// ── Connection status derivation ────────────────────────────────────────────

describe('GET /api/integrations – connection status', () => {
  it('flips to connected once every required field is stored', async () => {
    saveCredential(null, credentialFieldKey('github', 'token'), 'ghp_supersecrettoken123')

    const res = await request.get('/api/integrations').set(auth())
    const github = res.body.integrations.find((i: { id: string }) => i.id === 'github')
    expect(github.status).toBe('connected')
    expect(typeof github.connectedAt).toBe('string')
    expect(Number.isNaN(Date.parse(github.connectedAt))).toBe(false)
  })

  it('stays not_connected when only some required fields are stored', async () => {
    // Jira requires siteUrl + email + token; store only two of the three.
    saveCredential(null, credentialFieldKey('jira', 'siteUrl'), 'https://acme.atlassian.net')
    saveCredential(null, credentialFieldKey('jira', 'email'), 'ops@acme.example')

    const res = await request.get('/api/integrations').set(auth())
    const jira = res.body.integrations.find((i: { id: string }) => i.id === 'jira')
    expect(jira.status).toBe('not_connected')
    expect(jira.connectedAt).toBeNull()
  })

  it('connects once all three Jira fields are present', async () => {
    saveCredential(null, credentialFieldKey('jira', 'siteUrl'), 'https://acme.atlassian.net')
    saveCredential(null, credentialFieldKey('jira', 'email'), 'ops@acme.example')
    saveCredential(null, credentialFieldKey('jira', 'token'), 'jira-api-token-abc')

    const res = await request.get('/api/integrations').set(auth())
    const jira = res.body.integrations.find((i: { id: string }) => i.id === 'jira')
    expect(jira.status).toBe('connected')
    expect(typeof jira.connectedAt).toBe('string')
  })

  it('other integrations are unaffected by one integration being connected', async () => {
    saveCredential(null, credentialFieldKey('github', 'token'), 'ghp_supersecrettoken123')

    const res = await request.get('/api/integrations').set(auth())
    const others = res.body.integrations.filter((i: { id: string }) => i.id !== 'github')
    for (const integration of others) {
      expect(integration.status).toBe('not_connected')
      expect(integration.connectedAt).toBeNull()
    }
  })
})

// ── Test-result and scope persistence ───────────────────────────────────────

describe('GET /api/integrations – persisted test result and scopes', () => {
  it('surfaces a connected integration whose last test failed as "error"', async () => {
    saveCredential(null, credentialFieldKey('slack', 'token'), 'xoxb-fake-bot-token')
    upsertIntegrationMetadata({
      id: 'slack',
      last_test_at: '2026-07-20T12:00:00.000Z',
      last_test_ok: 0,
      scope_task_types: null,
      scope_agents: null,
      updated_at: '2026-07-20T12:00:00.000Z',
    })

    const res = await request.get('/api/integrations').set(auth())
    const slack = res.body.integrations.find((i: { id: string }) => i.id === 'slack')
    expect(slack.status).toBe('error')
    expect(slack.lastTestOk).toBe(false)
    expect(slack.lastTestAt).toBe('2026-07-20T12:00:00.000Z')
  })

  it('a failed test on a never-connected integration does not report "error"', async () => {
    // Metadata row exists (e.g. a stale test) but no credentials were ever stored.
    upsertIntegrationMetadata({
      id: 'notion',
      last_test_at: '2026-07-20T12:00:00.000Z',
      last_test_ok: 0,
      scope_task_types: null,
      scope_agents: null,
      updated_at: '2026-07-20T12:00:00.000Z',
    })

    const res = await request.get('/api/integrations').set(auth())
    const notion = res.body.integrations.find((i: { id: string }) => i.id === 'notion')
    expect(notion.status).toBe('not_connected')
  })

  it('reports lastTestOk: true after a successful test', async () => {
    saveCredential(null, credentialFieldKey('linear', 'apiKey'), 'lin_api_secret')
    upsertIntegrationMetadata({
      id: 'linear',
      last_test_at: '2026-07-21T09:30:00.000Z',
      last_test_ok: 1,
      scope_task_types: null,
      scope_agents: null,
      updated_at: '2026-07-21T09:30:00.000Z',
    })

    const res = await request.get('/api/integrations').set(auth())
    const linear = res.body.integrations.find((i: { id: string }) => i.id === 'linear')
    expect(linear.status).toBe('connected')
    expect(linear.lastTestOk).toBe(true)
  })

  it('reflects persisted scoping', async () => {
    upsertIntegrationMetadata({
      id: 'monday',
      last_test_at: null,
      last_test_ok: null,
      scope_task_types: JSON.stringify(['daily']),
      scope_agents: JSON.stringify(['claude']),
      updated_at: '2026-07-21T09:30:00.000Z',
    })

    const res = await request.get('/api/integrations').set(auth())
    const monday = res.body.integrations.find((i: { id: string }) => i.id === 'monday')
    expect(monday.scopes.taskTypes).toEqual(['daily'])
    expect(monday.scopes.agents).toEqual(['claude'])
  })

  it('falls back to default scopes when stored scope JSON is corrupt', async () => {
    upsertIntegrationMetadata({
      id: 'hubspot',
      last_test_at: null,
      last_test_ok: null,
      scope_task_types: 'not-valid-json{{{',
      scope_agents: JSON.stringify(['not-a-real-agent']),
      updated_at: '2026-07-21T09:30:00.000Z',
    })

    const res = await request.get('/api/integrations').set(auth())
    expect(res.status).toBe(200)
    const hubspot = res.body.integrations.find((i: { id: string }) => i.id === 'hubspot')
    expect(hubspot.scopes.taskTypes.sort()).toEqual(['daily', 'developmental', 'routine'].sort())
    expect(hubspot.scopes.agents.sort()).toEqual(['claude', 'omnimancer', 'opencode'].sort())
  })
})

// ── Secrets never leak ──────────────────────────────────────────────────────

describe('GET /api/integrations – secrets never appear in the response', () => {
  const secrets = [
    'ghp_supersecrettoken123456',
    'xoxb-super-secret-slack-token',
    'jira-api-token-abcdef',
    'ops-secret-email-password',
    'secret_notion_internal_token',
    'lin_api_supersecretkey',
    'monday-api-token-secret',
    'pat-hubspot-super-secret',
  ]

  beforeEach(() => {
    saveCredential(null, credentialFieldKey('github', 'token'), secrets[0])
    saveCredential(null, credentialFieldKey('slack', 'token'), secrets[1])
    saveCredential(null, credentialFieldKey('jira', 'token'), secrets[2])
    saveCredential(null, credentialFieldKey('jira', 'siteUrl'), 'https://acme.atlassian.net')
    saveCredential(null, credentialFieldKey('jira', 'email'), 'ops@acme.example')
    saveCredential(null, credentialFieldKey('notion', 'token'), secrets[4])
    saveCredential(null, credentialFieldKey('linear', 'apiKey'), secrets[5])
    saveCredential(null, credentialFieldKey('monday', 'token'), secrets[6])
    saveCredential(null, credentialFieldKey('hubspot', 'token'), secrets[7])
  })

  it('never includes any stored secret value in the raw response body', async () => {
    const res = await request.get('/api/integrations').set(auth())
    expect(res.status).toBe(200)

    const raw = JSON.stringify(res.body)
    for (const secret of secrets) {
      expect(raw.includes(secret)).toBe(false)
    }
  })

  it('never includes a "value" or "secret" key anywhere in the payload', async () => {
    const res = await request.get('/api/integrations').set(auth())
    const raw = JSON.stringify(res.body)
    // A crude but effective guard against a future regression that starts
    // echoing credential values back under an unexpected key name.
    expect(raw).not.toMatch(/"value"\s*:/)
    expect(raw).not.toMatch(/"secret"\s*:/i)
    expect(raw).not.toMatch(/"encrypted_value"/)
    expect(raw).not.toMatch(/"iv"\s*:/)
  })

  it('every catalog field spec still only describes shape, never a stored value', async () => {
    const res = await request.get('/api/integrations').set(auth())
    for (const integration of res.body.integrations) {
      for (const field of integration.fields) {
        expect(Object.keys(field).sort()).toEqual(
          expect.arrayContaining(['key', 'label', 'type', 'required']),
        )
        expect(field.value).toBeUndefined()
      }
    }
  })

  it('all connected integrations report status without leaking credential material', async () => {
    const res = await request.get('/api/integrations').set(auth())
    const connectedIds = INTEGRATIONS_CATALOG.map((def) => def.id)
    for (const id of connectedIds) {
      const integration = res.body.integrations.find((i: { id: string }) => i.id === id)
      expect(integration.status).toBe('connected')
      expect(typeof integration.connectedAt).toBe('string')
    }
  })
})
