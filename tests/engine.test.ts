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
import { createSource, getItem, insertItem, setItemState, type StatusMapping } from '../server/src/repos/backlog'

// ── Test doubles ─────────────────────────────────────────────────────────────

/**
 * http actions: /ok → 200, /fail → 500, /flaky-N → fails the first N calls,
 * /echo → 200 with the request headers as the body. Headers sent are kept per path.
 */
const calls = new Map<string, number>()
const sentHeaders = new Map<string, Record<string, string>>()
const fakeFetch: FetchFn = async (url, init) => {
  const path = new URL(url).pathname
  const n = (calls.get(path) ?? 0) + 1
  calls.set(path, n)
  const headers = (init.headers ?? {}) as Record<string, string>
  sentHeaders.set(path, headers)
  if (path === '/echo') return new Response(JSON.stringify(headers), { status: 200 })
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
  sentHeaders.clear()
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

// ── Backlog helpers ──────────────────────────────────────────────────────────

const MAPPING_NONE: StatusMapping = { out: {}, in: { ready: ['Ready'], dropped: ['Dropped'] } }
let backlogSeq = 0
async function backlogSource(extra: Partial<Parameters<typeof createSource>[2]> = {}) {
  backlogSeq++
  return t.ctx.db.org(u.orgId, (q) => createSource(q, u.orgId, { name: `src-${backlogSeq}`, kind: 'repo', config: {}, mapping: MAPPING_NONE, ...extra }))
}
async function backlogItem(sourceId: string, externalId: string, fields: Partial<Parameters<typeof insertItem>[4]> = {}) {
  return t.ctx.db.org(u.orgId, (q) => insertItem(q, u.orgId, sourceId, externalId, { title: 'Item', ...fields }, 'ready'))
}
const getBacklogItem = (id: string) => t.ctx.db.org(u.orgId, (q) => getItem(q, u.orgId, id))
async function backlogJob(steps: unknown[], backlog: { sourceIds?: string[]; labels?: string[]; maxPerFire: number }, cron = '*/5 * * * *') {
  return makeJob(steps, { trigger: { kind: 'cron', expr: cron, tz: 'UTC', backlog } })
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
    // `if`: path root, op, and a later/self step reference.
    expect(await bad({ name: 'x', steps: [http('a', '/ok', { if: { path: 'bogus.x', op: 'eq', value: 'y' } })] })).toMatch(/must start with "steps\.", "trigger\." or "item\."/)
    expect(await bad({ name: 'x', steps: [http('a', '/ok', { if: { path: 'trigger.kind', op: 'between', value: 'y' } })] })).toMatch(/if\.op must be one of/)
    expect(
      await bad({
        name: 'x',
        steps: [http('a', '/ok', { if: { path: 'steps.step-2.statusCode', op: 'eq', value: '200' } }), http('b', '/ok')],
      }),
    ).toMatch(/Step 1 condition refers to step 'step-2', which does not run before it/)
    expect(
      await bad({ name: 'x', steps: [{ id: 's1', ...http('a', '/ok', { if: { path: 'steps.s1.statusCode', op: 'eq', value: '200' } }) }] }),
    ).toMatch(/Step 1 condition refers to step 's1', which does not run before it/)
    // `repo.readOnly` forbids `output: pr | branch`.
    expect(
      await bad({ name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { url: 'https://github.com/a/b', readOnly: true }, output: 'pr' } }] }),
    ).toMatch(/A read-only repository can't produce a pull request or branch/)
    // `startFrom`: must name an earlier Factory action step; needs `repo`, not `environmentId` or a read-only `repo`.
    expect(
      await bad({ name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { url: 'https://github.com/a/b' }, startFrom: { step: 'nope' } } }] }),
    ).toMatch(/startFrom\.step "nope" does not name a step that runs before it/)
    expect(
      await bad({
        name: 'x',
        steps: [
          { id: 'h1', ...http('a', '/ok') },
          { kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { url: 'https://github.com/a/b' }, startFrom: { step: 'h1' } } },
        ],
      }),
    ).toMatch(/startFrom\.step "h1" must be an earlier Factory action step/)
    expect(
      await bad({
        name: 'x',
        steps: [
          { id: 'fac', kind: 'action', config: { type: 'factory', operation: 'prd', prdId: 'prd1' } },
          { kind: 'agent', config: { agent: 'claude', prompt: 'p', environmentId: '00000000-0000-0000-0000-000000000000', startFrom: { step: 'fac' } } },
        ],
      }),
    ).toMatch(/startFrom needs .*\.repo, not .*\.environmentId/)
    expect(
      await bad({
        name: 'x',
        steps: [
          { id: 'fac', kind: 'action', config: { type: 'factory', operation: 'prd', prdId: 'prd1' } },
          { kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { url: 'https://github.com/a/b', readOnly: true }, startFrom: { step: 'fac' } } },
        ],
      }),
    ).toMatch(/A read-only step can't start from Factory's result/)
    // Backlog trigger block: bounds on sourceIds, labels and maxPerFire.
    expect(
      await bad({ name: 'x', trigger: { kind: 'cron', expr: '* * * * *', backlog: { maxPerFire: 0 } }, steps: [http('a', '/ok')] }),
    ).toMatch(/maxPerFire must be an integer between 1 and 20/)
    expect(
      await bad({ name: 'x', trigger: { kind: 'cron', expr: '* * * * *', backlog: { maxPerFire: 21 } }, steps: [http('a', '/ok')] }),
    ).toMatch(/maxPerFire must be an integer between 1 and 20/)
    expect(
      await bad({
        name: 'x',
        trigger: { kind: 'cron', expr: '* * * * *', backlog: { maxPerFire: 1, sourceIds: Array.from({ length: 21 }, () => '00000000-0000-0000-0000-000000000000') } },
        steps: [http('a', '/ok')],
      }),
    ).toMatch(/sourceIds must be a list of up to 20 source ids/)
    expect(
      await bad({ name: 'x', trigger: { kind: 'cron', expr: '* * * * *', backlog: { maxPerFire: 1, labels: Array.from({ length: 11 }, (_, i) => `l${i}`) } }, steps: [http('a', '/ok')] }),
    ).toMatch(/labels must be a list of up to 10 strings/)
    // `item.` is a valid `if` root.
    expect((await u.post(`${base()}/jobs`, { name: 'x', steps: [http('a', '/ok', { if: { path: 'item.title', op: 'exists' } })] })).status).toBe(201)
    // `stage` must be one of planning/building/finishing.
    expect(await bad({ name: 'x', steps: [{ ...http('a', '/ok'), stage: 'nope' }] })).toMatch(/stage must be one of: planning, building, finishing/)
    expect((await u.post(`${base()}/jobs`, { name: 'x', steps: [{ ...http('a', '/ok'), stage: 'building' }] })).status).toBe(201)
    // `repo: { fromItem: true }` is accepted, including with `readOnly`.
    expect((await u.post(`${base()}/jobs`, { name: 'x', steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { fromItem: true, readOnly: true } } }] })).status).toBe(201)
    // Factory `projectId`/`repoUrl` accept the item placeholders exactly, but nothing else invalid.
    expect(
      (
        await u.post(`${base()}/jobs`, {
          name: 'x',
          steps: [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: '{{item.factoryProjectId}}', repoUrl: '{{item.repo}}', request: 'go' } }],
        })
      ).status,
    ).toBe(201)
    expect(
      await bad({ name: 'x', steps: [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: 'not a valid id!', request: 'go' } }] }),
    ).toMatch(/projectId is not a valid id/)
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

  it('skips a step whose `if` condition is false, logging why, without breaking `when` for later steps', async () => {
    const { job } = await makeJob([
      http('check', '/ok', { id: 'check' }), // output: { statusCode: 200 }
      http('eq-true', '/ok', { if: { path: 'steps.check.statusCode', op: 'eq', value: '200' } }),
      http('eq-false', '/ok', { if: { path: 'steps.check.statusCode', op: 'eq', value: '404' } }),
      http('ne-true', '/ok', { if: { path: 'steps.check.statusCode', op: 'ne', value: '404' } }),
      http('in-true', '/ok', { if: { path: 'steps.check.statusCode', op: 'in', value: ['200', '201'] } }),
      http('not_in-true', '/ok', { if: { path: 'steps.check.statusCode', op: 'not_in', value: ['404'] } }),
      http('exists-true', '/ok', { if: { path: 'steps.check.statusCode', op: 'exists' } }),
      http('missing-true', '/ok', { if: { path: 'steps.check.nope', op: 'missing' } }),
      // `on_success` relative to the last step that *ran*: `eq-false` above was skipped, not failed.
      http('after-a-skip', '/ok', { when: 'on_success' }),
    ])
    const run = await startRun(job.id)
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.steps.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ['check', 'succeeded'],
      ['eq-true', 'succeeded'],
      ['eq-false', 'skipped'],
      ['ne-true', 'succeeded'],
      ['in-true', 'succeeded'],
      ['not_in-true', 'succeeded'],
      ['exists-true', 'succeeded'],
      ['missing-true', 'succeeded'],
      ['after-a-skip', 'succeeded'],
    ])
    expect(d.run.status).toBe('succeeded')
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown>; stepIdx: number }>
    const skipLog = events.find((e) => e.type === 'log' && e.stepIdx === 2)
    expect(skipLog!.data['message']).toBe('Skipped: steps.check.statusCode is "200"')
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

