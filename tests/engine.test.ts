// The engine end to end through the API: jobs, runs, `when`, retries, approvals,
// cancel, crash recovery, concurrency limits, the scheduler, webhooks, redaction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import supertest from 'supertest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { schedulerTick } from '../server/src/engine/scheduler'
import type { StepExecutor } from '../server/src/engine/types'
import type { FetchFn } from '../server/src/services/http'
import type { SshExecutor } from '../server/src/services/ssh'
import type { Run } from '../server/src/repos/runs'

// ── Test doubles ─────────────────────────────────────────────────────────────

/** http actions: /ok → 200, /fail → 500, /flaky-N → fails the first N calls. */
const calls = new Map<string, number>()
const fakeFetch: FetchFn = async (url) => {
  const path = new URL(url).pathname
  const n = (calls.get(path) ?? 0) + 1
  calls.set(path, n)
  const flaky = /^\/flaky-(\d+)$/.exec(path)
  const status = path === '/ok' ? 200 : flaky ? (n <= Number(flaky[1]) ? 503 : 200) : 500
  return new Response(`body for ${path}`, { status })
}

/** "agent" steps in these tests block until released or aborted, to exercise cancel and concurrency. */
let release: () => void = () => {}
let started = 0
const blockingExecutor: StepExecutor = {
  async execute(ctx) {
    started++
    await ctx.log('blocking step started')
    await new Promise<void>((resolve, reject) => {
      release = resolve
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return { status: 'succeeded' }
  },
}

const sshCommands: string[] = []
const fakeSsh: SshExecutor = {
  async exec(config, command) {
    sshCommands.push(command)
    if (command.includes('KERNEL')) {
      return { stdout: 'KERNEL Linux 6.8.0\nUPTIME up 3 days\nDISK 91%\nMEM 3000 4000\n', stderr: '', exitCode: 0 }
    }
    // Echo the credential back, as a misbehaving script might.
    return { stdout: `ran: ${command}\nkey was ${config.privateKey}\n`, stderr: '', exitCode: 0 }
  },
}

const finished: Run[] = []

let t: TestApp
let u: TestUser
let worker: Worker
const base = () => `/api/orgs/${u.orgSlug}`

beforeEach(async () => {
  calls.clear()
  sshCommands.length = 0
  finished.length = 0
  started = 0
  t = await makeTestApp({
    engine: {
      actions: { http: { fetchImpl: fakeFetch, ssrfCheck: async () => true }, sshExecutor: fakeSsh },
      executors: { agent: blockingExecutor },
      onRunFinished: async (run) => {
        finished.push(run)
      },
    },
  })
  u = await t.signup('eng@example.com')
  worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20, concurrency: 4 })
})
afterEach(async () => {
  release()
  await t.close()
})

const http = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: 'action',
  config: { type: 'http', url: `https://example.test${path}` },
  ...extra,
})
const blocking = (name = 'block') => ({ name, kind: 'agent', config: { agent: 'claude', prompt: 'wait' } })

async function makeJob(steps: unknown[], extra: Record<string, unknown> = {}) {
  const res = await u.post(`${base()}/jobs`, { name: 'Job', steps, ...extra })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body as { job: { id: string; nextRunAt: string | null; webhookUrl?: string }; webhookSecret?: string }
}
async function startRun(jobId: string) {
  const res = await u.post(`${base()}/jobs/${jobId}/run`)
  expect(res.status).toBe(201)
  return res.body.run as { id: string; number: number }
}
const getRunDetail = async (ref: string | number) => (await u.get(`${base()}/runs/${ref}`)).body
const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

