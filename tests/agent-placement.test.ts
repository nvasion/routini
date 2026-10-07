// Agent steps that run on a fleet host instead of the Routini sandbox:
// validating `config.runOn`, and resolving `{ host: 'alert' }` at run time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo, Socket } from 'node:net'
import type { Server } from 'node:http'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import type { AgentConfig } from '../server/src/engine/spec'
import type { StepExecutor } from '../server/src/engine/types'

const UUID = '11111111-2222-3333-4444-555555555555'

const AM = (labels: Record<string, string> = {}) => ({
  version: '4',
  status: 'firing',
  receiver: 'routini',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'web-01:9100', ...labels },
      annotations: { summary: 'Disk above 90%' },
      startsAt: '2026-10-05T10:00:00Z',
      fingerprint: 'abc123',
    },
  ],
})

let t: TestApp
let u: TestUser
let base: string
/** Each agent step's config as the executor saw it — after prepare resolved it. */
let seen: AgentConfig[]

const agent: StepExecutor = {
  async execute(ctx) {
    seen.push(ctx.step.config as AgentConfig)
    return { status: 'succeeded', output: {} }
  },
}

beforeEach(async () => {
  seen = []
  t = await makeTestApp({ engine: { executors: { agent } } })
  u = await t.signup('fleet-agents@example.com')
  base = `/api/orgs/${u.orgSlug}`
})
afterEach(async () => {
  await t.close()
})

const agentStep = (config: Record<string, unknown>) => ({ id: 'work', name: 'Agent', kind: 'agent', config: { agent: 'claude', prompt: 'fix it', ...config } })
const drain = () => new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
const stepOf = async (number: number) => (await u.get(`${base}/runs/${number}`)).body.steps[0]

/** An SSH host and a runner host (enrolled, never connected — validation only needs the row). */
async function sshHost(name = 'web-01'): Promise<string> {
  await u.put(`${base}/credentials/ssh.web`, { value: 'not-a-real-key' })
  const h = await u.post(`${base}/hosts`, { name, address: '10.0.0.11', username: 'deploy', credentialKey: 'ssh.web', tags: ['prod'] })
  expect(h.status).toBe(201)
  return h.body.host.id
}
async function runnerHost(name = 'runner-01', opts: { group?: string; tags?: string[] } = {}): Promise<string> {
  const e = await u.post(`${base}/runners/enrollments`, { name, group: opts.group ?? 'prod', tags: opts.tags ?? ['prod'] })
  expect(e.status).toBe(201)
  const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.1.0' })
  expect(r.status).toBe(201)
  return r.body.hostId as string
}