// ── Credentials in http headers ──────────────────────────────────────────────

describe('credentials in http headers', () => {
  const TOKEN = 'runner-token-do-not-leak'
  const echo = (headers: Record<string, string>) => ({ id: 'report', name: 'report', kind: 'action', config: { type: 'http', url: 'https://example.test/echo', method: 'POST', headers } })

  it('sends the stored credential and redacts it from the timeline', async () => {
    await u.put(`${base()}/credentials/progeny.runner`, { value: TOKEN })
    const { job } = await makeJob([echo({ Authorization: 'Bearer {{credentials.progeny.runner}}' })])
    const run = await startRun(job.id)
    await worker.drain()
    expect((await getRunDetail(run.number)).run.status).toBe('succeeded')
    expect(sentHeaders.get('/echo')?.['Authorization']).toBe(`Bearer ${TOKEN}`)
    const events = JSON.stringify((await u.get(`${base()}/runs/${run.id}/events`)).body.events)
    expect(events).not.toContain(TOKEN)
    expect(events).toContain('[REDACTED]')
    expect(JSON.stringify((await u.get(`${base()}/jobs/${job.id}`)).body)).toContain('{{credentials.progeny.runner}}')
  })

  it('fails the step when the credential is missing', async () => {
    const { job } = await makeJob([echo({ Authorization: 'Bearer {{credentials.progeny.runner}}' })])
    const run = await startRun(job.id)
    await worker.drain()
    const detail = await getRunDetail(run.number)
    expect(detail.run.status).toBe('failed')
    expect(JSON.stringify(detail)).toMatch(/Credential \\"progeny.runner\\" is missing/)
    expect(sentHeaders.has('/echo')).toBe(false)
  })

  it("never resolves a credential reference that came from the trigger's data", async () => {
    await u.put(`${base()}/credentials/progeny.runner`, { value: TOKEN })
    const { job, webhookSecret } = await makeJob([echo({ 'X-Note': '{{trigger.payload.note}}' })], { trigger: { kind: 'webhook' } })
    const res = await supertest(t.app)
      .post(job.webhookUrl!)
      .set('Authorization', `Bearer ${webhookSecret}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: '{{credentials.progeny.runner}}' }))
    expect(res.status).toBe(202)
    await worker.drain()
    expect(sentHeaders.get('/echo')?.['X-Note']).toBe('{{credentials.progeny.runner}}')
  })

  it('rejects credential references it cannot keep safe', async () => {
    const bad = async (headers: Record<string, string>) => (await u.post(`${base()}/jobs`, { name: 'x', steps: [echo(headers)] })).body.error as string
    expect(await bad({ Authorization: 'Bearer {{credentials.progeny.runner}} {{trigger.kind}}' })).toMatch(/can't mix a credential with other placeholders/)
    expect(await bad({ Authorization: '{{credentials.webhook.abc}}' })).toMatch(/managed by Routini/)
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

// ── Backlog: scheduler ───────────────────────────────────────────────────────

describe('backlog scheduler', () => {
  it('picks at most maxPerFire ready items, skipping blocked, leased and disabled-source items, one run per item', async () => {
    const src = await backlogSource()
    const disabledSrc = await backlogSource({ enabled: false })
    const ready1 = await backlogItem(src.id, 'r1')
    const ready2 = await backlogItem(src.id, 'r2')
    const ready3 = await backlogItem(src.id, 'r3')
    const blocked = await backlogItem(src.id, 'blocked1')
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, blocked.id, 'blocked', { event: 'x' }))
    const onDisabled = await backlogItem(disabledSrc.id, 'd1')

    const { job } = await backlogJob([http('a', '/ok')], { maxPerFire: 2 })
    const due = new Date(job.nextRunAt!)
    const claimed = await schedulerTick(t.ctx.db, new Date(due.getTime() + 1000))
    expect(claimed).toBe(1) // one due job claimed this tick

    const runsList = (await u.get(`${base()}/runs`)).body.runs
    expect(runsList).toHaveLength(2) // maxPerFire caps it: one run per picked item
    expect(runsList.every((r: { trigger: string }) => r.trigger === 'backlog')).toBe(true)

    const after = await Promise.all([ready1, ready2, ready3].map((i) => getBacklogItem(i.id)))
    const leased = after.filter((i) => i!.state === 'planning')
    expect(leased).toHaveLength(2)
    expect(new Set(leased.map((i) => i!.runId)).size).toBe(2) // a distinct run each

    expect((await getBacklogItem(blocked.id))!.state).toBe('blocked')
    expect((await getBacklogItem(onDisabled.id))!.state).toBe('ready')
  })

  it('two concurrent ticks never pick the same item', async () => {
    const src = await backlogSource()
    const items = await Promise.all(['c1', 'c2', 'c3', 'c4'].map((id) => backlogItem(src.id, id)))
    const { job } = await backlogJob([http('a', '/ok')], { maxPerFire: 10 })
    const due = new Date(job.nextRunAt!)
    const after = new Date(due.getTime() + 1000)
    const [n1, n2] = await Promise.all([schedulerTick(t.ctx.db, after), schedulerTick(t.ctx.db, after)])
    expect(n1 + n2).toBe(1) // the job itself is claimed by exactly one tick

    const states = await Promise.all(items.map((i) => getBacklogItem(i.id)))
    expect(states.every((s) => s!.state === 'planning')).toBe(true)
    expect(new Set(states.map((s) => s!.runId)).size).toBe(4) // each item leased to its own run
  })

  it('no ready items means no run, but next_run_at still advances', async () => {
    await backlogSource() // enabled, but no items
    const { job } = await backlogJob([http('a', '/ok')], { maxPerFire: 5 })
    const due = new Date(job.nextRunAt!)
    expect(await schedulerTick(t.ctx.db, new Date(due.getTime() + 1000))).toBe(1)
    expect((await u.get(`${base()}/runs`)).body.runs).toEqual([])
    const updated = (await u.get(`${base()}/jobs/${job.id}`)).body.job
    expect(new Date(updated.nextRunAt).getTime()).toBeGreaterThan(due.getTime())
  })
})

// ── Backlog: stage moves, run-end rules (§5) ─────────────────────────────────

describe('backlog stage and run end', () => {
  async function fireOneItem(steps: unknown[]) {
    const src = await backlogSource()
    const item = await backlogItem(src.id, 'i1')
    const { job } = await backlogJob(steps, { maxPerFire: 1 })
    const due = new Date(job.nextRunAt!)
    await schedulerTick(t.ctx.db, new Date(due.getTime() + 1000))
    const runRow = (await u.get(`${base()}/runs`)).body.runs[0] as { id: string; number: number }
    return { item, run: runRow }
  }

  it("moves the item to a step's stage when that step starts running", async () => {
    const { item, run } = await fireOneItem([{ name: 'build', kind: 'agent', config: { agent: 'claude', prompt: 'wait' }, stage: 'building' }])
    expect((await getBacklogItem(item.id))!.state).toBe('planning') // leased, not yet running

    await worker.tick()
    await until(() => started === 1)
    await until(async () => (await getBacklogItem(item.id))!.state === 'building')
    const events = (await u.get(`${base()}/runs/${run.id}/events`)).body.events

    release()
    await worker.drain()
    void events
  })

  it('a pull request on any step output means done, with built_by naming the Factory step that built it', async () => {
    const prExec: StepExecutor = {
      async execute() {
        return { status: 'succeeded', output: { factory: { kind: 'orchestration' } } }
      },
    }
    const finishExec: StepExecutor = {
      async execute() {
        return { status: 'succeeded', output: { pullRequest: { url: 'https://github.com/a/b/pull/9' } } }
      },
    }
    let call = 0
    const combined: StepExecutor = { execute: (ctx) => (call++ === 0 ? prExec.execute(ctx) : finishExec.execute(ctx)) }
    const t2 = await makeTestApp({ engine: { executors: { agent: combined } } })
    try {
      const u2 = await t2.signup('pr@example.com')
      const src = await t2.ctx.db.org(u2.orgId, (q) => createSource(q, u2.orgId, { name: 's', kind: 'repo', config: {}, mapping: MAPPING_NONE }))
      const built = await t2.ctx.db.org(u2.orgId, (q) => insertItem(q, u2.orgId, src.id, 'x', { title: 'T' }, 'ready'))
      const jobRes = await u2.post(`/api/orgs/${u2.orgSlug}/jobs`, {
        name: 'J',
        trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC', backlog: { maxPerFire: 1 } },
        steps: [
          { name: 'build', kind: 'agent', config: { agent: 'claude', prompt: 'p' } },
          { name: 'finish', kind: 'agent', config: { agent: 'claude', prompt: 'p' } },
        ],
      })
      await schedulerTick(t2.ctx.db, new Date(new Date(jobRes.body.job.nextRunAt).getTime() + 1000))
      await new Worker(t2.ctx, t2.ctx.engine, { heartbeatMs: 20, concurrency: 4 }).drain()
      const final = await t2.ctx.db.org(u2.orgId, (q) => getItem(q, u2.orgId, built.id))
      expect(final).toMatchObject({ state: 'done', pullRequestUrl: 'https://github.com/a/b/pull/9', builtBy: 'factory-orchestration' })
    } finally {
      await t2.close()
    }
  })

  it('success without a pull request blocks the item, naming the run', async () => {
    const { item, run } = await fireOneItem([http('a', '/ok')])
    await worker.drain()
    const final = await getBacklogItem(item.id)
    expect(final).toMatchObject({ state: 'blocked', stateNote: `Run #${run.number} finished without opening a pull request`, runId: null, lastRunId: run.id })
  })

  it('failure blocks the item with the run error', async () => {
    const { item } = await fireOneItem([http('a', '/fail')])
    await worker.drain()
    const final = await getBacklogItem(item.id)
    expect(final!.state).toBe('blocked')
    expect(final!.stateNote).toMatch(/Step "a" failed/)
  })

  it('canceling the run blocks the item, naming the run', async () => {
    const { item, run } = await fireOneItem([blocking()])
    await worker.tick()
    await until(() => started === 1)
    await u.post(`${base()}/runs/${run.number}/cancel`)
    await worker.drain()
    const final = await getBacklogItem(item.id)
    expect(final).toMatchObject({ state: 'blocked', stateNote: `Canceled in run #${run.number}` })
  })

  it('drop_after_run overrides the outcome: the item is dropped, not blocked or done, and the flag clears', async () => {
    const { item } = await fireOneItem([http('a', '/ok')])
    await t.ctx.db.org(u.orgId, (q) => q.query('UPDATE backlog_items SET drop_after_run = true WHERE id = $1', [item.id]))
    await worker.drain()
    const final = await getBacklogItem(item.id)
    expect(final).toMatchObject({ state: 'dropped', stateNote: 'Dropped at the source while a run had it', dropAfterRun: false, runId: null })
  })
})

// ── Backlog: item templates, fromItem repos ──────────────────────────────────

describe('backlog templates and fromItem repos', () => {
  it("renders item.* into step text, same as alert labels (an approval step's message)", async () => {
    const src = await backlogSource()
    const item = await backlogItem(src.id, 'tmpl1', { title: "Fix it; rm -rf / # not really" })
    const { job } = await backlogJob([{ name: 'ok?', kind: 'approval', config: { message: 'Ship "{{item.title}}"?' } }], { maxPerFire: 1 })
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const detail = await getRunDetail(runNumber)
    expect(detail.approvals[0].message).toBe(`Ship "${item.title}"?`)
    expect(detail.run.trigger).toMatchObject({ kind: 'backlog', itemId: item.id, sourceId: src.id })
  })

  it("fails an agent step with repo.fromItem when the run was not started from a backlog item", async () => {
    const { job } = await makeJob([{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { fromItem: true } } }])
    const run = await startRun(job.id)
    await worker.drain()
    const d = await getRunDetail(run.number)
    expect(d.steps[0].error).toBe("This step uses the item's repository, but the run was not started from a backlog item")
  })

  it('fails an agent step with repo.fromItem when neither the item nor its source has a repository', async () => {
    const src = await backlogSource() // no defaultRepoUrl
    const item = await backlogItem(src.id, 'norepo1', { title: 'No repo here' }) // no repoUrl
    const { job } = await backlogJob([{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { fromItem: true } } }], { maxPerFire: 1 })
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const d = await getRunDetail(runNumber)
    expect(d.steps[0].error).toBe(`Item '${item.title}' has no repository; set one on the item or its source`)
  })

  it("resolves repo.fromItem to the item's own repository when set", async () => {
    const src = await backlogSource({ defaultBaseBranch: 'develop' })
    const item = await backlogItem(src.id, 'hasrepo1', { repoUrl: 'https://github.com/a/b' })
    const { job } = await backlogJob([{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { fromItem: true } } }], { maxPerFire: 1 })
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.tick()
    await until(() => started === 1)
    release()
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const d = await getRunDetail(runNumber)
    expect(d.steps[0].status).toBe('succeeded')
    void item
  })

  // Hardening (wave A security review, item 1): an item's repo/baseBranch come straight from
  // the tracker (untrusted). sync.ts already drops anything unsafe to null, but prepareStep
  // re-checks it too — in case of an older row, or `repo.fromItem` resolving a value some other
  // way than the normal sync path.
  it("fails an agent step with repo.fromItem when the item's own repository is not a safe git host", async () => {
    const src = await backlogSource()
    const item = await backlogItem(src.id, 'badrepo1', { title: 'Bad repo', repoUrl: 'ftp://evil.example.com/a/b' })
    const { job } = await backlogJob([{ kind: 'agent', config: { agent: 'claude', prompt: 'p', repo: { fromItem: true } } }], { maxPerFire: 1 })
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const d = await getRunDetail(runNumber)
    expect(d.steps[0].error).toBe(`Item '${item.title}' has an invalid repository`)
  })

  it("fails a Factory step whose repoUrl renders from the item's repository when that repository is unsafe", async () => {
    const src = await backlogSource({ factoryProjectId: 'proj1' })
    const item = await backlogItem(src.id, 'badrepo2', { title: 'Bad repo for factory', repoUrl: 'ftp://evil.example.com/a/b' })
    const { job } = await backlogJob(
      [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: '{{item.factoryProjectId}}', repoUrl: '{{item.repo}}', request: 'go' } }],
      { maxPerFire: 1 },
    )
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const d = await getRunDetail(runNumber)
    expect(d.steps[0].error).toBe(`Item '${item.title}' has an invalid repository`)
  })

  it("fails a Factory step whose projectId renders empty from the item's source", async () => {
    const src = await backlogSource() // no factoryProjectId
    await backlogItem(src.id, 'fac1')
    const { job } = await backlogJob(
      [{ kind: 'action', config: { type: 'factory', operation: 'orchestrate', projectId: '{{item.factoryProjectId}}', request: 'go' } }],
      { maxPerFire: 1 },
    )
    await schedulerTick(t.ctx.db, new Date(new Date(job.nextRunAt!).getTime() + 1000))
    await worker.drain()
    const runNumber = (await u.get(`${base()}/runs`)).body.runs[0].number
    const d = await getRunDetail(runNumber)
    expect(d.steps[0].error).toBe("The item's source has no Factory project")
  })
})