describe('jobs', () => {
  it('validates specs with useful messages', async () => {
    const bad = async (body: unknown) => (await u.post(`${base()}/jobs`, body)).body.error as string
    expect(await bad({ name: 'x', steps: [] })).toMatch(/steps must be a non-empty array/)
    expect(await bad({ name: 'x', steps: [{ kind: 'nope', config: {} }] })).toMatch(/kind must be one of/)
    expect(await bad({ name: 'x', trigger: { kind: 'cron', expr: '* * *' }, steps: [http('a', '/ok')] })).toMatch(/5-field cron/)
    expect(await bad({ name: 'x', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Olympus' }, steps: [http('a', '/ok')] })).toMatch(/time zone/)
    expect(await bad({ name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { url: 'http://evil.internal/repo' } } }] })).toMatch(/https/)
    expect(await bad({ name: 'x', steps: [{ id: 'a', ...http('a', '/ok') }, { id: 'a', ...http('b', '/ok') }] })).toMatch(/used by another step/)
    expect(await bad({ name: 'x', steps: [{ kind: 'action', config: { type: 'ssh', hostId: '00000000-0000-0000-0000-000000000000', command: 'ls' } }] })).toMatch(/does not match a host/)
  })

  it('computes the next cron fire time and lists jobs with their last run', async () => {
    const { job } = await makeJob([http('a', '/ok')], { trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } })
    expect(new Date(job.nextRunAt!).getUTCHours()).toBe(9)
    await startRun(job.id)
    await worker.drain()
    const list = await u.get(`${base()}/jobs`)
    expect(list.body.jobs[0].lastRun).toMatchObject({ number: 1, status: 'succeeded' })
  })

  it('archives jobs and keeps their runs', async () => {
    const { job } = await makeJob([http('a', '/ok')])
    await startRun(job.id)
    await worker.drain()
    expect((await u.del(`${base()}/jobs/${job.id}`)).status).toBe(204)
    expect((await u.get(`${base()}/jobs`)).body.jobs).toEqual([])
    expect((await u.get(`${base()}/runs/1`)).body.run.status).toBe('succeeded')
    expect((await u.post(`${base()}/jobs/${job.id}/run`)).status).toBe(404)
  })
})

// ── Runs ─────────────────────────────────────────────────────────────────────

describe('runs', () => {
  it('runs steps in order and records a timeline', async () => {
    const { job } = await makeJob([http('first', '/ok'), http('second', '/ok')])
    const run = await startRun(job.id)
    expect((await getRunDetail(run.number)).run.status).toBe('queued')
    await worker.drain()
    const detail = await getRunDetail(run.number)
    expect(detail.run.status).toBe('succeeded')
    expect(detail.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'succeeded'])
    expect(detail.steps[0].output).toEqual({ statusCode: 200 })
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.data['status'])
    expect(statuses).toEqual(['queued', 'running', 'succeeded'])
    expect(events.some((e) => e.type === 'log' && String(e.data['message']).includes('Response status: 200'))).toBe(true)
    expect(events.filter((e) => e.type === 'step.placement').map((e) => e.data)).toEqual([
      { target: 'routini', host: 'Routini worker' },
      { target: 'routini', host: 'Routini worker' },
    ])
    expect(finished.map((r) => r.status)).toEqual(['succeeded'])
  })

  it('numbers runs per org', async () => {
    const { job } = await makeJob([http('a', '/ok')])
    expect((await startRun(job.id)).number).toBe(1)
    expect((await startRun(job.id)).number).toBe(2)
    const other = await t.signup('numbers@example.com')
    const j2 = await other.post(`/api/orgs/${other.orgSlug}/jobs`, { name: 'J', steps: [http('a', '/ok')] })
    expect((await other.post(`/api/orgs/${other.orgSlug}/jobs/${j2.body.job.id}/run`)).body.run.number).toBe(1)
  })

  it('applies `when` relative to the last step that ran', async () => {
    const { job } = await makeJob([
      http('breaks', '/fail'),
      http('only-if-ok', '/ok'),
      http('cleanup', '/ok', { when: 'on_failure' }),
      http('report', '/ok', { when: 'always' }),
    ])
    const run = await startRun(job.id)
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(['failed', 'skipped', 'succeeded', 'succeeded'])
    expect(d.run.status).toBe('failed')
    expect(d.run.error).toMatch(/Step "breaks" failed/)
  })

  it('retries a failing step up to its limit', async () => {
    const { job } = await makeJob([http('flaky', '/flaky-2', { retries: 2 })])
    const run = await startRun(job.id)
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].attempt).toBe(3)

    const { job: j2 } = await makeJob([http('flaky', '/flaky-5', { retries: 1 })])
    const r2 = await startRun(j2.id)
    await worker.drain()
    expect((await getRunDetail(r2.number)).run.status).toBe('failed')
  })

  it('isolates runs between orgs', async () => {
    const { job } = await makeJob([http('a', '/ok')])
    const run = await startRun(job.id)
    const other = await t.signup('snoop@example.com')
    expect((await other.get(`/api/orgs/${u.orgSlug}/runs/${run.id}`)).status).toBe(404)
    expect((await other.get(`/api/orgs/${other.orgSlug}/runs/${run.id}`)).status).toBe(404)
    expect((await other.get(`/api/orgs/${other.orgSlug}/runs`)).body.runs).toEqual([])
  })

  it('reruns a finished run as a new run of the same job', async () => {
    const { job } = await makeJob([http('a', '/fail')])
    await startRun(job.id)
    await worker.drain()
    const rerun = await u.post(`${base()}/runs/1/rerun`)
    expect(rerun.status).toBe(201)
    expect(rerun.body.run.number).toBe(2)
  })
})

