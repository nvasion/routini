// Org-scoped integrations: connect, scopes, live test, disconnect, agent env injection.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { getScopedIntegrationEnv } from '../server/src/repos/integrations'
import type { FetchFn } from '../server/src/integrations/providers'

let t: TestApp
let u: TestUser
let fetchStatus = 200
const fetchCalls: string[] = []
const fakeFetch: FetchFn = async (url) => {
  fetchCalls.push(url)
  return new Response(JSON.stringify({ ok: fetchStatus === 200 }), { status: fetchStatus })
}
const base = () => `/api/orgs/${u.orgSlug}/integrations`
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

beforeEach(async () => {
  fetchStatus = 200
  fetchCalls.length = 0
  t = await makeTestApp({ providerCtx: { fetchImpl: fakeFetch, ssrfCheck: async () => true } })
  u = await t.signup('int@example.com')
})
afterEach(() => t.close())

const github = (body: { integrations: Array<{ id: string }> }) => body.integrations.find((i) => i.id === 'github') as Record<string, unknown>

describe('integrations', () => {
  it('lists the catalog, all not connected, with field metadata but no values', async () => {
    const res = await u.get(base())
    expect(res.status).toBe(200)
    expect(res.body.integrations.map((i: { id: string }) => i.id)).toEqual(['github', 'slack', 'jira', 'notion', 'linear', 'monday', 'hubspot', 'factory'])
    expect(res.body.integrations.every((i: { status: string }) => i.status === 'not_connected')).toBe(true)
    expect(github(res.body)['fields']).toEqual([{ key: 'token', label: 'Personal access token', secret: true }])
  })

  it('first connect requires every field; later saves can be partial', async () => {
    expect((await u.put(`${base()}/jira`, { credentials: { apiToken: 'x' } })).status).toBe(400)
    const ok = await u.put(`${base()}/jira`, { credentials: { siteUrl: 'https://acme.atlassian.net', email: 'a@acme.com', apiToken: 'tok' } })
    expect(ok.status).toBe(200)
    expect(ok.body.integration.status).toBe('connected')
    expect((await u.put(`${base()}/jira`, { credentials: { apiToken: 'tok2' } })).status).toBe(200)
  })

  it('rejects unknown integrations, fields and scopes', async () => {
    expect((await u.put(`${base()}/nope`, { credentials: { token: 'x' } })).status).toBe(404)
    expect((await u.put(`${base()}/github`, { credentials: { password: 'x' } })).status).toBe(400)
    expect((await u.put(`${base()}/github`, { scopes: { agents: ['skynet'] } })).status).toBe(400)
    expect((await u.put(`${base()}/github`, {})).status).toBe(400)
  })

  it('never returns a stored secret', async () => {
    const responses = [
      await u.put(`${base()}/github`, { credentials: { token: TOKEN } }),
      await u.get(base()),
      await u.post(`${base()}/github/test`),
      await u.put(`${base()}/github`, { scopes: { agents: ['claude'] } }),
    ]
    for (const r of responses) expect(JSON.stringify(r.body)).not.toContain(TOKEN)
  })

  it('live test persists its result and flips the status to error on failure', async () => {
    expect((await u.post(`${base()}/github/test`)).status).toBe(400) // not connected yet
    await u.put(`${base()}/github`, { credentials: { token: TOKEN } })
    const pass = await u.post(`${base()}/github/test`)
    expect(pass.body).toMatchObject({ ok: true, integration: { status: 'connected', lastTestOk: true } })
    expect(fetchCalls).toEqual(['https://api.github.com/user'])
    fetchStatus = 401
    const fail = await u.post(`${base()}/github/test`)
    expect(fail.body).toMatchObject({ ok: false, integration: { status: 'error', lastTestOk: false } })
    expect(github((await u.get(base())).body)['status']).toBe('error')
  })

  it('disconnect removes secrets and status', async () => {
    await u.put(`${base()}/github`, { credentials: { token: TOKEN } })
    expect((await u.del(`${base()}/github`)).body.integration.status).toBe('not_connected')
    const keys = await t.ctx.db.system((q) => q.query<{ key: string }>('SELECT key FROM credentials'))
    expect(keys).toEqual([])
  })

  it('agent env includes only connected, in-scope integrations of this org', async () => {
    await u.put(`${base()}/github`, { credentials: { token: TOKEN }, scopes: { agents: ['claude'] } })
    await u.put(`${base()}/slack`, { credentials: { botToken: 'xoxb-1234567890' }, scopes: { agents: ['omnimancer'] } })
    await u.put(`${base()}/jira`, { credentials: { siteUrl: 'https://a.atlassian.net', email: 'a@a.com', apiToken: 'jt' } })
    const env = (agent: 'claude' | 'omnimancer') => t.ctx.db.org(u.orgId, (q) => getScopedIntegrationEnv(q, t.ctx.box, u.orgId, agent))
    expect(await env('claude')).toEqual({ GITHUB_TOKEN: TOKEN, JIRA_SITE_URL: 'https://a.atlassian.net', JIRA_EMAIL: 'a@a.com', JIRA_API_TOKEN: 'jt' })
    expect(await env('omnimancer')).toEqual({ SLACK_BOT_TOKEN: 'xoxb-1234567890', JIRA_SITE_URL: 'https://a.atlassian.net', JIRA_EMAIL: 'a@a.com', JIRA_API_TOKEN: 'jt' })

    const v = await t.signup('neighbour@example.com')
    expect(await t.ctx.db.org(v.orgId, (q) => getScopedIntegrationEnv(q, t.ctx.box, v.orgId, 'claude'))).toEqual({})
  })

  it('members can read but only admins can change integrations', async () => {
    const m = await t.signup('member@example.com')
    await u.post(`/api/orgs/${u.orgSlug}/members`, { email: 'member@example.com', role: 'member' })
    expect((await m.get(base())).status).toBe(200)
    expect((await m.put(`${base()}/github`, { credentials: { token: TOKEN } })).status).toBe(403)
  })
})
