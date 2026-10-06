// Agent steps on a fleet host (config.runOn): what the runner is asked to
// start, where the real credentials live, the timeline it produces, and every
// way the host can refuse the work. The runner is the protocol-faithful fake;
// tests/runner-docker.e2e.test.ts covers a real one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import type { Server } from 'node:http'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner, type AgentStart, type EgressStats } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor, type AgentDocker } from '../server/src/engine/agent'
import { NO_AGENTS_ERROR } from '../server/src/runner/gateway'
import { PLACEHOLDER } from '../server/src/egress/types'

const TRANSCRIPT = readFileSync(join(__dirname, '../agents/fake/transcript.jsonl'), 'utf8').trim().split('\n')

const ANTHROPIC = 'sk-ant-api03-FLEET-REALKEY-0123456789'
const GITHUB = 'ghp_FLEETrealtoken0123456789abcdef'
const FLEET_IMAGE = 'ghcr.io/nvasion/routini-agent-claude:latest'
const FLEET_EGRESS_IMAGE = 'ghcr.io/nvasion/routini-egress:latest'
const AGENT_CAPS = ['exec', 'pty', 'agents']

/** A fleet step must never start a container on Routini's own Docker host. */
const noDocker: AgentDocker = {
  async runStreaming() {
    throw new Error('a fleet agent step started a local container')
  },
  async killByLabels() {
    return 0
  },
}

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
      fingerprint: 'fleet-agent-1',
    },
  ],
})

let t: TestApp
let u: TestUser
let server: Server
let baseUrl: string
let base: string
const sockets = new Set<Socket>()

