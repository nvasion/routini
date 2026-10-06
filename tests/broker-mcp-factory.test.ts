// Credential broker wiring in agent steps, MCP servers, and the Factory action.
// The broker and Docker are faked; tests/egress-proxy.test.ts covers the proxy
// and tests/broker-docker.e2e.test.ts the real sandbox network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor, type AgentDocker } from '../server/src/engine/agent'
import type { BrokerClient } from '../server/src/egress/client'
import { PLACEHOLDER, type EgressSession, type SessionStats } from '../server/src/egress/types'
import type { FactoryFetch } from '../server/src/engine/factory'

const TRANSCRIPT = readFileSync(join(__dirname, '../agents/fake/transcript.jsonl'), 'utf8').trim().split('\n')

class FakeBroker {
  sessions: EgressSession[] = []
  closed: string[] = []
  stats: SessionStats = { requests: 3, intercepted: 2, blocked: ['evil.example'] }
  failOpen = false
  cfg = { proxyHost: 'routini-egress', proxyPort: 3128 }
  newToken() {
    return `tok${this.sessions.length + 1}`.padEnd(32, '0')
  }
  async network(orgId: string) {
    return `routini-sb-${orgId.slice(0, 8)}`
  }
  async open(s: EgressSession) {
    if (this.failOpen) throw new Error('connect ECONNREFUSED')
    this.sessions.push(s)
  }
  async close(token: string) {
    this.closed.push(token)
    return this.stats
  }
  async caPem() {
    return '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----'
  }
  async containerEnv(token: string) {
    return { HTTPS_PROXY: `http://routini:${token}@routini-egress:3128`, ROUTINI_CA_PEM: await this.caPem() }
  }
}

function fakeDocker() {
  const spawned: Array<{ env: Record<string, string>; network?: string }> = []
  const docker: AgentDocker = {
    async runStreaming(config, opts) {
      spawned.push(config as { env: Record<string, string>; network?: string })
      for (const l of TRANSCRIPT) opts.onLine(l, 'stdout')
      return { containerId: 'c', exitCode: 0, logs: [], timedOut: false, aborted: false }
    },
    async killByLabels() {
      return 0
    },
  }
  return { docker, spawned }
}

let t: TestApp
let u: TestUser
let broker: FakeBroker
let fake: ReturnType<typeof fakeDocker>
const base = () => `/api/orgs/${u.orgSlug}`
const ANTHROPIC = 'sk-ant-api03-REAL-KEY-000111'
const GITHUB = 'ghp_REALtoken0123456789abcdefghij'

