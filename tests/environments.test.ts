// Environments: lifecycle, limits, sweeper, exec, isolation, agent steps in an
// environment, and the WebSocket terminal. Docker is faked (FakeEnvRuntime);
// tests/environments-docker.e2e.test.ts covers the real thing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeEnvRuntime } from './helpers/fakeEnvRuntime'
import { FakeRunner, fleetEnvHappyPath } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor } from '../server/src/engine/agent'
import { attachTerminal } from '../server/src/http/terminal'
import type { Auth } from '../server/src/http/auth'

const TRANSCRIPT = readFileSync(join(__dirname, '../agents/fake/transcript.jsonl'), 'utf8').trim().split('\n')

let t: TestApp
let u: TestUser
let rt: FakeEnvRuntime
const base = () => `/api/orgs/${u.orgSlug}/environments`

beforeEach(async () => {
  rt = new FakeEnvRuntime()
  t = await makeTestApp({ envRuntime: rt, engine: { executors: { agent: agentExecutor({ docker: { runStreaming: async () => { throw new Error('should run in the environment') }, killByLabels: async () => 0 } }) } } })
  u = await t.signup('env@example.com')
})
afterEach(() => t.close())

async function create(body: Record<string, unknown> = {}) {
  const res = await u.post(base(), { name: 'dev', ...body })
  expect(res.status, JSON.stringify(res.body)).toBe(202)
  await t.ctx.envs.idle()
  return (await u.get(`${base()}/${res.body.environment.id}`)).body as { environment: Record<string, unknown> & { id: string; status: string }; events: Array<{ type: string }> }
}

/** A runner host, enrolled but never connected — its runner's capabilities are set directly (no FakeRunner needed here). */
async function runnerHost(name: string, capabilities: string[] = ['exec', 'pty', 'agents', 'environments']): Promise<string> {
  const e = await u.post(`/api/orgs/${u.orgSlug}/runners/enrollments`, { name, group: 'prod', tags: ['prod'] })
  expect(e.status, JSON.stringify(e.body)).toBe(201)
  const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.4.0' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  await t.ctx.db.system((q) => q.query('UPDATE runners SET capabilities = $1 WHERE id = $2', [capabilities, r.body.runnerId]))
  return r.body.hostId as string
}

/** An SSH host (not routini-runner). */
async function sshHost(name: string): Promise<string> {
  await u.put(`/api/orgs/${u.orgSlug}/credentials/ssh.${name}`, { value: 'not-a-real-key' })
  const h = await u.post(`/api/orgs/${u.orgSlug}/hosts`, { name, address: '10.0.0.5', username: 'deploy', credentialKey: `ssh.${name}` })
  expect(h.status, JSON.stringify(h.body)).toBe(201)
  return h.body.host.id as string
}