// ── Approvals ────────────────────────────────────────────────────────────────

describe('approvals', () => {
  const job = () => makeJob([http('investigate', '/ok'), { name: 'ok to fix?', kind: 'approval', config: { message: 'Clear 5 GB of logs?' } }, http('fix', '/ok')])

  it('parks the run without holding a worker, then resumes on approve', async () => {
    const { job: j } = await job()
    const run = await startRun(j.id)
    await worker.drain()
    let d = await getRunDetail(run.number)
    expect(d.run.status).toBe('waiting')
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'waiting', 'pending'])
    expect(await t.ctx.db.system((q) => q.query('SELECT * FROM queue'))).toEqual([])

    const inbox = (await u.get(`${base()}/inbox`)).body
    expect(inbox.approvals).toEqual([expect.objectContaining({ runNumber: run.number, message: 'Clear 5 GB of logs?', stepName: 'ok to fix?' })])
    expect(inbox.live.map((r: { number: number }) => r.number)).toEqual([run.number])

    expect((await u.post(`${base()}/runs/${run.number}/steps/1/approve`, { comment: 'go' })).status).toBe(200)
    expect((await u.post(`${base()}/runs/${run.number}/steps/1/approve`)).status).toBe(409)
    await worker.drain()
    d = await getRunDetail(run.number)
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[1].output).toEqual({ approvedBy: 'eng@example.com', comment: 'go' })
    expect(d.approvals[0]).toMatchObject({ status: 'approved', comment: 'go' })
  })

  it('a denial fails the step and skips what depends on it', async () => {
    const { job: j } = await job()
    const run = await startRun(j.id)
    await worker.drain()
    await u.post(`${base()}/runs/${run.number}/steps/1/deny`, { comment: 'not during business hours' })
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('failed')
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'failed', 'skipped'])
    expect(d.steps[1].error).toMatch(/Denied by eng@example.com: not during business hours/)
  })

  it('enforces the approval role', async () => {
    const { job: j } = await makeJob([{ name: 'admins only', kind: 'approval', config: { message: 'm', minRole: 'admin' } }])
    const run = await startRun(j.id)
    await worker.drain()
    const member = await t.signup('member@example.com')
    const viewer = await t.signup('viewer@example.com')
    await u.post(`${base()}/members`, { email: 'member@example.com', role: 'member' })
    await u.post(`${base()}/members`, { email: 'viewer@example.com', role: 'viewer' })
    expect((await member.post(`${base()}/runs/${run.number}/steps/0/approve`)).status).toBe(403)
    expect((await viewer.post(`${base()}/runs/${run.number}/steps/0/approve`)).status).toBe(403)
    expect((await u.post(`${base()}/runs/${run.number}/steps/0/approve`)).status).toBe(200)
  })
})

// ── Cancel, recovery, limits ─────────────────────────────────────────────────

describe('cancel', () => {
  it('cancels a queued run immediately', async () => {
    const { job } = await makeJob([http('a', '/ok')])
    const run = await startRun(job.id)
    expect((await u.post(`${base()}/runs/${run.number}/cancel`)).status).toBe(202)
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('canceled')
    expect(d.steps[0].status).toBe('canceled')
    await worker.drain()
    expect(calls.size).toBe(0)
    expect((await u.post(`${base()}/runs/${run.number}/cancel`)).status).toBe(409)
  })

  it('stops a step that is running', async () => {
    const { job } = await makeJob([blocking(), http('after', '/ok')])
    const run = await startRun(job.id)
    await worker.tick()
    await until(() => started === 1)
    await u.post(`${base()}/runs/${run.number}/cancel`)
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('canceled')
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(['canceled', 'canceled'])
    expect(calls.size).toBe(0)
  })

  it('cancels a run waiting for approval and closes the approval', async () => {
    const { job } = await makeJob([{ name: 'gate', kind: 'approval', config: { message: 'm' } }])
    const run = await startRun(job.id)
    await worker.drain()
    await u.post(`${base()}/runs/${run.number}/cancel`)
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('canceled')
    expect(d.approvals[0].status).toBe('canceled')
    expect((await u.get(`${base()}/inbox`)).body.approvals).toEqual([])
  })
})

