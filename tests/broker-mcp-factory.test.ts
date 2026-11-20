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
import { prepareStep } from '../server/src/engine/prepare'
import type { Step } from '../server/src/engine/spec'
import type { Run, RunStep } from '../server/src/repos/runs'

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
    return `routini-sb-${orgId}`
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
  const state = { exitCode: 0 }
  const docker: AgentDocker = {
    async runStreaming(config, opts) {
      spawned.push(config as { env: Record<string, string>; network?: string })
      for (const l of TRANSCRIPT) opts.onLine(l, 'stdout')
      return { containerId: 'c', exitCode: state.exitCode, logs: [], timedOut: false, aborted: false }
    },
    async killByLabels() {
      return 0
    },
  }
  return { docker, spawned, state }
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
    expect(spawned.network).toBe(`routini-sb-${u.orgId}`)
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
    expect(blocked?.data['message']).toBe("Blocked outbound connections (not on the org's egress allow-list, Settings → Policy): evil.example")
    expect(events.some((e) => e.type === 'egress.blocked')).toBe(true)
  })

  it('tells the agent which hosts it can reach and that a blocked host is not a reason to fail', async () => {
    await u.put(`${base()}/policy`, { egress: { allowedHosts: ['pypi.org'] } })
    const { detail } = await agentRun()
    // The proxy refused evil.example (FakeBroker.stats) and the agent still finished, so the step succeeds.
    expect(detail.run.status).toBe('succeeded')
    const prompt = fake.spawned[0]!.env['ROUTINI_SYSTEM_PROMPT']!
    expect(prompt).toMatch(/unattended/)
    expect(prompt).toContain('Network access is limited to the hosts this org allows:')
    for (const h of broker.sessions[0]!.allowedHosts) expect(prompt).toContain(h)
    expect(prompt).toContain('blocked by Routini egress policy')
    expect(prompt).toMatch(/do not retry it/)
  })

  it('names the blocked hosts when the agent fails anyway', async () => {
    fake.state.exitCode = 1
    const { detail } = await agentRun()
    expect(detail.steps[0].status).toBe('failed')
    expect(detail.steps[0].error).toMatch(/^Agent exited with code 1: .*\(egress blocked: evil\.example; allow them under Settings → Policy if the agent needs them\)$/)
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

  /** Recreates the test app with a different factoryFetch (for tests that need git/swarm endpoints). */
  const freshFactoryApp = async (fetchImpl: FactoryFetch, email: string) => {
    await t.close()
    t = await makeTestApp({ providerCtx: { fetchImpl: providerFetch, ssrfCheck: async () => true }, engine: { actions: { factoryFetch: fetchImpl, factoryPollMs: 5 } } })
    u = await t.signup(email)
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.example', apiToken: 'fk_x' } })
  }

  /**
   * Matches the git-status and git-manifest endpoints `runFactoryAction` reads around
   * dispatch; returns `null` for anything else so callers can layer their own routes.
   */
  const gitResponses = ({ branch = 'main', remoteUrl = 'https://github.com/acme/app', baseHead = 'sha-base', afterHead = 'sha-head', commits = 2, files = 3 } = {}) => {
    return (url: string): Response | null => {
      if (url.includes('/git/export/manifest')) {
        if (url.includes(`base=${encodeURIComponent(branch)}&head=${encodeURIComponent(branch)}`)) return new Response(JSON.stringify({ head: baseHead }), { status: 200 })
        return new Response(JSON.stringify({ head: afterHead, totals: { commits, files } }), { status: 200 })
      }
      if (url.endsWith('/git')) return new Response(JSON.stringify({ branch, remote_url: remoteUrl }), { status: 200 })
      return null
    }
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

  it('runs a Factory task, logging its status and recording output.factory', async () => {
    const taskCalls: Array<{ method: string; url: string; body: unknown }> = []
    const statuses2 = ['queued', 'running', 'merged']
    const git = gitResponses()
    const fetchImpl: FactoryFetch = async (url, init) => {
      const method = init.method ?? 'GET'
      taskCalls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null })
      const g = git(url)
      if (g) return g
      if (method === 'POST' && url.includes('/swarm/tasks')) return new Response(JSON.stringify({ id: 'task-9' }), { status: 201 })
      if (method === 'GET' && url.includes('/swarm/tasks/')) {
        const status = statuses2.length > 1 ? statuses2.shift()! : statuses2[0]!
        return new Response(JSON.stringify({ status }), { status: 200 })
      }
      throw new Error(`unexpected call ${method} ${url}`)
    }
    await freshFactoryApp(fetchImpl, 'factory-task@example.com')
    const run = await factoryJob({ operation: 'task', projectId: 'proj-1', request: 'Fix the bug', runtime: 'claude-code', maxRetries: 2 })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.run.status, JSON.stringify(d)).toBe('succeeded')
    expect(d.steps[0].output).toEqual({
      taskId: 'task-9',
      status: 'merged',
      factory: { projectId: 'proj-1', kind: 'task', id: 'task-9', baseRef: 'sha-base', headRef: 'main', headSha: 'sha-head', commits: 2, files: 3 },
    })
    const start = taskCalls.find((c) => c.method === 'POST')!
    expect(start).toMatchObject({ url: 'https://factory.example/api/projects/proj-1/swarm/tasks', body: { prompt: 'Fix the bug', branch_prefix: 'routini/', max_retries: 2, runtime: 'claude-code' } })
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    expect(events.filter((e) => e.type === 'log').map((e) => e.data['message'])).toEqual(
      expect.arrayContaining(['Started Factory task task-9 on project proj-1', 'Factory task: queued', 'Factory task: running', 'Factory task: merged']),
    )
  })

  it('reports a failed or cancelled Factory task with its failure reason', async () => {
    const cases: Array<[string, string | null, string]> = [
      ['failed', 'build broke', 'Factory task failed: build broke'],
      ['cancelled', null, 'Factory task failed'],
    ]
    for (const [status, reason, expected] of cases) {
      const git = gitResponses()
      const fetchImpl: FactoryFetch = async (url, init) => {
        const method = init.method ?? 'GET'
        const g = git(url)
        if (g) return g
        if (method === 'POST' && url.includes('/swarm/tasks')) return new Response(JSON.stringify({ id: 'task-x' }), { status: 201 })
        if (method === 'GET' && url.includes('/swarm/tasks/')) return new Response(JSON.stringify({ status, failure_reason: reason }), { status: 200 })
        throw new Error(`unexpected call ${method} ${url}`)
      }
      await freshFactoryApp(fetchImpl, `factory-task-${status}@example.com`)
      const run = await factoryJob({ operation: 'task', projectId: 'proj-1', request: 'r' })
      await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
      const d = (await u.get(`${base()}/runs/${run.number}`)).body
      expect(d.steps[0].error, status).toBe(expected)
    }
  })

  it("fails before any POST when the project's repo does not match repoUrl", async () => {
    const mismatchCalls: Array<{ method: string; url: string }> = []
    const fetchImpl: FactoryFetch = async (url, init) => {
      mismatchCalls.push({ method: init.method ?? 'GET', url })
      if (url.endsWith('/git')) return new Response(JSON.stringify({ branch: 'main', remote_url: 'https://github.com/acme/app' }), { status: 200 })
      throw new Error(`unexpected call ${url}`)
    }
    await freshFactoryApp(fetchImpl, 'factory-mismatch@example.com')
    const run = await factoryJob({ operation: 'orchestrate', projectId: 'proj-1', request: 'r', repoUrl: 'https://github.com/acme/other' })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.steps[0].error).toBe('Factory project proj-1 builds https://github.com/acme/app, but this step expects https://github.com/acme/other')
    expect(mismatchCalls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('fails when the Factory branch has no changes since dispatch', async () => {
    const git = gitResponses({ commits: 0, files: 0 })
    const fetchImpl: FactoryFetch = async (url, init) => {
      const method = init.method ?? 'GET'
      const g = git(url)
      if (g) return g
      if (method === 'POST' && url.includes('/swarm/tasks')) return new Response(JSON.stringify({ id: 'task-0' }), { status: 201 })
      if (method === 'GET' && url.includes('/swarm/tasks/')) return new Response(JSON.stringify({ status: 'merged' }), { status: 200 })
      throw new Error(`unexpected call ${method} ${url}`)
    }
    await freshFactoryApp(fetchImpl, 'factory-nochanges@example.com')
    const run = await factoryJob({ operation: 'task', projectId: 'proj-1', request: 'r' })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.steps[0].error).toBe('Factory finished, but its branch has no changes since dispatch')
  })

  it('rejects createPr for task and from-step operations, but not orchestrate', async () => {
    const taskBad = await u.post(`${base()}/jobs`, { name: 'x', steps: [{ kind: 'action', config: { type: 'factory', operation: 'task', projectId: 'p', request: 'r', createPr: true } }] })
    expect(taskBad.status).toBe(400)
    expect(taskBad.body.error).toMatch(/Routini opens the pull request for this step's work/)

    const fromStepBad = await u.post(`${base()}/jobs`, {
      name: 'y',
      steps: [{ kind: 'action', config: { type: 'factory', operation: 'from-step', operationFrom: 'steps.plan.out.builder', projectId: 'p', request: 'r', createPr: true } }],
    })
    expect(fromStepBad.status).toBe(400)
    expect(fromStepBad.body.error).toMatch(/Routini opens the pull request for this step's work/)

    const orchestrateOk = await u.post(`${base()}/jobs`, { name: 'z', steps: [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: 'p', request: 'r', createPr: true } }] })
    expect(orchestrateOk.status, JSON.stringify(orchestrateOk.body)).toBe(201)
  })

  it('never reads git state for a plain orchestrate, even when git endpoints would fail', async () => {
    const plainCalls: Array<{ method: string; url: string }> = []
    const fetchImpl: FactoryFetch = async (url, init) => {
      plainCalls.push({ method: init.method ?? 'GET', url })
      if (url.includes('/git')) throw new Error('git endpoints must never be called for a plain orchestrate')
      if (init.method === 'POST' && url.includes('/orchestrate')) return new Response(JSON.stringify({ id: 'orch-plain' }), { status: 201 })
      return new Response(JSON.stringify({ orchestration: { id: 'orch-plain', status: 'completed', completed_tasks: 1, total_tasks: 1 } }), { status: 200 })
    }
    await freshFactoryApp(fetchImpl, 'factory-plain@example.com')
    const run = await factoryJob({ operation: 'orchestrate', projectId: 'proj-1', request: 'r' })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const d = (await u.get(`${base()}/runs/${run.number}`)).body
    expect(d.run.status, JSON.stringify(d)).toBe('succeeded')
    expect(d.steps[0].output).not.toHaveProperty('factory')
    expect(plainCalls.some((c) => c.url.includes('/git'))).toBe(false)
  })

  describe('from-step resolution (prepare.ts)', () => {
    const run: Run = {
      id: 'run-1',
      orgId: 'org-1',
      jobId: 'job-1',
      number: 1,
      status: 'running',
      trigger: { kind: 'manual' },
      jobSnapshot: { name: 'j', steps: [] },
      costUsd: 0,
      agentSeconds: 0,
      error: null,
      cancelRequested: false,
      createdAt: '',
      startedAt: null,
      finishedAt: null,
      updatedAt: '',
    }
    const priorStep = (value: string): RunStep => ({
      idx: 0,
      stepId: 'plan',
      name: 'plan',
      kind: 'action',
      status: 'succeeded',
      attempt: 1,
      output: { out: { builder: value } },
      error: null,
      startedAt: null,
      finishedAt: null,
      policyCleared: false,
    })
    const fromStepSpec = (): Step =>
      ({
        id: 'build',
        name: 'build',
        when: 'on_success',
        retries: 0,
        kind: 'action',
        config: { type: 'factory', operation: 'from-step', operationFrom: 'steps.plan.out.builder', projectId: 'p', request: 'r' },
      }) as unknown as Step

    it.each([
      ['task', 'task'],
      ['factory-task', 'task'],
      ['orchestrate', 'orchestrate'],
      ['factory-orchestration', 'orchestrate'],
    ])('maps earlier-step value %s to operation %s, keeping operationFrom as a marker', async (value, operation) => {
      const result = await prepareStep({} as never, run, fromStepSpec(), [priorStep(value)])
      expect('error' in result, JSON.stringify(result)).toBe(false)
      expect((result as { step: Step }).step.config).toMatchObject({ operation, operationFrom: 'steps.plan.out.builder' })
    })

    it('fails clearly when the earlier step chose something that is not a Factory builder', async () => {
      const result = await prepareStep({} as never, run, fromStepSpec(), [priorStep('something-else')])
      expect(result).toEqual({ error: "Step chose 'something-else', which is not a Factory builder" })
    })

    it('never resolves from-step to a PRD execution', async () => {
      for (const value of ['prd', 'factory-prd']) {
        const result = await prepareStep({} as never, run, fromStepSpec(), [priorStep(value)])
        expect(result).toEqual({ error: `Step chose '${value}', which is not a Factory builder` })
      }
    })
  })
})
