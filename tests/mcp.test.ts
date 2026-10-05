// Phase 4: API tokens, Routini as an MCP server (driven by the real MCP SDK
// client over Streamable HTTP), and agent steps with Routini's own tools.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor, type AgentDocker } from '../server/src/engine/agent'
import { attachHostTerminal } from '../server/src/http/hostTerminal'
import type { Auth } from '../server/src/http/auth'

let t: TestApp
let u: TestUser
let server: Server
let baseUrl: string
let base: string
let worker: Worker | null
const sockets = new Set<import('node:net').Socket>()
let agentEnvs: Array<Record<string, string>> = []
let duringRun: ((env: Record<string, string>) => Promise<void>) | null = null

const docker: AgentDocker = {
  async runStreaming(config, opts) {
    agentEnvs.push(config.env)
    await duringRun?.(config.env)
    opts.onLine('{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"num_turns":1}', 'stdout')
    return { containerId: 'c1', exitCode: 0, logs: [], timedOut: false, aborted: false }
  },
  async killByLabels() {
    return 0
  },
}

beforeEach(async () => {
  agentEnvs = []
  duringRun = null
  worker = null
  t = await makeTestApp({ config: { publicUrl: 'https://routini.example', agentApiUrl: 'https://routini.example' }, engine: { actions: { runnerPollMs: 25 }, executors: { agent: agentExecutor({ docker, images: { claude: 'routini/agent-claude:test' } }) } } })
  u = await t.signup('mcp@example.com')
  base = `/api/orgs/${u.orgSlug}`
  server = t.app.listen(0)
  sockets.clear()
  server.on('connection', (s) => sockets.add(s))
  attachHostTerminal(server, t.ctx, t.app.locals['auth'] as Auth)
  t.ctx.runners.attach(server)
  await t.ctx.runners.start()
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await worker?.stop()
  await t.ctx.runners.stop()
  for (const s of sockets) s.destroy()
  await new Promise((r) => server.close(r))
  await t.close()
})

async function token(user: TestUser, body: Record<string, unknown> = {}) {
  const r = await user.post(`/api/orgs/${user.orgSlug}/tokens`, { name: 'laptop', role: 'member', ...body })
  expect(r.status).toBe(201)
  return r.body as { token: string; apiToken: { id: string }; mcpCommand: string; mcpUrl: string }
}