describe('recovery and limits', () => {
  it('fails (or retries) a step whose worker died mid-step', async () => {
    const { job } = await makeJob([http('was-running', '/ok', { retries: 1 }), http('next', '/ok')])
    const run = await startRun(job.id)
    // Simulate a worker that claimed the run, started step 0, then vanished.
    await t.ctx.db.system(async (q) => {
      await q.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [run.id])
      await q.query(`UPDATE run_steps SET status = 'running', attempt = 1 WHERE run_id = $1 AND idx = 0`, [run.id])
      await q.query(`UPDATE queue SET locked_by = 'dead-worker', locked_until = now() - interval '1 second' WHERE run_id = $1`, [run.id])
    })
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].attempt).toBe(2)
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events
    expect(events.some((e: { data: { message?: string } }) => e.data.message === 'Worker lost while this step was running')).toBe(true)
  })

  it('does not reclaim a run whose lease is still valid', async () => {
    const { job } = await makeJob([http('a', '/ok')])
    const run = await startRun(job.id)
    await t.ctx.db.system((q) => q.query(`UPDATE queue SET locked_by = 'live-worker', locked_until = now() + interval '1 minute' WHERE run_id = $1`, [run.id]))
    expect(await worker.tick()).toBe(0)
  })

  it('caps concurrent runs per org', async () => {
    await u.put(base(), { limits: { maxConcurrentRuns: 1 } })
    const { job } = await makeJob([blocking()])
    await startRun(job.id)
    await startRun(job.id)
    expect(await worker.tick()).toBe(1)
    await until(() => started === 1)
    expect(await worker.tick()).toBe(0)
    const live = (await u.get(`${base()}/runs?status=running,queued`)).body.runs.map((r: { status: string }) => r.status).sort()
    expect(live).toEqual(['queued', 'running'])
    release()
    await until(async () => (await getRunDetail(1)).run.status === 'succeeded')
    expect(await worker.tick()).toBe(1)
    await until(() => started === 2)
    release()
    await worker.drain()
    expect((await getRunDetail(2)).run.status).toBe('succeeded')
  })
})

// ── Scheduler ────────────────────────────────────────────────────────────────