describe('agent runOn validation', () => {
  const create = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => u.post(`${base}/jobs`, { name: 'Job', steps: [agentStep(config)], ...extra })
  const error = async (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await create(config, extra)
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    return res.body.error as string
  }

  it('rejects anything but exactly one of hostId, host or pool', async () => {
    const shape = `steps[0].config.runOn must be { hostId }, { host: 'alert' } or { pool: { group?, tags? } }`
    expect(await error({ runOn: 'host-1' })).toBe(shape)
    expect(await error({ runOn: [{ hostId: UUID }] })).toBe(shape)
    expect(await error({ runOn: null })).toBe(shape)
    expect(await error({ runOn: {} })).toBe(shape)
    expect(await error({ runOn: { hostId: UUID, host: 'alert' } })).toBe(shape)
    expect(await error({ runOn: { hostId: 'not-a-uuid' } })).toBe(shape)
    expect(await error({ runOn: { hostId: 42 } })).toBe(shape)
    expect(await error({ runOn: { host: 'other' } })).toBe(shape)
    expect(await error({ runOn: { host: UUID } })).toBe(shape)
    expect(await error({ runOn: { hostId: UUID, pool: { group: 'prod' } } })).toBe(shape)
    expect(await error({ runOn: { host: 'alert', pool: { group: 'prod' } } })).toBe(shape)
  })

  describe('pool shape', () => {
    const shape = `steps[0].config.runOn must be { hostId }, { host: 'alert' } or { pool: { group?, tags? } }`
    it('rejects an empty pool (needs a group or tags)', async () => {
      expect(await error({ runOn: { pool: {} } })).toBe(shape)
    })
    it('rejects a bad group', async () => {
      expect(await error({ runOn: { pool: { group: 'bad/group' } } })).toBe(shape)
      expect(await error({ runOn: { pool: { group: 'x'.repeat(61) } } })).toBe(shape)
      expect(await error({ runOn: { pool: { group: 42 } } })).toBe(shape)
    })
    it('rejects bad tags', async () => {
      expect(await error({ runOn: { pool: { tags: ['bad tag'] } } })).toBe(shape)
      expect(await error({ runOn: { pool: { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } } })).toBe(shape)
      expect(await error({ runOn: { pool: { tags: 'prod' } } })).toBe(shape)
      expect(await error({ runOn: { pool: { tags: [42] } } })).toBe(shape)
    })
  })

  it('rejects runOn together with an environment', async () => {
    expect(await error({ runOn: { host: 'alert' }, environmentId: UUID })).toBe('steps[0].config: run on a fleet host or in an environment, not both')
    expect(await error({ runOn: { hostId: UUID }, environmentId: UUID })).toBe('steps[0].config: run on a fleet host or in an environment, not both')
  })

  it('requires the host to exist in this org', async () => {
    expect(await error({ runOn: { hostId: UUID } })).toBe('steps[0].config.runOn.hostId does not match a host in this org')
    // Another org's host is not visible either.
    const other = await t.signup('other@example.com')
    const otherBase = `/api/orgs/${other.orgSlug}`
    await other.put(`${otherBase}/credentials/ssh.web`, { value: 'not-a-real-key' })
    const foreign = await other.post(`${otherBase}/hosts`, { name: 'their-01', address: '10.9.9.9', username: 'deploy', credentialKey: 'ssh.web', tags: [] })
    expect(await error({ runOn: { hostId: foreign.body.host.id } })).toBe('steps[0].config.runOn.hostId does not match a host in this org')
  })

  it('requires a runner host, not an SSH one', async () => {
    const hostId = await sshHost('web-01')
    expect(await error({ runOn: { hostId } })).toBe('steps[0].config.runOn: agents need a host connected with routini-runner; "web-01" uses SSH')
  })

  it('accepts a runner host, and checks the host again on update', async () => {
    const runnerId = await runnerHost('runner-01')
    const created = await create({ runOn: { hostId: runnerId } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.job.steps[0].config.runOn).toEqual({ hostId: runnerId })

    const sshId = await sshHost('web-01')
    const bad = await u.put(`${base}/jobs/${created.body.job.id}`, { steps: [agentStep({ runOn: { hostId: sshId } })] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('steps[0].config.runOn: agents need a host connected with routini-runner; "web-01" uses SSH')
  })

  it('rejects a pool that matches no runner host in this org', async () => {
    expect(await error({ runOn: { pool: { group: 'prod', tags: ['gpu'] } } })).toBe('steps[0].config.runOn: no runner host matches group "prod" and tags ["gpu"]')
    // A matching SSH host does not count: agents need the runner's container tooling.
    await sshHost('web-01')
    expect(await error({ runOn: { pool: { tags: ['prod'] } } })).toBe('steps[0].config.runOn: no runner host matches group "" and tags ["prod"]')
  })

  it('accepts a pool that matches a runner host by group and tags, regardless of online status', async () => {
    await runnerHost('runner-01', { group: 'prod', tags: ['gpu', 'linux'] })
    const created = await create({ runOn: { pool: { group: 'prod', tags: ['gpu'] } } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.job.steps[0].config.runOn).toEqual({ pool: { group: 'prod', tags: ['gpu'] } })
  })
})

describe('agent runOn: the alert host', () => {
  const runbook = (config: Record<string, unknown>, trigger: unknown = { kind: 'alert', match: {} }) =>
    u.post(`${base}/jobs`, { name: 'Runbook', trigger, steps: [agentStep(config)] })
  const sendAlert = async (labels: Record<string, string> = {}) => {
    const token = (await u.post(`${base}/alerts/token`)).body.token as string
    const res = await t.request.post(`/api/alerts/${u.orgSlug}`).set('Authorization', `Bearer ${token}`).send(AM(labels))
    expect(res.status).toBe(202)
  }
  it('resolves to the incident host before the step runs', async () => {
    const hostId = await runnerHost('web-01')
    expect((await runbook({ runOn: { host: 'alert' } })).status).toBe(201)
    await sendAlert({ instance: 'web-01' })
    await drain()

    const step = await stepOf(1)
    expect(step.status, step.error).toBe('succeeded')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.runOn).toEqual({ hostId })
    // The alert context still reaches the prompt.
    expect(seen[0]!.prompt).toContain('## Alert context (incident #1)')
  })

  it('fails clearly when the alert matched no host in the fleet', async () => {
    expect((await runbook({ runOn: { host: 'alert' } })).status).toBe(201)
    await sendAlert({ instance: 'unknown-box:9100' })
    await drain()
    expect((await stepOf(1)).error).toBe("This agent step runs on the alert's host, but the alert did not match a host in the fleet")
    expect(seen).toEqual([])
  })

  it('fails clearly when the run was not started by an alert', async () => {
    const job = await runbook({ runOn: { host: 'alert' } }, { kind: 'manual' })
    expect(job.status).toBe(201)
    expect((await u.post(`${base}/jobs/${job.body.job.id}/run`)).status).toBe(201)
    await drain()
    expect((await stepOf(1)).error).toBe("This agent step runs on the alert's host, but the run was not started by an alert")
    expect(seen).toEqual([])
  })
})

// ── Host pools: prepare picks the least busy host that matches ──────────────
//
// These need a real runner connection (so `runner.online` and its reported
// `facts.docker` are real), but the agent step itself still runs through the
// fake executor above, so no agent.start handling is needed on the fake runner.
describe('agent runOn: a pool of hosts', () => {
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
    await new Promise((resolve) => server.close(resolve))
  })

  async function enrollHost(name: string, group: string, tags: string[]): Promise<{ hostId: string; runnerId: string; credential: string }> {
    const e = await u.post(`${base}/runners/enrollments`, { name, group, tags })
    expect(e.status, JSON.stringify(e.body)).toBe(201)
    const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.1.0' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return { hostId: r.body.hostId as string, runnerId: r.body.runnerId as string, credential: r.body.credential as string }
  }

  /** A row as `queueAgentTask` would leave it, without running a real agent step through it. */
  const recordAgentTask = (runnerId: string) => t.ctx.db.org(u.orgId, (q) => q.query('INSERT INTO runner_tasks (org_id, runner_id, payload) VALUES ($1, $2, $3)', [u.orgId, runnerId, JSON.stringify({ type: 'agent' })]))

  /** Connects a fake runner reporting the given Docker agent-slot facts (omit for "no agents" capability). */
  async function connectAgentHost(credential: string, docker: { agentsRunning: number; maxAgents: number } | null, capabilities = ['exec', 'pty', 'agents']): Promise<FakeRunner> {
    const r = new FakeRunner({ baseUrl, credential, capabilities, facts: docker ? { docker } : {} })
    await r.connect()
    return r
  }

  async function poolJob(pool: { group?: string; tags?: string[] }): Promise<number> {
    const job = await u.post(`${base}/jobs`, { name: 'Pool agent', steps: [agentStep({ runOn: { pool } })] })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    const run = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    return run.body.run.number as number
  }

  it('picks the least busy host, skipping offline, no-agents and full hosts', async () => {
    await enrollHost('pool-offline', 'prod', ['gpu']) // enrolled, never connected
    const noAgents = await enrollHost('pool-noagents', 'prod', ['gpu'])
    await connectAgentHost(noAgents.credential, { agentsRunning: 0, maxAgents: 2 }, ['exec', 'pty'])
    const full = await enrollHost('pool-full', 'prod', ['gpu'])
    await connectAgentHost(full.credential, { agentsRunning: 2, maxAgents: 2 })
    const busy = await enrollHost('pool-busy', 'prod', ['gpu'])
    await connectAgentHost(busy.credential, { agentsRunning: 1, maxAgents: 2 })
    const idle = await enrollHost('pool-idle', 'prod', ['gpu'])
    await connectAgentHost(idle.credential, { agentsRunning: 0, maxAgents: 2 })

    const number = await poolJob({ group: 'prod', tags: ['gpu'] })
    await drain()
    const step = await stepOf(number)
    expect(step.status, step.error).toBe('succeeded')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.runOn).toEqual({ hostId: idle.hostId })
  })

  it('a tie in busyness goes to the least recently used host, never-used first', async () => {
    const a = await enrollHost('pool-a', 'prod', ['gpu'])
    await connectAgentHost(a.credential, { agentsRunning: 0, maxAgents: 2 })
    const b = await enrollHost('pool-b', 'prod', ['gpu'])
    await connectAgentHost(b.credential, { agentsRunning: 0, maxAgents: 2 })

    // Host A's runner has an agent task on record; B, same busyness, never has.
    await recordAgentTask(a.runnerId)

    const number = await poolJob({ group: 'prod', tags: ['gpu'] })
    await drain()
    const step = await stepOf(number)
    expect(step.status, step.error).toBe('succeeded')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.runOn).toEqual({ hostId: b.hostId })
  })

  it("fails clearly when no fleet host matches the pool's group and tags at all", async () => {
    const h = await enrollHost('pool-moved', 'prod', ['gpu'])
    const job = await u.post(`${base}/jobs`, { name: 'Pool agent', steps: [agentStep({ runOn: { pool: { group: 'prod', tags: ['gpu'] } } })] })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    // The host moves out of the pool after the job was saved.
    await t.ctx.db.org(u.orgId, (q) => q.query('UPDATE hosts SET host_group = $1, tags = $2 WHERE org_id = $3 AND id = $4', ['build', ['linux'], u.orgId, h.hostId]))
    const run = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    await drain()
    expect((await stepOf(run.body.run.number)).error).toBe(`No fleet host matches this step's pool (group "prod" and tags ["gpu"])`)
    expect(seen).toEqual([])
  })

  it('fails clearly when matching hosts are not online with agents enabled', async () => {
    await enrollHost('pool-offline-only', 'prod', ['gpu']) // enrolled, never connected
    const number = await poolJob({ group: 'prod', tags: ['gpu'] })
    await drain()
    expect((await stepOf(number)).error).toBe("None of the 1 hosts in this step's pool is online with agents enabled")
    expect(seen).toEqual([])
  })

  it('fails clearly when every matching host is at its agent-slot limit', async () => {
    const h1 = await enrollHost('pool-full-1', 'prod', ['gpu'])
    await connectAgentHost(h1.credential, { agentsRunning: 2, maxAgents: 2 })
    const h2 = await enrollHost('pool-full-2', 'prod', ['gpu'])
    await connectAgentHost(h2.credential, { agentsRunning: 5, maxAgents: 2 })
    const number = await poolJob({ group: 'prod', tags: ['gpu'] })
    await drain()
    expect((await stepOf(number)).error).toBe("All 2 hosts in this step's pool are busy (every agent slot is in use)")
    expect(seen).toEqual([])
  })

  it('holds a pool step for approval when the host it picks is tagged prod', async () => {
    const h = await enrollHost('pool-policy', 'prod', ['prod', 'gpu'])
    await connectAgentHost(h.credential, { agentsRunning: 0, maxAgents: 2 })
    await u.put(`${base}/policy`, { rules: [{ id: 'fleet-prod', name: 'Agents on prod hosts', match: { kinds: ['agent'], hostTags: ['prod'] }, effect: 'require_approval' }] })

    const number = await poolJob({ tags: ['gpu'] })
    await drain()
    const d = (await u.get(`${base}/runs/${number}`)).body
    expect(d.run.status).toBe('waiting')
    expect(d.approvals[0]).toMatchObject({ source: 'policy', rule: 'Agents on prod hosts' })
    expect(seen).toEqual([])

    expect((await u.post(`${base}/runs/${number}/steps/0/approve`)).status).toBe(200)
    await drain()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.runOn).toEqual({ hostId: h.hostId })
  })
})