describe('lifecycle', () => {
  it('creates a running environment, cloning its repo with the GitHub token only in that process', async () => {
    await u.put(`/api/orgs/${u.orgSlug}/integrations/github`, { credentials: { token: 'ghp_token_for_clone_0123456789' } })
    const d = await create({ repo: { url: 'https://github.com/acme/app', branch: 'develop' } })
    expect(d.environment).toMatchObject({ status: 'running', repo: { url: 'https://github.com/acme/app', branch: 'develop', dir: 'app' }, image: 'routini/agent-claude:latest' })
    expect(d.environment).not.toHaveProperty('containerId')
    expect(d.environment).not.toHaveProperty('volume')
    expect(String(d.environment['attachCommand'])).toMatch(/^docker exec -it -u 1000 -w \/workspace c1 bash -l$/)
    expect(rt.volumes.size).toBe(1)
    const [container] = [...rt.containers.values()]
    expect(container).toMatchObject({ image: 'routini/agent-claude:latest', cpus: 2, memoryMb: 4096 })
    expect(container!.labels).toMatchObject({ 'routini.org': u.orgId, 'routini.environment': d.environment.id })
    const clone = rt.execs[0]!
    expect(clone.env).toEqual({ REPO_URL: 'https://github.com/acme/app', BRANCH: 'develop', DIR: '/workspace/app', GITHUB_TOKEN: 'ghp_token_for_clone_0123456789' })
    expect(d.events.map((e) => e.type)).toContain('created')
  })

  it('marks a failed clone and retries it on start', async () => {
    rt.script = () => ({ exitCode: 128, lines: ['fatal: repository not found'] })
    const d = await create({ repo: { url: 'https://github.com/acme/missing' } })
    expect(d.environment.status).toBe('failed')
    expect(String(d.environment['statusDetail'])).toMatch(/Cloning https:\/\/github.com\/acme\/missing@main failed: fatal: repository not found/)
    expect(rt.containers.size).toBe(0)
    rt.script = () => ({ exitCode: 0 })
    await u.post(`${base()}/${d.environment.id}/start`)
    await t.ctx.envs.idle()
    expect((await u.get(`${base()}/${d.environment.id}`)).body.environment.status).toBe('running')
    expect(rt.execs).toHaveLength(2) // clone retried
  })

  it('stop keeps the volume; start makes a new container on it; delete removes both', async () => {
    const d = await create()
    const id = d.environment.id
    const stopped = await u.post(`${base()}/${id}/stop`)
    expect(stopped.body.environment.status).toBe('stopped')
    expect(rt.containers.size).toBe(0)
    expect(rt.volumes.size).toBe(1)
    await u.post(`${base()}/${id}/start`)
    await t.ctx.envs.idle()
    expect([...rt.containers.keys()]).toEqual(['c2'])
    expect((await u.get(`${base()}/${id}`)).body.environment.status).toBe('running')

    const member = await t.signup('member-env@example.com')
    await u.post(`/api/orgs/${u.orgSlug}/members`, { email: 'member-env@example.com', role: 'member' })
    expect((await member.del(`${base()}/${id}`)).status).toBe(403)
    expect((await u.del(`${base()}/${id}`)).status).toBe(204)
    expect(rt.containers.size).toBe(0)
    expect(rt.volumes.size).toBe(0)
    expect((await u.get(`${base()}/${id}`)).status).toBe(404)
  })

  it('validates input and names', async () => {
    expect((await u.post(base(), { name: 'bad name' })).status).toBe(400)
    expect((await u.post(base(), { name: 'x', repo: { url: 'http://internal/repo' } })).status).toBe(400)
    expect((await u.post(base(), { name: 'x', memoryMb: 999999 })).status).toBe(400)
    await create()
    expect((await u.post(base(), { name: 'dev' })).status).toBe(409)
  })

  it('reports a container that would not start', async () => {
    rt.failStart = true
    const d = await create()
    expect(d.environment).toMatchObject({ status: 'failed', statusDetail: 'image not found' })
  })

  it('restricts images on the hosted service', async () => {
    t.ctx.config.mode = 'hosted'
    const res = await u.post(base(), { name: 'x', image: 'evil/miner:latest' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/image must be one of: routini\/agent-claude:latest/)
  })
})

describe('environments on a fleet host', () => {
  // Provisioning a fleet environment now really queues ops on its runner (tests/env-fleet.test.ts
  // covers that end to end); the two tests here that watch one through to 'running' need a
  // connected fake runner to answer them, so this block runs its own gateway server.
  let server: Server
  let baseUrl: string
  const sockets = new Set<Socket>()
  beforeEach(async () => {
    server = t.app.listen(0)
    sockets.clear()
    server.on('connection', (s) => sockets.add(s))
    t.ctx.runners.attach(server)
    await t.ctx.runners.start()
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await t.ctx.runners.stop()
    for (const s of sockets) s.destroy()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  })

  /** A runner host, enrolled and connected with a fake runner that answers env ops on the happy path. */
  async function connectedRunnerHost(name: string): Promise<string> {
    const e = await u.post(`/api/orgs/${u.orgSlug}/runners/enrollments`, { name, group: 'prod', tags: ['prod'] })
    expect(e.status, JSON.stringify(e.body)).toBe(201)
    const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.4.0' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const { onEnvOp } = fleetEnvHappyPath()
    const fake = new FakeRunner({ baseUrl, credential: r.body.credential, capabilities: ['exec', 'pty', 'agents', 'environments'], onEnvOp })
    await fake.connect()
    return r.body.hostId as string
  }

  it('creates on a qualified runner host, defaulting the image to the fleet agent image, and the view carries the host', async () => {
    const hostId = await connectedRunnerHost('fleet-01')
    const d = await create({ name: 'fleet-env', hostId })
    expect(d.environment).toMatchObject({ status: 'running', hostId, host: { id: hostId, name: 'fleet-01' }, image: 'ghcr.io/nvasion/routini-agent-claude:latest' })
    const list = (await u.get(base())).body.environments as Array<{ id: string; host: { id: string; name: string } | null }>
    expect(list.find((e) => e.id === d.environment.id)!.host).toEqual({ id: hostId, name: 'fleet-01' })
  })

  it('leaves environments without a host unchanged (no host field set, Routini image defaults)', async () => {
    const d = await create({ name: 'no-host' })
    expect(d.environment).toMatchObject({ hostId: null, host: null, image: 'routini/agent-claude:latest' })
  })

  it('rejects a runner host whose runner lacks the environments capability', async () => {
    const hostId = await runnerHost('fleet-02', ['exec', 'pty', 'agents'])
    const res = await u.post(base(), { name: 'x', hostId })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('"fleet-02" cannot host environments: its runner needs routini-runner v0.4.0 or newer with agents enabled')
  })

  it('rejects a revoked runner host', async () => {
    const hostId = await runnerHost('fleet-revoked')
    await t.ctx.db.system((q) => q.query("UPDATE runners SET revoked_at = now() WHERE host_id = $1", [hostId]))
    const res = await u.post(base(), { name: 'x', hostId })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('"fleet-revoked" cannot host environments: its runner needs routini-runner v0.4.0 or newer with agents enabled')
  })

  it('rejects an SSH host', async () => {
    const hostId = await sshHost('ssh-01')
    const res = await u.post(base(), { name: 'x', hostId })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('"ssh-01" cannot host environments: its runner needs routini-runner v0.4.0 or newer with agents enabled')
  })

  it('rejects a hostId that does not match a host in this org', async () => {
    const res = await u.post(base(), { name: 'x', hostId: '00000000-0000-0000-0000-000000000000' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/hostId does not match a host in this org/)
  })

  it('rejects an image not on the fleet image list for a fleet host', async () => {
    const hostId = await runnerHost('fleet-03')
    const res = await u.post(base(), { name: 'x', hostId, image: 'evil/miner:latest' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('image must be one of: ghcr.io/nvasion/routini-agent-claude:latest')
  })

  it('refuses to delete a host that an environment still references', async () => {
    const hostId = await connectedRunnerHost('fleet-04')
    const d = await create({ name: 'fleet-env-2', hostId })
    expect(d.environment.hostId).toBe(hostId)
    const res = await u.del(`/api/orgs/${u.orgSlug}/hosts/${hostId}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Host is used by environments: fleet-env-2')
  })
})

describe('limits and the sweeper', () => {
  it('caps running environments per plan', async () => {
    t.ctx.config.mode = 'hosted'
    const free = await t.signup('free@example.com')
    const b = `/api/orgs/${free.orgSlug}/environments`
    expect((await free.post(b, { name: 'one' })).status).toBe(202)
    await t.ctx.envs.idle()
    const second = await free.post(b, { name: 'two' })
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/1 environment at a time/)
    expect((await free.get(b)).body.environments).toHaveLength(1)
  })

  it('stops idle environments and notices dead containers', async () => {
    const a = await create({ name: 'idle', idleMinutes: 5 })
    const b = await create({ name: 'busy' })
    // a: idle for 10 minutes; b: its container died.
    await t.ctx.db.system((q) => q.query(`UPDATE environments SET last_active_at = now() - interval '10 minutes' WHERE id = $1`, [a.environment.id]))
    const bContainer = [...rt.containers.entries()].find(([, c]) => c.labels['routini.environment'] === b.environment.id)![0]
    rt.containers.delete(bContainer)
    expect(await t.ctx.envs.sweep()).toBe(2)
    const ga = (await u.get(`${base()}/${a.environment.id}`)).body
    const gb = (await u.get(`${base()}/${b.environment.id}`)).body
    expect(ga.environment).toMatchObject({ status: 'stopped', statusDetail: 'idle for 5 minutes' })
    expect(gb.environment).toMatchObject({ status: 'stopped', statusDetail: 'The container exited' })
    expect(await t.ctx.envs.sweep()).toBe(0)
  })

  it('fails provisioning that never finished', async () => {
    const d = await create()
    await t.ctx.db.system((q) => q.query(`UPDATE environments SET status = 'starting', updated_at = now() - interval '20 minutes' WHERE id = $1`, [d.environment.id]))
    expect(await t.ctx.envs.sweep()).toBe(1)
    expect((await u.get(`${base()}/${d.environment.id}`)).body.environment).toMatchObject({ status: 'failed', statusDetail: 'Provisioning did not finish' })
  })
})

describe('exec and isolation', () => {
  it('runs a one-shot command (admin), redacts output, records it', async () => {
    const d = await create()
    rt.script = (c) => (c.cmd.join(' ').includes('ls') ? { lines: ['app', 'token=supersecretvalue'], exitCode: 0 } : { exitCode: 0 })
    const res = await u.post(`${base()}/${d.environment.id}/exec`, { command: 'ls /workspace' })
    expect(res.body).toEqual({ exitCode: 0, timedOut: false, output: 'app\ntoken=[REDACTED]\n', truncated: false })
    expect((await u.get(`${base()}/${d.environment.id}`)).body.events[0]).toMatchObject({ type: 'exec' })
  })

  it('hides environments from other orgs', async () => {
    const d = await create()
    const other = await t.signup('other-env@example.com')
    expect((await other.get(`/api/orgs/${u.orgSlug}/environments/${d.environment.id}`)).status).toBe(404)
    expect((await other.post(`/api/orgs/${other.orgSlug}/environments/${d.environment.id}/stop`)).status).toBe(404)
  })
})

describe('agent steps in an environment', () => {
  it('runs the agent inside the environment in its own git worktree, starting it if stopped', async () => {
    await u.put(`/api/orgs/${u.orgSlug}/settings`, { endpointApiKeys: { anthropic: 'sk-ant-in-env-0123456789' } })
    const d = await create({ repo: { url: 'https://github.com/acme/app', branch: 'main' } })
    await u.post(`${base()}/${d.environment.id}/stop`)
    rt.script = (c) => (c.cmd[0] === 'routini-entrypoint' ? { lines: TRANSCRIPT, exitCode: 0 } : { exitCode: 0 })

    const job = await u.post(`/api/orgs/${u.orgSlug}/jobs`, {
      name: 'In env',
      steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'look', environmentId: d.environment.id, output: 'none' } }],
    })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    await u.post(`/api/orgs/${u.orgSlug}/jobs/${job.body.job.id}/run`)
    const worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 })
    await worker.drain()

    const run = (await u.get(`/api/orgs/${u.orgSlug}/runs/1`)).body
    expect(run.run.status).toBe('succeeded')
    const agentExec = rt.execs.find((e) => e.cmd[0] === 'routini-entrypoint')!
    expect(agentExec.env).toMatchObject({
      ROUTINI_REPO_DIR: '/workspace/app',
      REPO_URL: 'https://github.com/acme/app',
      BASE_BRANCH: 'main',
      WORK_BRANCH: 'routini/run-1',
      ROUTINI_OUTPUT: 'none',
      ANTHROPIC_API_KEY: 'sk-ant-in-env-0123456789',
    })
    expect((await u.get(`${base()}/${d.environment.id}`)).body.environment.status).toBe('running')
    expect((await u.get(`${base()}/${d.environment.id}`)).body.events.map((e: { type: string }) => e.type)).toContain('agent.run')
  })

  it('validates environment references in job specs', async () => {
    const d = await create()
    const bad = await u.post(`/api/orgs/${u.orgSlug}/jobs`, { name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', environmentId: d.environment.id, repo: { url: 'https://github.com/a/b' } } }] })
    expect(bad.body.error).toMatch(/either environmentId .* or repo/)
    const missing = await u.post(`/api/orgs/${u.orgSlug}/jobs`, { name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', environmentId: '00000000-0000-0000-0000-000000000000' } }] })
    expect(missing.body.error).toMatch(/does not match an environment/)
  })
})

describe('terminal', () => {
  let server: Server
  let port: number
  beforeEach(async () => {
    server = t.app.listen(0)
    attachTerminal(server, t.ctx, t.app.locals['auth'] as Auth)
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  const open = (path: string, headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; status?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
      ws.on('open', () => resolve({ ws }))
      ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }))
      ws.on('error', () => {})
    })

  it('round-trips input and output, resizes, and records the session', async () => {
    const d = await create()
    const { ws } = await open(`${base()}/${d.environment.id}/terminal?cols=100&rows=30`, { Authorization: `Bearer ${u.token}` })
    const received = new Promise<string>((resolve) => ws.on('message', (m) => resolve(m.toString())))
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(await received).toBe('echo:ls\r')
    ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40 }))
    await new Promise((r) => setTimeout(r, 50))
    expect(rt.resizes).toEqual([[140, 40]])
    const closed = new Promise((r) => ws.on('close', r))
    ws.send(JSON.stringify({ type: 'input', data: 'exit' }))
    await closed
    await new Promise((r) => setTimeout(r, 50))
    const types = (await u.get(`${base()}/${d.environment.id}`)).body.events.map((e: { type: string }) => e.type)
    expect(types).toEqual(expect.arrayContaining(['terminal.opened', 'terminal.closed']))
  })

  it('refuses missing auth, other orgs, viewers, and cookie sessions from another origin', async () => {
    const d = await create()
    const path = `${base()}/${d.environment.id}/terminal`
    expect((await open(path, {})).status).toBe(401)
    const other = await t.signup('other-term@example.com')
    expect((await open(path, { Authorization: `Bearer ${other.token}` })).status).toBe(404)
    const viewer = await t.signup('viewer-term@example.com')
    await u.post(`/api/orgs/${u.orgSlug}/members`, { email: 'viewer-term@example.com', role: 'viewer' })
    expect((await open(path, { Authorization: `Bearer ${viewer.token}` })).status).toBe(403)
    const cookie = `routini_token=${u.token}`
    expect((await open(path, { Cookie: cookie, Origin: 'https://evil.example' })).status).toBe(403)
    const ok = await open(path, { Cookie: cookie, Origin: new URL(t.ctx.config.clientUrl).origin })
    expect(ok.status).toBeUndefined()
    ok.ws.close()
  })
})