describe('scheduler', () => {
  it('fires a due cron job exactly once per tick, even with concurrent ticks', async () => {
    const { job } = await makeJob([http('a', '/ok')], { trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' } })
    const due = new Date(job.nextRunAt!)
    const after = new Date(due.getTime() + 1000)
    expect(await schedulerTick(t.ctx.db, new Date(due.getTime() - 1000))).toBe(0)
    const counts = await Promise.all([schedulerTick(t.ctx.db, after), schedulerTick(t.ctx.db, after)])
    expect(counts.sort()).toEqual([0, 1])
    const runs = (await u.get(`${base()}/runs`)).body.runs
    expect(runs).toHaveLength(1)
    expect(runs[0].trigger).toBe('cron')
    const updated = (await u.get(`${base()}/jobs/${job.id}`)).body.job
    expect(new Date(updated.nextRunAt).getTime()).toBe(due.getTime() + 5 * 60_000)
  })

  it('collapses ticks missed during downtime into one run', async () => {
    const { job } = await makeJob([http('a', '/ok')], { trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' } })
    const muchLater = new Date(new Date(job.nextRunAt!).getTime() + 3 * 60 * 60_000)
    expect(await schedulerTick(t.ctx.db, muchLater)).toBe(1)
    expect(await schedulerTick(t.ctx.db, muchLater)).toBe(0)
    expect((await u.get(`${base()}/runs`)).body.runs).toHaveLength(1)
  })

  it('ignores disabled and archived jobs', async () => {
    const { job } = await makeJob([http('a', '/ok')], { trigger: { kind: 'cron', expr: '* * * * *', tz: 'UTC' } })
    await u.put(`${base()}/jobs/${job.id}`, { enabled: false })
    expect((await u.get(`${base()}/jobs/${job.id}`)).body.job.nextRunAt).toBeNull()
    expect(await schedulerTick(t.ctx.db, new Date(Date.now() + 3_600_000))).toBe(0)
  })
})

// ── Webhooks ─────────────────────────────────────────────────────────────────

describe('webhooks', () => {
  it('accepts the bearer secret or an HMAC signature, and keeps the payload', async () => {
    const { job, webhookSecret } = await makeJob([http('a', '/ok')], { trigger: { kind: 'webhook' } })
    expect(webhookSecret).toBeTruthy()
    expect((await u.get(`${base()}/jobs/${job.id}`)).body.webhookSecret).toBeUndefined()
    const r = supertest(t.app)
    const url = job.webhookUrl!
    const body = JSON.stringify({ alerts: [{ labels: { alertname: 'HighErrorRate' } }] })

    const bearer = await r.post(url).set('Authorization', `Bearer ${webhookSecret}`).set('Content-Type', 'application/json').send(body)
    expect(bearer.status).toBe(202)
    const sig = `sha256=${createHmac('sha256', webhookSecret!).update(body).digest('hex')}`
    expect((await r.post(url).set('X-Routini-Signature', sig).set('Content-Type', 'application/json').send(body)).status).toBe(202)

    expect((await r.post(url).set('Authorization', 'Bearer wrong').send(body)).status).toBe(404)
    expect((await r.post(url).send(body)).status).toBe(404)
    expect((await r.post(`/api/hooks/nope/${job.id}`).set('Authorization', `Bearer ${webhookSecret}`).send(body)).status).toBe(404)

    const detail = await getRunDetail(bearer.body.number)
    expect(detail.run.trigger).toEqual({ kind: 'webhook', payload: { alerts: [{ labels: { alertname: 'HighErrorRate' } }] } })
  })

  it('rotates the secret on request', async () => {
    const { job, webhookSecret } = await makeJob([http('a', '/ok')], { trigger: { kind: 'webhook' } })
    const rotated = await u.put(`${base()}/jobs/${job.id}`, { rotateWebhookSecret: true })
    expect(rotated.body.webhookSecret).toBeTruthy()
    expect(rotated.body.webhookSecret).not.toBe(webhookSecret)
    const r = supertest(t.app)
    expect((await r.post(job.webhookUrl!).set('Authorization', `Bearer ${webhookSecret}`).send('{}')).status).toBe(404)
    expect((await r.post(job.webhookUrl!).set('Authorization', `Bearer ${rotated.body.webhookSecret}`).send('{}')).status).toBe(202)
  })
})

// ── Hosts + SSH ──────────────────────────────────────────────────────────────

describe('hosts and ssh steps', () => {
  const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsupersecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----'

  async function makeHost(extra: Record<string, unknown> = {}) {
    await u.put(`${base()}/credentials/ssh.prod`, { value: KEY })
    const res = await u.post(`${base()}/hosts`, { name: 'prod-web-02', group: 'prod', address: '10.10.0.12', username: 'deploy', credentialKey: 'ssh.prod', tags: ['web'], ...extra })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.host as { id: string }
  }

  it('checks a host and records its health', async () => {
    const host = await makeHost()
    const check = await u.post(`${base()}/hosts/${host.id}/check`)
    expect(check.body.check).toMatchObject({ ok: true, kernel: 'Linux 6.8.0', uptime: 'up 3 days', diskUsedPct: 91, memUsedPct: 75 })
    expect((await u.get(`${base()}/hosts`)).body.hosts[0].lastCheck.diskUsedPct).toBe(91)
  })

  it('runs ssh steps with the host credential and redacts it from the timeline', async () => {
    const host = await makeHost()
    const { job } = await makeJob([{ name: 'disk', kind: 'action', config: { type: 'ssh', hostId: host.id, command: 'df -h / | tail -1' } }])
    const run = await startRun(job.id)
    await worker.drain()
    expect((await getRunDetail(run.number)).run.status).toBe('succeeded')
    expect(sshCommands).toEqual(['df -h / | tail -1'])
    const events = JSON.stringify((await u.get(`${base()}/runs/${run.id}/events`)).body.events)
    expect(events).toContain('ran: df -h / | tail -1')
    const placement = (JSON.parse(events) as Array<{ type: string; stepIdx: number; data: unknown }>).filter((e) => e.type === 'step.placement')
    expect(placement).toEqual([expect.objectContaining({ stepIdx: 0, data: { target: 'fleet', via: 'ssh', host: host.name, hostId: host.id } })])
    expect(events).not.toContain('supersecretkeymaterial')
    expect(events).toContain('[REDACTED]')
  })

  it('refuses to delete a host a job uses, and rejects duplicate names', async () => {
    const host = await makeHost()
    await makeJob([{ name: 'x', kind: 'action', config: { type: 'ssh', hostId: host.id, command: 'uptime' } }])
    expect((await u.del(`${base()}/hosts/${host.id}`)).status).toBe(409)
    expect((await u.post(`${base()}/hosts`, { name: 'prod-web-02', address: '10.0.0.1', username: 'x' })).status).toBe(409)
  })

  it('blocks private addresses on the hosted service', async () => {
    t.ctx.config.mode = 'hosted'
    const host = await makeHost()
    const check = await u.post(`${base()}/hosts/${host.id}/check`)
    expect(check.body.check.ok).toBe(false)
    expect(check.body.check.error).toMatch(/private or loopback/)
    expect(sshCommands).toEqual([])
  })
})