beforeEach(async () => {
  t = await makeTestApp({
    engine: { executors: { agent: agentExecutor({ docker: noDocker, runnerPollMs: 25, runnerOfflineGraceMs: 300 }) } },
  })
  u = await t.signup('fleet-agent@example.com')
  base = `/api/orgs/${u.orgSlug}`
  await u.put(`${base}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
  await u.put(`${base}/integrations/github`, { credentials: { token: GITHUB } })
  server = t.app.listen(0)
  sockets.clear()
  server.on('connection', (s) => sockets.add(s))
  t.ctx.runners.attach(server)
  await t.ctx.runners.start()
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  // Close upgraded sockets first: server.close() waits for every open connection.
  await t.ctx.runners.stop()
  for (const s of sockets) s.destroy()
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  await t.close()
})

// ── Harness ──────────────────────────────────────────────────────────────────

async function enroll(name = 'web-01'): Promise<{ runnerId: string; credential: string; hostId: string; name: string }> {
  const e = await u.post(`${base}/runners/enrollments`, { name, group: 'prod', tags: ['web'] })
  expect(e.status).toBe(201)
  const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.1.0' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}

async function connect(credential: string, o: Partial<ConstructorParameters<typeof FakeRunner>[0]> = {}): Promise<FakeRunner> {
  const r = new FakeRunner({ baseUrl, credential, capabilities: AGENT_CAPS, ...o })
  await r.connect()
  return r
}

/** Replays the fake agent transcript, then exits with (optionally) proxy counters. */
const playTranscript =
  (o: { exitCode?: number; egress?: EgressStats } = {}) =>
  (s: AgentStart, r: FakeRunner) => {
    for (const line of TRANSCRIPT) r.agentOutput(s.id, line)
    r.agentExit(s.id, o.exitCode ?? 0, o.egress ? { egress: o.egress } : {})
  }

/** The runner_tasks rows as stored, payload as text so a test can grep it. */
const taskRows = () =>
  t.ctx.db.system((q) => q.query<{ payload: string; status: string }>(`SELECT payload::text AS payload, status FROM runner_tasks ORDER BY created_at`))

async function agentJob(config: Record<string, unknown>, job: Record<string, unknown> = {}): Promise<string> {
  const res = await u.post(`${base}/jobs`, {
    name: 'Fleet agent',
    steps: [{ id: 'work', name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'Fix the disk alert', ...config } }],
    ...job,
  })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.job.id as string
}

interface RunView {
  detail: { run: { status: string; costUsd: number; agentSeconds: number }; steps: Array<{ status: string; error?: string; output: Record<string, unknown> }> }
  events: Array<{ type: string; data: Record<string, unknown> }>
}

async function view(number: number, id: string): Promise<RunView> {
  return {
    detail: (await u.get(`${base}/runs/${number}`)).body,
    events: (await u.get(`${base}/runs/${id}/events`)).body.events,
  }
}

async function runNow(jobId: string): Promise<RunView> {
  const r = await u.post(`${base}/jobs/${jobId}/run`)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
  return view(r.body.run.number, r.body.run.id)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('agent steps on a fleet host', () => {
  it('starts the container through the runner, with the real keys only in the egress session', async () => {
    const { credential, hostId } = await enroll()
    let started: AgentStart | undefined
    let duringTask: Array<{ payload: string; status: string }> = []
    await connect(credential, {
      onAgent: async (s, r) => {
        started = s
        duringTask = await taskRows()
        playTranscript({ egress: { requests: 9, intercepted: 3, blocked: ['evil.example', 'tracker.example'] } })(s, r)
      },
    })

    const { detail, events } = await runNow(await agentJob({ runOn: { hostId } }))
    expect(detail.steps[0]!.status, detail.steps[0]!.error).toBe('succeeded')
    expect(detail.run.status).toBe('succeeded')

    // The container spec the runner is asked to start.
    expect(started).toMatchObject({
      image: FLEET_IMAGE,
      pull: 'missing',
      user: '1000:1000',
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      timeoutSec: 30 * 60,
      egress: { image: FLEET_EGRESS_IMAGE, network: `routini-sb-${u.orgId}` },
    })
    expect(started!.labels).toMatchObject({ 'routini.managed': 'true', 'routini.org': u.orgId, 'routini.step': '0' })

    // The container itself only ever sees placeholders; the proxy on the host holds the keys.
    expect(started!.env).toMatchObject({ ANTHROPIC_API_KEY: PLACEHOLDER, GITHUB_TOKEN: PLACEHOLDER, ROUTINI_PROMPT: 'Fix the disk alert', ROUTINI_OUTPUT: 'none' })
    const envDump = JSON.stringify(started!.env)
    expect(envDump).not.toContain(ANTHROPIC)
    expect(envDump).not.toContain(GITHUB)
    // The proxy is the runner's business, not ours.
    expect(started!.env).not.toHaveProperty('HTTPS_PROXY')

    const session = started!.egress.session as { token: string; orgId: string; label: string; allowedHosts: string[]; bindings: Array<Record<string, unknown>>; expiresAt: string }
    expect(session).toMatchObject({ orgId: u.orgId, label: 'run 1 step 1' })
    expect(session.token).toMatch(/^[0-9a-f]{48}$/)
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(session.allowedHosts).toEqual(expect.arrayContaining(['api.anthropic.com', 'github.com']))
    expect(session.bindings).toEqual(
      expect.arrayContaining([
        { host: 'api.anthropic.com', header: 'x-api-key', format: 'raw', secret: ANTHROPIC },
        { host: 'api.github.com', header: 'authorization', format: 'bearer', secret: GITHUB },
      ]),
    )
    // Nowhere else in the frame.
    const frame = JSON.parse(JSON.stringify(started)) as AgentStart
    delete (frame.egress.session as Record<string, unknown>)['bindings']
    const frameDump = JSON.stringify(frame)
    expect(frameDump).not.toContain(ANTHROPIC)
    expect(frameDump).not.toContain(GITHUB)

    // The task row never held any of it, and the sealed blob is dropped on finish.
    expect(duringTask).toHaveLength(1)
    expect(duringTask[0]).toMatchObject({ status: 'sent' })
    expect(duringTask[0]!.payload).toContain('"sealed"')
    const after = await taskRows()
    for (const row of [...duringTask, ...after]) {
      expect(row.payload).not.toContain(ANTHROPIC)
      expect(row.payload).not.toContain(GITHUB)
      expect(row.payload).not.toContain(session.token)
    }
    expect(after[0]).toMatchObject({ status: 'done' })
    expect(after[0]!.payload).not.toContain('sealed')

    // The timeline reads like any other agent step, on the named host.
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent.init', 'agent.message', 'agent.tool_call', 'agent.tool_result', 'agent.result', 'cost']))
    expect(events.filter((e) => e.type === 'step.placement').map((e) => e.data)).toEqual([{ target: 'fleet', via: 'runner', host: 'web-01', hostId }])
    expect(events.some((e) => e.type === 'log' && e.data['message'] === `Starting claude agent (${FLEET_IMAGE}) on web-01 via routini-runner`)).toBe(true)

    // What the host's proxy refused, reported from the exit.
    expect(events.filter((e) => e.type === 'egress.blocked').map((e) => e.data)).toEqual([{ hosts: ['evil.example', 'tracker.example'] }])
    expect(events.some((e) => e.type === 'log' && e.data['message'] === "Blocked outbound connections (not on the org's allow-list): evil.example, tracker.example")).toBe(true)

    // Model spend counts; the org's agent minutes do not (it is their own server).
    expect(detail.steps[0]!.output).toMatchObject({ costUsd: 0.0421, model: 'claude-sonnet-5', changes: false })
    expect(detail.run.costUsd).toBeCloseTo(0.0421)
    expect(detail.run.agentSeconds).toBe(0)
  })

  it('keeps the daily budget but not the agent-minute budget or its timeout clamp', async () => {
    const { credential, hostId } = await enroll()
    let started: AgentStart | undefined
    await connect(credential, {
      onAgent: (s, r) => {
        started = s
        playTranscript()(s, r)
      },
    })
    await u.put(base, { limits: { agentMinutesPerDay: 1, dailyBudgetUsd: 1 } })
    const jobId = await agentJob({ runOn: { hostId } })

    const first = await runNow(jobId)
    expect(first.detail.steps[0]!.status, first.detail.steps[0]!.error).toBe('succeeded')
    // 1 minute of agent budget would have clamped a sandbox step to 60s.
    expect(started).toMatchObject({ timeoutSec: 30 * 60 })

    // Agent minutes spent elsewhere today do not hold a fleet step back…
    await t.ctx.db.system((q) => q.query('UPDATE runs SET agent_seconds = 600'))
    const second = await runNow(jobId)
    expect(second.detail.steps[0]!.status, second.detail.steps[0]!.error).toBe('succeeded')

    // …but the model budget does: two runs spent $0.0842.
    await u.put(base, { limits: { agentMinutesPerDay: 1, dailyBudgetUsd: 0.05 } })
    const third = await runNow(jobId)
    expect(third.detail.steps[0]!.error).toMatch(/limit_exceeded:daily_budget/)
  })

  it('refuses a runner that does not run agents, sealing nothing', async () => {
    const { credential, hostId } = await enroll()
    const r = await connect(credential, { capabilities: ['exec', 'pty'] })
    const { detail } = await runNow(await agentJob({ runOn: { hostId } }))
    expect(detail.steps[0]!.error).toBe(`Host "web-01": ${NO_AGENTS_ERROR}`)
    expect(r.frames.some((f) => f['type'] === 'agent.start')).toBe(false)
    expect(await taskRows()).toEqual([])
  })

  it('fails clearly when the host, its runner or its image is gone', async () => {
    const { credential, hostId } = await enroll()
    const r = await connect(credential)

    // No image configured for this agent on fleet hosts.
    const omni = await runNow(await agentJob({ agent: 'omnimancer', runOn: { hostId } }))
    expect(omni.detail.steps[0]!.error).toBe('No fleet image is configured for the omnimancer agent; set ROUTINI_FLEET_AGENT_IMAGE_OMNIMANCER on this server')

    // The runner was revoked.
    const jobId = await agentJob({ runOn: { hostId } })
    const runnerId = (await u.get(`${base}/runners`)).body.runners[0].id as string
    expect((await u.del(`${base}/runners/${runnerId}`)).status).toBe(204)
    await r.closed
    const revoked = await runNow(jobId)
    expect(revoked.detail.steps[0]!.error).toBe('Host "web-01" has no active runner; install routini-runner on it (Fleet → Add server)')

    // The host left the fleet entirely.
    await t.ctx.db.system((q) => q.query('DELETE FROM hosts WHERE id = $1', [hostId]))
    const gone = await runNow(jobId)
    expect(gone.detail.steps[0]!.error).toBe(`The host this agent step runs on (${hostId}) has left the fleet; point the step at another host`)
    expect(await taskRows()).toEqual([])
  })

  it('waits out a runner that is away, then gives up after the grace period', async () => {
    const { credential, hostId } = await enroll()
    const first = await connect(credential)
    first.close()
    await first.closed

    const { detail } = await runNow(await agentJob({ runOn: { hostId } }))
    expect(detail.steps[0]!.error).toBe('The runner on "web-01" is offline')
    // Giving up also scrubs the sealed secrets.
    const rows = await taskRows()
    expect(rows[0]).toMatchObject({ status: 'failed' })
    expect(rows[0]!.payload).not.toContain('sealed')
  })

  it('sends agent.cancel when the run is canceled', async () => {
    const { credential, hostId } = await enroll()
    const r = await connect(credential, { onAgent: () => {} })
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string; id: string }
      if (f.type === 'agent.cancel') r.agentExit(f.id, null, { canceled: true })
    })
    const run = (await u.post(`${base}/jobs/${await agentJob({ runOn: { hostId } })}/run`)).body.run as { number: number }
    const drained = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    await r.next('agent.start')
    expect((await u.post(`${base}/runs/${run.number}/cancel`)).status).toBe(202)
    await drained
    await r.next('agent.cancel')
    expect(r.frames.some((f) => f['type'] === 'exec.cancel')).toBe(false)
    expect((await u.get(`${base}/runs/${run.number}`)).body.run.status).toBe('canceled')
  })

  it('reports a non-zero exit with what the agent said, not just the runner\'s sentence', async () => {
    const { credential, hostId } = await enroll()
    await connect(credential, {
      onAgent: (s, r) => {
        r.agentOutput(s.id, '::routini::{"type":"error","message":"the repo has no package.json"}')
        r.agentExit(s.id, 2)
      },
    })
    const { detail } = await runNow(await agentJob({ runOn: { hostId } }))
    expect(detail.steps[0]!.error).toBe('Agent exited with code 2: the repo has no package.json')
  })

  it('resolves runOn { host: "alert" } to the incident\'s host', async () => {
    const { credential, hostId } = await enroll()
    let started: AgentStart | undefined
    await connect(credential, {
      onAgent: (s, r) => {
        started = s
        playTranscript()(s, r)
      },
    })
    const jobId = await agentJob({ runOn: { host: 'alert' } }, { trigger: { kind: 'alert', match: {} } })
    expect(jobId).toBeTruthy()

    const token = (await u.post(`${base}/alerts/token`)).body.token as string
    const sent = await t.request.post(`/api/alerts/${u.orgSlug}`).set('Authorization', `Bearer ${token}`).send(AM())
    expect(sent.status).toBe(202)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()

    const runs = (await u.get(`${base}/runs`)).body.runs as Array<{ number: number; id: string }>
    expect(runs).toHaveLength(1)
    const { detail, events } = await view(runs[0]!.number, runs[0]!.id)
    expect(detail.steps[0]!.status, detail.steps[0]!.error).toBe('succeeded')
    expect(events.filter((e) => e.type === 'step.placement').map((e) => e.data)).toEqual([{ target: 'fleet', via: 'runner', host: 'web-01', hostId }])
    // The alert context still reaches the prompt inside the container.
    expect(String(started!.env['ROUTINI_PROMPT'])).toContain('## Alert context (incident #1)')
  })
})
