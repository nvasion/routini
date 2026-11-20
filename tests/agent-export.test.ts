// GET /api/agent/factory-export — Contract part B's pull-back route
// (server/src/routes/agentExport.ts). No session: authenticated by a
// short-lived HS256 pull token that engine/agent.ts mints for config.startFrom.
//
// Tokens are hand-signed with node:crypto rather than importing the
// server-only `jsonwebtoken` package: bare imports of it don't resolve from
// files outside server/ under this workspace's vitest module resolution
// (dockerode and friends do; jsonwebtoken's CJS/export shape doesn't). A
// hand-rolled HS256 token is byte-for-byte what `jsonwebtoken.sign` would
// produce, so the server's own `jwt.verify` accepts it the same way.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import supertest from 'supertest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import type { StepExecutor } from '../server/src/engine/types'
import type { FactoryFetch } from '../server/src/engine/factory'

function base64url(s: string): string {
  return Buffer.from(s).toString('base64url')
}

/** A minimal HS256 JWT: header.payload.signature, matching what jsonwebtoken.sign produces. */
function signPullToken(secret: string, payload: Record<string, unknown>, expiresInSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }))
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

/** Holds a step (and so its run) in 'running' until released, like engine.test.ts's blockingExecutor. */
let release: () => void = () => {}
const hangingAction: StepExecutor = {
  async execute(ctx) {
    await new Promise<void>((resolve, reject) => {
      release = resolve
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return { status: 'succeeded' }
  },
}

let t: TestApp
let u: TestUser
let worker: Worker
let calls: Array<{ url: string; auth: string | null }>
let factoryResponse: { status: number; body: string; contentType: string; headers: Record<string, string> }
const base = () => `/api/orgs/${u.orgSlug}`
const PULL_PATH = '/api/agent/factory-export'

async function startRunningRun(): Promise<{ id: string; number: number }> {
  const job = await u.post(`${base()}/jobs`, { name: 'hang', steps: [{ kind: 'action', config: { type: 'http', url: 'https://example.test/ok' } }] })
  const r = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
  // The same Worker instance for tick() and the afterEach drain(): drain() only awaits
  // the leases its own instance holds, so a second instance can't settle the first's.
  await worker.tick()
  for (let i = 0; i < 300; i++) {
    const detail = (await u.get(`${base()}/runs/${r.body.run.number}`)).body
    if (detail.run.status === 'running') break
    await new Promise((res) => setTimeout(res, 10))
  }
  return r.body.run
}

const pullToken = (run: { id: string }, extra: Partial<Record<string, unknown>> = {}, expiresInSec = 600) =>
  signPullToken(
    t.ctx.config.jwtSecret,
    { k: 'pull', org: u.orgId, run: run.id, step: 1, project: 'proj-1', base: 'main', head: 'routini/factory-1', label: 'task tk_1', ...extra },
    expiresInSec,
  )

describe('GET /api/agent/factory-export', () => {
  beforeEach(async () => {
    calls = []
    factoryResponse = { status: 200, body: 'bundle-bytes', contentType: 'text/plain', headers: { 'x-git-base': 'base1', 'x-git-head': 'head1', 'x-commits': '2', 'x-files-changed': '3' } }
    const factoryFetch: FactoryFetch = async (url, init) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null })
      return new Response(factoryResponse.body, { status: factoryResponse.status, headers: { 'content-type': factoryResponse.contentType, ...factoryResponse.headers } })
    }
    t = await makeTestApp({ engine: { actions: { factoryFetch }, executors: { action: hangingAction } } })
    u = await t.signup('export@example.com')
    await u.put(`${base()}/integrations/factory`, { credentials: { baseUrl: 'https://factory.example', apiToken: 'fk_realtoken0123456789' } })
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 10 })
  })
  afterEach(async () => {
    // Let any still-hanging step finish and settle before the db connection closes,
    // so a late background update never lands on a torn-down pool.
    release()
    await worker.drain()
    await t.close()
  })

  it('rejects a missing or malformed token with 401', async () => {
    const noHeader = await supertest(t.app).get(`${PULL_PATH}?format=bundle`)
    expect(noHeader.status).toBe(401)
    expect(noHeader.body.error).toBe('Pull token is invalid or expired')

    const garbage = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', 'not-a-jwt')
    expect(garbage.status).toBe(401)
    expect(garbage.body.error).toBe('Pull token is invalid or expired')
    expect(calls).toHaveLength(0)
  })

  it('rejects an expired token with 401', async () => {
    const run = await startRunningRun()
    const token = pullToken(run, {}, -10)
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', token)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Pull token is invalid or expired')
  })

  it('rejects a token signed with the wrong secret with 401', async () => {
    const run = await startRunningRun()
    const token = signPullToken('not-the-servers-secret', { k: 'pull', org: u.orgId, run: run.id, step: 1, project: 'proj-1', base: 'main', head: 'h', label: 'task tk_1' }, 600)
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', token)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Pull token is invalid or expired')
  })

  it('rejects a run that is no longer running with 409', async () => {
    const run = await startRunningRun()
    release()
    await worker.drain()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The run is no longer running')
  })

  it('streams the Factory response, passing the X-Git-*/X-Commits/X-Files-Changed headers and the org Factory token', async () => {
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(200)
    expect(res.text).toBe('bundle-bytes')
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['x-git-base']).toBe('base1')
    expect(res.headers['x-git-head']).toBe('head1')
    expect(res.headers['x-commits']).toBe('2')
    expect(res.headers['x-files-changed']).toBe('3')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe('Bearer fk_realtoken0123456789')
    expect(calls[0]!.url).toBe('https://factory.example/api/projects/proj-1/git/export?base=main&head=routini%2Ffactory-1&format=bundle')
  })

  it('requests the patch format when asked', async () => {
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=patch`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toContain('format=patch')
  })

  it('pins the patch to headSha, so work Factory merged later never comes along', async () => {
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=patch`).set('x-routini-pull-token', pullToken(run, { headSha: 'abc123def' }))
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('https://factory.example/api/projects/proj-1/git/export?base=main&head=abc123def&format=patch')
  })

  it('refuses a bundle with 409 when the branch has moved past headSha (the entrypoint then uses the patch)', async () => {
    const run = await startRunningRun()
    const moved = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run, { headSha: 'not-head1' }))
    expect(moved.status).toBe(409)
    expect(moved.body.error).toBe("Factory's branch has moved since the step finished; use the patch")

    const same = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run, { headSha: 'head1' }))
    expect(same.status).toBe(200)
    expect(same.text).toBe('bundle-bytes')
  })

  it('rejects an unknown format with 400', async () => {
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=zip`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(400)
  })

  it('turns a Factory error into a 502 with its message', async () => {
    factoryResponse = { status: 500, body: JSON.stringify({ error: 'orchestration not found' }), contentType: 'application/json', headers: {} }
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('orchestration not found')
  })

  it('502s when the Factory integration is not connected', async () => {
    await u.del(`${base()}/integrations/factory`)
    const run = await startRunningRun()
    const res = await supertest(t.app).get(`${PULL_PATH}?format=bundle`).set('x-routini-pull-token', pullToken(run))
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/Factory integration is not connected/)
  })
})
