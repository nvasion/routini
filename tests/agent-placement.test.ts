// Agent steps that run on a fleet host instead of the Routini sandbox:
// validating `config.runOn`, and resolving `{ host: 'alert' }` at run time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
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

/** An SSH host and a runner host (enrolled, never connected — validation only needs the row). */
async function sshHost(name = 'web-01'): Promise<string> {
  await u.put(`${base}/credentials/ssh.web`, { value: 'not-a-real-key' })
  const h = await u.post(`${base}/hosts`, { name, address: '10.0.0.11', username: 'deploy', credentialKey: 'ssh.web', tags: ['prod'] })
  expect(h.status).toBe(201)
  return h.body.host.id
}
async function runnerHost(name = 'runner-01'): Promise<string> {
  const e = await u.post(`${base}/runners/enrollments`, { name, group: 'prod', tags: ['prod'] })
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

  it('rejects anything but exactly one of hostId or host: "alert"', async () => {
    const shape = `steps[0].config.runOn must be { hostId } or { host: 'alert' }`
    expect(await error({ runOn: 'host-1' })).toBe(shape)
    expect(await error({ runOn: [{ hostId: UUID }] })).toBe(shape)
    expect(await error({ runOn: null })).toBe(shape)
    expect(await error({ runOn: {} })).toBe(shape)
    expect(await error({ runOn: { hostId: UUID, host: 'alert' } })).toBe(shape)
    expect(await error({ runOn: { hostId: 'not-a-uuid' } })).toBe(shape)
    expect(await error({ runOn: { hostId: 42 } })).toBe(shape)
    expect(await error({ runOn: { host: 'other' } })).toBe(shape)
    expect(await error({ runOn: { host: UUID } })).toBe(shape)
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
})

describe('agent runOn: the alert host', () => {
  const runbook = (config: Record<string, unknown>, trigger: unknown = { kind: 'alert', match: {} }) =>
    u.post(`${base}/jobs`, { name: 'Runbook', trigger, steps: [agentStep(config)] })
  const sendAlert = async (labels: Record<string, string> = {}) => {
    const token = (await u.post(`${base}/alerts/token`)).body.token as string
    const res = await t.request.post(`/api/alerts/${u.orgSlug}`).set('Authorization', `Bearer ${token}`).send(AM(labels))
    expect(res.status).toBe(202)
  }
  const stepOf = async (number: number) => (await u.get(`${base}/runs/${number}`)).body.steps[0]

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
