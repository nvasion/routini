// Updating a host's routini-runner from the console (PROTOCOL.md 2.7):
// POST /hosts/:id/runner/update → runner.update frame → runner.update.result
// → host events; and GET /runners/latest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner, type FakeRunnerOptions } from './helpers/fakeRunner'
import { NO_UPDATE_ERROR } from '../server/src/runner/gateway'
import { compareTags, normalizeTag, runnerReleasesFromEnv } from '../server/src/services/runnerReleases'

let t: TestApp
let u: TestUser
let base: string
let server: Server
let baseUrl: string
let latest: string | null
const sockets = new Set<import('node:net').Socket>()

beforeEach(async () => {
  latest = 'v0.3.0'
  t = await makeTestApp({ runnerReleases: { latest: async () => latest } })
  u = await t.signup('update@example.com')
  base = `/api/orgs/${u.orgSlug}`
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
  await t.close()
})

async function enrolledRunner(opts: Partial<FakeRunnerOptions> = {}) {
  const e = await u.post(`${base}/runners/enrollments`, { name: 'web-01' })
  const en = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'web-01', os: 'linux', arch: 'amd64', version: '0.2.0' })
  const r = new FakeRunner({ baseUrl, credential: en.body.credential, capabilities: ['exec', 'pty', 'update'], version: '0.2.0', ...opts })
  await r.connect()
  return { r, hostId: en.body.hostId as string }
}

async function events(hostId: string): Promise<Array<{ type: string; userId: string | null; data: Record<string, unknown> }>> {
  return (await u.get(`${base}/hosts/${hostId}/events`)).body.events
}