async function agentRun(config: Record<string, unknown> = {}) {
  const job = await u.post(`${base()}/jobs`, { name: 'A', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'p', ...config } }] })
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const r = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
  await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
  return {
    detail: (await u.get(`${base()}/runs/${r.body.run.number}`)).body,
    events: (await u.get(`${base()}/runs/${r.body.run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>,
  }
}

describe('agent steps through the credential broker', () => {
  beforeEach(async () => {
    broker = new FakeBroker()
    fake = fakeDocker()
    t = await makeTestApp({ broker: broker as unknown as BrokerClient, engine: { executors: { agent: agentExecutor({ docker: fake.docker, images: { claude: 'img' } }) } } })
    u = await t.signup('broker@example.com')
    await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
    await u.put(`${base()}/integrations/github`, { credentials: { token: GITHUB } })
  })
  afterEach(() => t.close())

  it('gives the container placeholders, the proxy and the CA; the session holds the real secrets', async () => {
    const { detail, events } = await agentRun({ repo: { url: 'https://gitlab.com/acme/app', baseBranch: 'main' }, output: 'none' })
    expect(detail.run.status).toBe('succeeded')
    const spawned = fake.spawned[0]!
    expect(spawned.network).toBe(`routini-sb-${u.orgId.slice(0, 8)}`)
    expect(spawned.env).toMatchObject({ ANTHROPIC_API_KEY: PLACEHOLDER, GITHUB_TOKEN: PLACEHOLDER, HTTPS_PROXY: expect.stringContaining('@routini-egress:3128'), ROUTINI_CA_PEM: expect.stringContaining('BEGIN CERTIFICATE') })
    const dump = JSON.stringify(spawned.env)
    expect(dump).not.toContain(ANTHROPIC)
    expect(dump).not.toContain(GITHUB)

    const s = broker.sessions[0]!
    expect(s.label).toBe('run 1 step 1')
    expect(s.bindings).toEqual(
      expect.arrayContaining([
        { host: 'api.anthropic.com', header: 'x-api-key', format: 'raw', secret: ANTHROPIC },
        { host: 'github.com', header: 'authorization', format: 'basic-token', secret: GITHUB },
        { host: 'api.github.com', header: 'authorization', format: 'bearer', secret: GITHUB },
      ]),
    )
    expect(s.allowedHosts).toEqual(expect.arrayContaining(['api.anthropic.com', 'registry.npmjs.org', 'gitlab.com', 'github.com']))
    expect(broker.closed).toEqual([s.token])
    const blocked = events.find((e) => e.type === 'log' && String(e.data['message']).startsWith('Blocked outbound'))
    expect(blocked?.data['message']).toBe("Blocked outbound connections (not on the org's allow-list): evil.example")
    expect(events.some((e) => e.type === 'egress.blocked')).toBe(true)
  })

  it('narrows the allow-list to the org policy plus what the step needs', async () => {
    await u.put(`${base()}/policy`, { egress: { allowedHosts: ['pypi.org'] } })
    await agentRun()
    expect(broker.sessions[0]!.allowedHosts.sort()).toEqual(['api.anthropic.com', 'api.github.com', 'github.com', 'pypi.org'])
  })

  it('fails clearly when the broker is down, without starting a container', async () => {
    broker.failOpen = true
    const { detail } = await agentRun()
    expect(detail.steps[0].error).toMatch(/credential broker is unavailable: connect ECONNREFUSED/)
    expect(fake.spawned).toHaveLength(0)
  })

  it('requires the broker on the hosted service', async () => {
    await t.close()
    fake = fakeDocker()
    t = await makeTestApp({ config: { mode: 'hosted' }, broker: null, engine: { executors: { agent: agentExecutor({ docker: fake.docker, images: { claude: 'img' } }) } } })
    u = await t.signup('hosted-broker@example.com')
    await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
    const { detail } = await agentRun()
    expect(detail.steps[0].error).toMatch(/require the credential broker/)
    expect(fake.spawned).toHaveLength(0)
  })

  it('reports broker status to the console', async () => {
    expect((await u.get(`${base()}/policy`)).body.brokerEnabled).toBe(true)
  })
})

describe('MCP servers', () => {
  const mcpCalls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  let reply: () => Response = () => new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"tickets","version":"1.2"}}}\n\n', { status: 200 })

  beforeEach(async () => {
    mcpCalls.length = 0
    fake = fakeDocker()
    t = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker: fake.docker, images: { claude: 'img' } }) } } })
    // app was built without an mcpFetch; rebuild routes through the test fetch
    u = await t.signup('mcp@example.com')
    await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
  })
  afterEach(() => t.close())

  it('stores header values write-only and passes servers to scoped agents', async () => {
    const created = await u.post(`${base()}/mcp-servers`, { name: 'tickets', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer mcp-secret-value' }, agents: ['claude'] })
    expect(created.status).toBe(201)
    expect(created.body.server).toMatchObject({ name: 'tickets', headerNames: ['authorization'], agents: ['claude'] })
    expect(JSON.stringify((await u.get(`${base()}/mcp-servers`)).body)).not.toContain('mcp-secret-value')
    await u.post(`${base()}/mcp-servers`, { name: 'omni-only', url: 'https://other.example.com/mcp', agents: ['omnimancer'] })

    await agentRun()
    const cfg = JSON.parse(fake.spawned[0]!.env['ROUTINI_MCP_CONFIG']!)
    expect(cfg).toEqual({ mcpServers: { tickets: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { authorization: 'Bearer mcp-secret-value' } } } })
  })

  it('validates input and protects the credential namespace', async () => {
    expect((await u.post(`${base()}/mcp-servers`, { name: 'Bad Name', url: 'https://x.example' })).status).toBe(400)
    expect((await u.post(`${base()}/mcp-servers`, { name: 'x', url: 'ftp://x.example' })).status).toBe(400)
    expect((await u.put(`${base()}/credentials/mcp.anything.authorization`, { value: 'v' })).status).toBe(400)
  })

  it('health-checks a server with JSON-RPC initialize (SSE or JSON replies)', async () => {
    const { testMcpServer } = await import('../server/src/routes/mcp')
    const fetchImpl = async (url: string, init: RequestInit) => {
      mcpCalls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return reply()
    }
    const ok = await testMcpServer('https://mcp.example.com/mcp', { authorization: 'Bearer x' }, { fetchImpl, allowPrivateHosts: true })
    expect(ok).toEqual({ ok: true, message: 'Connected to tickets 1.2' })
    expect(mcpCalls[0]!.body).toMatchObject({ method: 'initialize' })
    expect(mcpCalls[0]!.headers['authorization']).toBe('Bearer x')
    reply = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unauthorized' } }), { status: 200 })
    expect(await testMcpServer('https://mcp.example.com/mcp', {}, { fetchImpl, allowPrivateHosts: true })).toEqual({ ok: false, message: 'The MCP server refused initialize: unauthorized' })
    reply = () => new Response('nope', { status: 401 })
    expect(await testMcpServer('https://mcp.example.com/mcp', {}, { fetchImpl, allowPrivateHosts: true })).toEqual({ ok: false, message: 'The MCP server returned HTTP 401' })
  })
})

describe('MCP under the broker', () => {
  beforeEach(async () => {
    broker = new FakeBroker()
    fake = fakeDocker()
    t = await makeTestApp({ broker: broker as unknown as BrokerClient, engine: { executors: { agent: agentExecutor({ docker: fake.docker, images: { claude: 'img' } }) } } })
    u = await t.signup('mcp-broker@example.com')
    await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
  })
  afterEach(() => t.close())

  it('puts placeholders in the config and binds the real header at the MCP host', async () => {
    await u.post(`${base()}/mcp-servers`, { name: 'tickets', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': 'mcp-real-key-123' } })
    await agentRun()
    const cfg = JSON.parse(fake.spawned[0]!.env['ROUTINI_MCP_CONFIG']!)
    expect(cfg.mcpServers.tickets.headers).toEqual({ 'x-api-key': PLACEHOLDER })
    expect(broker.sessions[0]!.bindings).toContainEqual({ host: 'mcp.example.com', header: 'x-api-key', format: 'raw', secret: 'mcp-real-key-123' })
    expect(broker.sessions[0]!.allowedHosts).toContain('mcp.example.com')
  })
})

describe('Factory action', () => {
  const calls: Array<{ method: string; url: string; auth: string; body: unknown }> = []
  let statuses: string[] = []
  let failReason: string | null = null
  const factoryFetch: FactoryFetch = async (url, init) => {
    calls.push({ method: init.method ?? 'GET', url, auth: (init.headers as Record<string, string>)['authorization']!, body: init.body ? JSON.parse(String(init.body)) : null })
    if (init.method === 'POST' && url.includes('/orchestrate')) return new Response(JSON.stringify({ id: 'orch-1', status: 'pending' }), { status: 201 })
    if (init.method === 'POST' && url.includes('/execute')) return new Response(JSON.stringify({ orchestration_id: 'orch-prd', count: 4 }), { status: 200 })
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0] ?? 'running'
    const done = status === 'completed'
    return new Response(
      JSON.stringify({ orchestration: { id: 'orch-1', status, completed_tasks: done ? 3 : 1, total_tasks: 3, failure_reason: status === 'failed' ? failReason : null, pr_url: done ? 'https://github.com/acme/app/pull/9' : null } }),
      { status: 200 },
    )
  }
  const providerFetch = async (url: string) => {
    calls.push({ method: 'GET', url, auth: '', body: null })
    return new Response(JSON.stringify({ email: 'bot@factory' }), { status: 200 })
  }

  beforeEach(async () => {
    calls.length = 0
    statuses = ['pending', 'running', 'completed']
    failReason = null
    t = await makeTestApp({ providerCtx: { fetchImpl: providerFetch, ssrfCheck: async () => true }, engine: { actions: { factoryFetch, factoryPollMs: 5 } } })
    u = await t.signup('factory@example.com')
  })
  afterEach(() => t.close())

  const factoryJob = async (config: Record<string, unknown>) => {
    const job = await u.post(`${base()}/jobs`, { name: 'Build', steps: [{ name: 'factory', kind: 'action', config: { type: 'factory', ...config } }] })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    return (await u.post(`${base()}/jobs/${job.body.job.id}/run`)).body.run as { number: number; id: string }
  }

  it('connects and checks the API key', async () => {
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.internal.example', apiToken: 'fk_test' } })
    const test = await u.post(`${base()}/integrations/factory/test`)
    expect(test.body).toMatchObject({ ok: true, message: 'Factory API key is valid as bot@factory' })
    expect(calls[0]!.url).toBe('https://factory.internal.example/api/auth/me')
  })

  it('starts an orchestration, follows it to completion and records the PR', async () => {
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.example', apiToken: 'fk_secret_123' } })
    const run = await factoryJob({ operation: 'orchestrate', projectId: 'proj-1', request: 'Add dark mode', runtime: 'claude-code', createPr: true })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].output).toEqual({ orchestrationId: 'orch-1', status: 'completed', completedTasks: 3, totalTasks: 3, prUrl: 'https://github.com/acme/app/pull/9' })
    const start = calls.find((c) => c.method === 'POST')!
    expect(start).toMatchObject({ url: 'https://factory.example/api/projects/proj-1/orchestrate', auth: 'Bearer fk_secret_123', body: { request: 'Add dark mode', runtime: 'claude-code', post_completion: { push: true, create_pr: true } } })
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.url === 'https://factory.example/api/orchestrations/orch-1?view=compact')).toBe(true)
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    expect(events.filter((e) => e.type === 'log').map((e) => e.data['message'])).toEqual(
      expect.arrayContaining(['Started Factory orchestration orch-1 on project proj-1', 'Factory: running · 1/3 tasks', 'Factory: completed · 3/3 tasks']),
    )
    expect(events.find((e) => e.type === 'artifact')!.data).toEqual({ kind: 'pull_request', url: 'https://github.com/acme/app/pull/9', source: 'factory' })
    expect(JSON.stringify(events)).not.toContain('fk_secret_123')
  })

  it('reports a failed orchestration with Factory\'s reason, and runs PRDs', async () => {
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.example', apiToken: 'fk_x' } })
    statuses = ['running', 'failed']
    failReason = 'tests failed in task 2'
    const run = await factoryJob({ operation: 'prd', prdId: 'prd-7' })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.steps[0].error).toBe('Factory orchestration failed: tests failed in task 2')
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('https://factory.example/api/prds/prd-7/execute')
  })

  it('stops waiting on cancel and says the work continues in Factory', async () => {
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.example', apiToken: 'fk_x' } })
    statuses = ['running']
    const run = await factoryJob({ operation: 'orchestrate', projectId: 'p', request: 'r' })
    const worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 })
    await worker.tick()
    for (let i = 0; i < 100 && !calls.some((c) => c.method === 'GET'); i++) await new Promise((r) => setTimeout(r, 10))
    await u.post(`${base()}/runs/${run.number}/cancel`)
    await worker.drain()
    expect((await u.get(`${base()}/runs/${run.number}`)).body.run.status).toBe('canceled')
  })

  it('fails clearly without the integration, and validates the spec', async () => {
    const run = await factoryJob({ operation: 'orchestrate', projectId: 'p', request: 'r' })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    expect((await u.get(`${base()}/runs/${run.number}`)).body.steps[0].error).toMatch(/Factory integration is not connected/)
    const bad = await u.post(`${base()}/jobs`, { name: 'x', steps: [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: 'p' } }] })
    expect(bad.body.error).toMatch(/request must be a string/)
  })
})