async function mcp(tok: string) {
  const client = new Client({ name: 'test', version: '1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError }
  }
  return { client, call }
}

const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` })

describe('API tokens', () => {
  it('creates a token shown once, with a ready MCP command; lists and revokes', async () => {
    const tk = await token(u, { name: 'claude code', expiresInDays: 30 })
    expect(tk.token).toMatch(/^rtk_/)
    expect(tk.mcpUrl).toBe('https://routini.example/mcp')
    expect(tk.mcpCommand).toBe(`claude mcp add --transport http routini https://routini.example/mcp --header "Authorization: Bearer ${tk.token}"`)
    const list = (await u.get(`${base}/tokens`)).body.tokens
    expect(list).toMatchObject([{ name: 'claude code', role: 'member', revokedAt: null }])
    expect(JSON.stringify(list)).not.toContain(tk.token)

    const me = await t.request.get(`${base}/jobs`).set(bearer(tk.token))
    expect(me.status).toBe(200)
    expect((await u.del(`${base}/tokens/${tk.apiToken.id}`)).status).toBe(204)
    expect((await t.request.get(`${base}/jobs`).set(bearer(tk.token))).status).toBe(401)
  })

  it('pins tokens to their org and to the lower of the two roles', async () => {
    const viewer = await token(u, { name: 'ro', role: 'viewer' })
    expect((await t.request.get(`${base}/jobs`).set(bearer(viewer.token))).status).toBe(200)
    const post = await t.request.post(`${base}/jobs`).set(bearer(viewer.token)).send({ name: 'x', steps: [{ kind: 'action', config: { type: 'http', url: 'https://example.com' } }] })
    expect(post.status).toBe(403)

    // Another org of the same user is invisible to the token.
    const other = await u.post('/api/orgs', { name: 'Second' })
    expect(other.status).toBe(201)
    expect((await t.request.get(`/api/orgs/${other.body.org.slug}/jobs`).set(bearer(viewer.token))).status).toBe(404)
    expect((await t.request.get('/api/orgs').set(bearer(viewer.token))).body.orgs.map((o: { slug: string }) => o.slug)).toEqual([u.orgSlug])
    expect((await t.request.post('/api/orgs').set(bearer(viewer.token)).send({ name: 'Nope' })).status).toBe(403)
    // Tokens cannot mint tokens.
    expect((await t.request.post(`${base}/tokens`).set(bearer(viewer.token)).send({ name: 'x', role: 'viewer' })).status).toBe(403)
  })

  it('cannot exceed your role, expires, and dies with the membership', async () => {
    const member = await t.signup('member@example.com')
    await t.ctx.db.system((q) => q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, [u.orgId, member.userId]))
    const m = { ...member, orgSlug: u.orgSlug, orgId: u.orgId }
    expect((await member.post(`${base}/tokens`, { name: 'x', role: 'admin' })).status).toBe(403)
    const tk = await token(m, { name: 'm' })
    expect((await t.request.get(`${base}/jobs`).set(bearer(tk.token))).status).toBe(200)

    await t.ctx.db.system((q) => q.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [tk.apiToken.id]))
    expect((await t.request.get(`${base}/jobs`).set(bearer(tk.token))).status).toBe(401)

    const tk2 = await token(m, { name: 'm2' })
    await u.del(`${base}/members/${member.userId}`)
    expect((await t.request.get(`${base}/jobs`).set(bearer(tk2.token))).status).toBe(404)
  })

  it('refuses API tokens on terminals', async () => {
    const tk = await token(u, { role: 'admin' })
    const h = await u.post(`${base}/hosts`, { name: 'lab-01', address: '192.168.1.40', username: 'deploy' })
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}${base}/hosts/${h.body.host.id}/terminal`, { headers: bearer(tk.token) })
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode))
      ws.on('open', () => resolve(undefined))
    })
    expect(status).toBe(403)
  })
})

describe('MCP server', () => {
  it('needs an API token; is stateless POST only', async () => {
    const noAuth = await t.request.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers['www-authenticate']).toContain('Bearer')
    // A console session (JWT) is not enough: MCP clients use API tokens.
    expect((await t.request.post('/mcp').set(bearer(u.token)).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
    expect((await t.request.get('/mcp').set(bearer((await token(u)).token))).status).toBe(405)
  })

  it('lists its tools (never an approve tool) and answers read tools', async () => {
    await u.post(`${base}/jobs`, { name: 'Ping API', steps: [{ kind: 'action', config: { type: 'http', url: 'https://example.com' } }] })
    const { client, call } = await mcp((await token(u)).token)
    const names = (await client.listTools()).tools.map((x) => x.name).sort()
    expect(names).toEqual(['add_incident_note', 'cancel_run', 'get_incident', 'get_run', 'list_hosts', 'list_incidents', 'list_jobs', 'list_pending_approvals', 'list_runs', 'resolve_incident', 'run_command', 'run_job', 'whoami'])
    expect((await call('whoami')).text).toBe(`mcp@example.com in org "mcp" (${u.orgSlug}) as member, via token "laptop".`)
    expect((await call('list_jobs')).text).toMatch(/^- Ping API \(id [0-9a-f-]+\) · trigger manual · 1 step$/)
    expect((await call('list_hosts')).text).toBe('No servers in the fleet yet.')
    expect((await call('list_incidents')).text).toBe('No open incidents.')
    expect(await call('get_run', { number: 99 })).toEqual({ text: 'There is no run #99.', isError: true })
    await client.close()
  })

  it('runs jobs as the token owner, recorded with trigger mcp', async () => {
    await u.post(`${base}/jobs`, { name: 'Ping API', steps: [{ kind: 'action', config: { type: 'http', url: 'https://example.invalid' } }] })
    const { call } = await mcp((await token(u)).token)
    expect((await call('run_job', { job: 'ping api' })).text).toBe('Started run #1 (Ping API). Check it with get_run {"number": 1}.')
    expect((await call('run_job', { job: 'nope' })).isError).toBe(true)
    const run = (await u.get(`${base}/runs/1`)).body.run
    expect(run.trigger).toMatchObject({ kind: 'mcp', userId: u.userId, tokenName: 'laptop', tool: 'run_job' })
    expect((await call('cancel_run', { number: 1 })).text).toMatch(/Run #1 (is canceled|will stop shortly)\./)
    expect((await call('get_run', { number: 1 })).text).toMatch(/^Run #1 · Ping API · canceled · trigger mcp/)
  })

  it('gates tools by role: viewers read but cannot run', async () => {
    const { call } = await mcp((await token(u, { role: 'viewer' })).token)
    expect(await call('run_job', { job: 'x' })).toEqual({ text: 'This needs the member role; this token acts as viewer.', isError: true })
    expect((await call('list_runs')).isError).toBe(false)
  })

  it('run_command runs on a runner host and returns the output', async () => {
    const e = await u.post(`${base}/runners/enrollments`, { name: 'web-01' })
    const en = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'web-01', os: 'linux', arch: 'amd64', version: '0.1.0' })
    const runner = new FakeRunner({ baseUrl, credential: en.body.credential, onExec: (s, r) => {
      r.output(s.id, `ran ${s.command}`)
      r.exit(s.id, 0)
    } })
    await runner.connect()
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20, pollMs: 20 } as never)
    await worker.start()

    const { call } = await mcp((await token(u)).token)
    expect((await call('list_hosts')).text).toMatch(/^- web-01 \[runner\] online/)
    const r = await call('run_command', { host: 'WEB-01', command: 'uptime' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Run #1 · Command on web-01 · succeeded · trigger mcp')
    expect(r.text).toContain('ran uptime')
    // A real run, hidden job and all: visible in runs, not in jobs.
    expect((await u.get(`${base}/runs`)).body.runs[0]).toMatchObject({ jobName: 'Command on web-01', trigger: 'mcp' })
    expect((await u.get(`${base}/jobs`)).body.jobs).toEqual([])
    expect((await call('run_command', { host: 'nope', command: 'x' })).text).toBe('No server named "nope". Use list_hosts to see the fleet.')
    runner.close()
  })

  it('run_command respects policy: it waits for a person, and agents cannot approve', async () => {
    await u.put(`${base}/policy`, { rules: [{ id: 'prod', name: 'Prod commands need approval', match: { kinds: ['action'], actionTypes: ['ssh'], hostTags: ['prod'] }, effect: 'require_approval', minRole: 'admin' }] })
    await u.put(`${base}/credentials/ssh.p`, { value: 'k' })
    await u.post(`${base}/hosts`, { name: 'db-01', address: '10.0.0.5', username: 'deploy', credentialKey: 'ssh.p', tags: ['prod'] })
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20, pollMs: 20 } as never)
    await worker.start()
    const { call } = await mcp((await token(u)).token)
    const r = await call('run_command', { host: 'db-01', command: 'systemctl restart postgres' })
    expect(r.text).toBe('Run #1 is waiting for approval (policy "Prod commands need approval", admin+). A person approves it in Routini; check back with get_run {"number": 1}.')
    expect((await call('list_pending_approvals')).text).toContain('run #1')
    expect((await call('get_run', { number: 1 })).text).toContain('A person approves it in Routini; agents cannot.')
  })

  it('works with incidents: list, read, note, resolve', async () => {
    const tok = (await u.post(`${base}/alerts/token`)).body.token
    await t.request.post(`/api/alerts/${u.orgSlug}`).set(bearer(tok)).send({ name: 'DiskFull', severity: 'critical', labels: { instance: 'web-01' } })
    const { call } = await mcp((await token(u)).token)
    expect((await call('list_incidents')).text).toMatch(/^- #1 \[critical\] DiskFull on web-01 · open/)
    expect((await call('add_incident_note', { number: 1, text: 'Looking at journald' })).text).toBe('Added a note to incident #1.')
    expect((await call('get_incident', { number: 1 })).text).toContain('note by mcp@example.com: Looking at journald')
    expect((await call('resolve_incident', { number: 1 })).text).toBe('Resolved incident #1; a postmortem draft is ready in Routini.')
    expect((await u.get(`${base}/incidents/1`)).body.incident.postmortem.markdown).toContain('Looking at journald')
  })
})

describe('agent steps with Routini tools', () => {
  beforeEach(async () => {
    await u.put(`${base}/settings`, { endpointApiKeys: { anthropic: 'sk-ant-test-key-0000' } })
  })

  it('get a run-scoped token in their MCP config, usable during the step and revoked after', async () => {
    let duringWhoami = ''
    duringRun = async (env) => {
      const cfg = JSON.parse(env['ROUTINI_MCP_CONFIG']!)
      const header: string = cfg.mcpServers.routini.headers.authorization
      const { client, call } = await mcp(header.slice('Bearer '.length))
      duringWhoami = (await call('whoami')).text
      await client.close()
    }
    const job = await u.post(`${base}/jobs`, { name: 'Agent with tools', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'Check the fleet', routini: true } }] })
    expect(job.status).toBe(201)
    await u.post(`${base}/jobs/${job.body.job.id}/run`)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()

    expect((await u.get(`${base}/runs/1`)).body.run.status).toBe('succeeded')
    const cfg = JSON.parse(agentEnvs[0]!['ROUTINI_MCP_CONFIG']!)
    expect(cfg.mcpServers.routini).toMatchObject({ type: 'http', url: 'https://routini.example/mcp' })
    expect(duringWhoami).toMatch(/as member, via token "run #1 step 1"\.$/)
    const tok: string = cfg.mcpServers.routini.headers.authorization.slice(7)
    expect((await t.request.get(`${base}/jobs`).set(bearer(tok))).status).toBe(401)
    // Run tokens are not listed with personal ones, and the token never reaches the timeline.
    expect((await u.get(`${base}/tokens`)).body.tokens).toEqual([])
    const events = JSON.stringify((await u.get(`${base}/runs/1/events`)).body.events)
    expect(events).not.toContain(tok)
  })

  it('without the flag, no Routini server is configured', async () => {
    const job = await u.post(`${base}/jobs`, { name: 'Plain agent', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'x' } }] })
    await u.post(`${base}/jobs/${job.body.job.id}/run`)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    expect(agentEnvs[0]!['ROUTINI_MCP_CONFIG']).toBeUndefined()
  })
})