async function waitForEvent(hostId: string, type: string) {
  const start = Date.now()
  for (;;) {
    const e = (await events(hostId)).find((x) => x.type === type)
    if (e) return e
    if (Date.now() - start > 5000) throw new Error(`no ${type} event`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('updating a runner from the console', () => {
  it('sends runner.update for the latest release and records the outcome', async () => {
    const { r, hostId } = await enrolledRunner({
      onUpdate: (m, rr) => rr.updateResult(m.id, m.version, true, { output: 'checksum verified\nrestart of routini-runner scheduled' }),
    })

    const res = await u.post(`${base}/hosts/${hostId}/runner/update`, {})
    expect(res.status).toBe(202)
    expect(res.body.version).toBe('v0.3.0')

    const frame = await r.next('runner.update')
    expect(frame).toMatchObject({ type: 'runner.update', id: res.body.requestId, version: 'v0.3.0' })

    const done = await waitForEvent(hostId, 'runner.update.succeeded')
    expect(done.data).toMatchObject({ version: 'v0.3.0', output: expect.stringContaining('restart') })
    const requested = (await events(hostId)).find((e) => e.type === 'runner.update.requested')!
    expect(requested.data).toEqual({ version: 'v0.3.0', from: '0.2.0' })
    expect(requested.userId).toBe(u.userId)
  })

  it('records a failed update with the runner\'s error', async () => {
    const { hostId } = await enrolledRunner({
      onUpdate: (m, rr) => rr.updateResult(m.id, m.version, false, { error: 'update to v0.3.0 failed: exit status 1', output: 'error: checksum mismatch' }),
    })
    expect((await u.post(`${base}/hosts/${hostId}/runner/update`, {})).status).toBe(202)
    const failed = await waitForEvent(hostId, 'runner.update.failed')
    expect(failed.data).toMatchObject({ version: 'v0.3.0', error: 'update to v0.3.0 failed: exit status 1', output: 'error: checksum mismatch' })
  })

  it('takes an explicit version and validates it', async () => {
    const { r, hostId } = await enrolledRunner({ onUpdate: (m, rr) => rr.updateResult(m.id, m.version, true) })
    expect((await u.post(`${base}/hosts/${hostId}/runner/update`, { version: 'latest' })).status).toBe(400)
    expect((await u.post(`${base}/hosts/${hostId}/runner/update`, { version: '0.2.0' })).status).toBe(409) // already on it
    const res = await u.post(`${base}/hosts/${hostId}/runner/update`, { version: '0.2.1' })
    expect(res.status).toBe(202)
    expect((await r.next('runner.update'))['version']).toBe('v0.2.1')
  })

  it('refuses runners that cannot update, are offline, or are already current', async () => {
    const old = await enrolledRunner({ capabilities: ['exec', 'pty'] })
    const res = await u.post(`${base}/hosts/${old.hostId}/runner/update`, {})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(NO_UPDATE_ERROR)
    expect(old.r.frames.some((f) => f['type'] === 'runner.update')).toBe(false)

    old.r.close()
    await old.r.closed
    await new Promise((r) => setTimeout(r, 100))
    expect((await u.post(`${base}/hosts/${old.hostId}/runner/update`, {})).body.error).toMatch(/offline/)

    latest = 'v0.2.0'
    const current = await enrolledRunner()
    const same = await u.post(`${base}/hosts/${current.hostId}/runner/update`, {})
    expect(same.status).toBe(409)
    expect(same.body.error).toMatch(/already runs v0\.2\.0/)

    latest = null
    expect((await u.post(`${base}/hosts/${current.hostId}/runner/update`, {})).status).toBe(503)
  })

  it('is for admins only', async () => {
    const { hostId } = await enrolledRunner()
    const member = await t.signup('member-update@example.com')
    await u.post(`${base}/members`, { email: 'member-update@example.com', role: 'member' })
    expect((await member.post(`${base}/hosts/${hostId}/runner/update`, {})).status).toBe(403)
  })

  it('ignores results for updates it never asked for', async () => {
    const { r, hostId } = await enrolledRunner()
    r.updateResult('not-a-request', 'v9.9.9', true)
    await new Promise((res) => setTimeout(res, 150))
    expect((await events(hostId)).some((e) => e.type.startsWith('runner.update'))).toBe(false)
  })

  it('serves the latest release and the host-side commands', async () => {
    const res = await u.get(`${base}/runners/latest`)
    expect(res.body).toEqual({
      version: 'v0.3.0',
      commands: {
        reinstall: expect.stringMatching(/install\.sh \| sudo sh$/),
        enableAgents: 'sudo routini-runner-update --enable-agents',
      },
    })
  })
})

describe('runner releases', () => {
  it('normalizes and compares tags', () => {
    expect(normalizeTag('0.3.0')).toBe('v0.3.0')
    expect(normalizeTag('v1.2.3')).toBe('v1.2.3')
    expect(normalizeTag('v1.2')).toBeNull()
    expect(normalizeTag('0.1.0-test')).toBeNull()
    expect(compareTags('v0.10.0', 'v0.9.9')).toBeGreaterThan(0)
    expect(compareTags('v0.3.0', 'v0.3.0')).toBe(0)
  })

  it('can be pinned or switched off', async () => {
    expect(await runnerReleasesFromEnv({ ROUTINI_RUNNER_LATEST_VERSION: '0.4.0' }).latest()).toBe('v0.4.0')
    expect(await runnerReleasesFromEnv({ ROUTINI_RUNNER_RELEASES: 'off' }).latest()).toBeNull()
    expect(() => runnerReleasesFromEnv({ ROUTINI_RUNNER_LATEST_VERSION: 'newest' })).toThrow(/v1\.2\.3/)
  })

  it('asks GitHub at most once an hour and remembers failures briefly', async () => {
    let calls = 0
    let now = 0
    let answer: Response | Error = new Response(JSON.stringify({ tag_name: 'v0.3.0' }), { status: 200 })
    const fetchImpl = (async () => {
      calls++
      if (answer instanceof Error) throw answer
      return answer.clone()
    }) as unknown as typeof fetch
    const rel = runnerReleasesFromEnv({}, fetchImpl, () => now)

    expect(await rel.latest()).toBe('v0.3.0')
    now += 30 * 60 * 1000
    expect(await rel.latest()).toBe('v0.3.0')
    expect(calls).toBe(1)

    now += 31 * 60 * 1000
    answer = new Error('network down')
    expect(await rel.latest()).toBeNull()
    expect(calls).toBe(2)
    now += 60 * 1000
    expect(await rel.latest()).toBeNull()
    expect(calls).toBe(2) // failure cached

    now += 5 * 60 * 1000
    answer = new Response(JSON.stringify({ tag_name: 'v0.3.1' }), { status: 200 })
    expect(await rel.latest()).toBe('v0.3.1')
  })
})
