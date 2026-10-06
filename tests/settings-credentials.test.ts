// Org settings (AI endpoints, notifications, write-only keys) and the generic credential store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { getEndpointKey } from '../server/src/repos/settings'

let t: TestApp
let u: TestUser
const base = () => `/api/orgs/${u.orgSlug}`

beforeEach(async () => {
  t = await makeTestApp()
  u = await t.signup('admin@example.com')
})
afterEach(() => t.close())

describe('settings', () => {
  it('returns defaults for a new org', async () => {
    const res = await u.get(`${base()}/settings`)
    expect(res.status).toBe(200)
    expect(res.body.ai.defaultAgent).toBe('claude')
    expect(res.body.ai.agents.claude).toEqual({ endpoint: 'anthropic', model: '' })
    expect(res.body.notifications.enabled).toBe(false)
    expect(res.body.endpointKeys.anthropic).toBe(false)
    expect(res.body.endpointKeys).not.toHaveProperty('gateway')
  })

  it('persists a valid AI patch', async () => {
    const res = await u.put(`${base()}/settings`, {
      ai: { defaultAgent: 'omnimancer', agents: { claude: { endpoint: 'gateway', gatewayUrl: 'http://gw:8080', model: 'claude-opus-5-5' } } },
    })
    expect(res.status).toBe(200)
    expect(res.body.ai.defaultAgent).toBe('omnimancer')
    expect(res.body.ai.agents.claude).toEqual({ endpoint: 'gateway', gatewayUrl: 'http://gw:8080', model: 'claude-opus-5-5' })
    expect((await u.get(`${base()}/settings`)).body.ai.agents.claude.endpoint).toBe('gateway')
  })

  it('rejects an invalid patch without applying any part of it', async () => {
    const res = await u.put(`${base()}/settings`, {
      ai: { defaultAgent: 'opencode' },
      endpointApiKeys: { anthropic: 'sk-ant-real-key-123', notAnEndpoint: 'x' },
    })
    expect(res.status).toBe(400)
    const after = (await u.get(`${base()}/settings`)).body
    expect(after.ai.defaultAgent).toBe('claude')
    expect(after.endpointKeys.anthropic).toBe(false)
  })

  it('enforces per-agent endpoint allow-lists and gateway URLs', async () => {
    expect((await u.put(`${base()}/settings`, { ai: { agents: { opencode: { endpoint: 'aws-bedrock' } } } })).status).toBe(400)
    expect((await u.put(`${base()}/settings`, { ai: { agents: { claude: { endpoint: 'gateway' } } } })).status).toBe(400)
    expect((await u.put(`${base()}/settings`, { ai: { agents: { nope: { endpoint: 'anthropic' } } } })).status).toBe(400)
  })

  it('stores endpoint keys write-only', async () => {
    const secret = 'sk-ant-api03-very-secret-value'
    const res = await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: secret } })
    expect(res.status).toBe(200)
    expect(res.body.endpointKeys.anthropic).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(secret)
    expect(JSON.stringify((await u.get(`${base()}/settings`)).body)).not.toContain(secret)
    expect(await t.ctx.db.org(u.orgId, (q) => getEndpointKey(q, t.ctx.box, u.orgId, 'anthropic'))).toBe(secret)
    // ai.* keys belong to settings and are hidden from the generic credential list.
    expect((await u.get(`${base()}/credentials`)).body.credentials).toEqual([])
  })

  it('validates notifications', async () => {
    expect((await u.put(`${base()}/settings`, { notifications: { enabled: true } })).status).toBe(400)
    expect((await u.put(`${base()}/settings`, { notifications: { recipientEmail: 'bad' } })).status).toBe(400)
    const ok = await u.put(`${base()}/settings`, { notifications: { enabled: true, recipientEmail: 'ops@example.com', notifyOnSuccess: true } })
    expect(ok.status).toBe(200)
    expect(ok.body.notifications).toEqual({ enabled: true, recipientEmail: 'ops@example.com', notifyOnSuccess: true, notifyOnFailure: true })
  })

  it('settings are per org', async () => {
    await u.put(`${base()}/settings`, { ai: { defaultAgent: 'opencode' } })
    const v = await t.signup('else@example.com')
    expect((await v.get(`/api/orgs/${v.orgSlug}/settings`)).body.ai.defaultAgent).toBe('claude')
  })
})

describe('credentials', () => {
  it('stores, lists metadata only, overwrites and deletes', async () => {
    const secret = 'ssh-private-key-material'
    const put = await u.put(`${base()}/credentials/ssh.prod`, { value: secret })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ key: 'ssh.prod', stored: true })
    await u.put(`${base()}/credentials/ssh.prod`, { value: secret + '-v2' })
    const list = await u.get(`${base()}/credentials`)
    expect(list.body.credentials).toEqual([{ key: 'ssh.prod', createdAt: expect.any(String), updatedAt: expect.any(String) }])
    expect(JSON.stringify(list.body)).not.toContain(secret)
    expect((await u.del(`${base()}/credentials/ssh.prod`)).status).toBe(204)
    expect((await u.del(`${base()}/credentials/ssh.prod`)).status).toBe(404)
  })

  it('rejects bad keys, empty values and reserved prefixes', async () => {
    expect((await u.put(`${base()}/credentials/Bad Key`, { value: 'v' })).status).toBe(400)
    expect((await u.put(`${base()}/credentials/ok`, { value: '' })).status).toBe(400)
    expect((await u.put(`${base()}/credentials/ok`, {})).status).toBe(400)
    expect((await u.put(`${base()}/credentials/integration.github.token`, { value: 'v' })).status).toBe(400)
    expect((await u.put(`${base()}/credentials/ai.key.anthropic`, { value: 'v' })).status).toBe(400)
  })
})
