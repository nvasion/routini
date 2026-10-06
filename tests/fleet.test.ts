// Fleet: runner enrollment, the gateway (PROTOCOL.md v1) against a fake runner,
// command steps on runner hosts, and host terminals (runner PTY and SSH shell).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner, type ExecStart } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import { attachHostTerminal } from '../server/src/http/hostTerminal'
import type { Auth } from '../server/src/http/auth'
import type { SshShell, SshShellOpener } from '../server/src/services/ssh'

let t: TestApp
let u: TestUser
let server: Server
let baseUrl: string
let base: string
let sshOpened: Array<{ host: string; username: string }>
const sockets = new Set<import('node:net').Socket>()

const sshShell: SshShellOpener = async (config) => {
  sshOpened.push({ host: config.host, username: config.username })
  const em = new EventEmitter()
  let resolveDone!: (c: number | null) => void
  const shell: SshShell = {
    onData: (cb) => em.on('data', cb),
    write: (d) => em.emit('data', Buffer.from(`echo:${d}`)),
    resize: () => {},
    close: () => resolveDone(0),
    done: new Promise((r) => (resolveDone = r)),
  }
  setTimeout(() => em.emit('data', Buffer.from('ssh$ ')), 5)
  return shell
}

beforeEach(async () => {
  sshOpened = []
  t = await makeTestApp({ engine: { actions: { runnerPollMs: 25, runnerOfflineGraceMs: 400, sshShell } } })
  u = await t.signup('fleet@example.com')
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
  // Close upgraded sockets first: server.close() waits for every open connection.
  await t.ctx.runners.stop()
  for (const s of sockets) s.destroy()
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  await t.close()
})

async function enroll(name?: string): Promise<{ runnerId: string; credential: string; hostId: string; name: string }> {
  const e = await u.post(`${base}/runners/enrollments`, name ? { name, group: 'prod', tags: ['web'] } : {})
  expect(e.status).toBe(201)
  const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'web-01.prod.example', os: 'linux', arch: 'amd64', version: '0.1.0' })
  expect(r.status).toBe(201)
  return r.body
}

async function runner(credential: string, onExec?: (s: ExecStart, r: FakeRunner) => void | Promise<void>, extra: Partial<ConstructorParameters<typeof FakeRunner>[0]> = {}) {
  const r = new FakeRunner({ baseUrl, credential, onExec, ...extra })
  await r.connect()
  return r
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function commandJob(hostId: string, command: string, extra: Record<string, unknown> = {}) {
  const job = await u.post(`${base}/jobs`, { name: `cmd ${Math.random()}`, steps: [{ id: 'cmd', name: 'cmd', kind: 'action', config: { type: 'ssh', hostId, command }, ...extra }] })
  expect(job.status).toBe(201)
  const r = await u.post(`${base}/jobs/${job.body.job.id}/run`)
  return { number: r.body.run.number as number, id: r.body.run.id as string }
}

describe('enrollment', () => {
  it('creates a runner host from a one-time token, with install commands', async () => {
    const e = await u.post(`${base}/runners/enrollments`, { name: 'web-01', group: 'prod', tags: ['web'] })
    expect(e.status).toBe(201)
    expect(e.body.token).toMatch(/^rre_/)
    expect(e.body.commands.script).toContain(`--token ${e.body.token}`)
    expect(e.body.commands.docker).toContain('ROUTINI_RUNNER_TOKEN=')

    const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'web-01.prod.example', os: 'linux', arch: 'amd64', version: '0.1.0' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: 'web-01', org: u.orgSlug })
    expect(r.body.credential).toMatch(/^rrc_/)

    const host = (await u.get(`${base}/hosts/${r.body.hostId}`)).body.host
    expect(host).toMatchObject({ name: 'web-01', group: 'prod', tags: ['web'], transport: 'runner', username: null, runner: { id: r.body.runnerId, online: false } })

    // Single use.
    const again = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'x', os: 'linux', arch: 'amd64', version: '0.1.0' })
    expect(again.status).toBe(401)
  })

  it('rejects expired tokens, takes a free name, and is admin-only to create', async () => {
    const e = await u.post(`${base}/runners/enrollments`, {})
    await t.ctx.db.system((q) => q.query(`UPDATE runner_enrollments SET expires_at = now() - interval '1 minute'`))
    expect((await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'h', os: 'linux', arch: 'amd64', version: '1' })).status).toBe(401)

    const a = await enroll()
    const b = await enroll()
    expect(a.name).toBe('web-01')
    expect(b.name).toBe('web-01-2')

    const member = await t.signup('member@example.com')
    await t.ctx.db.system((q) => q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, [u.orgId, member.userId]))
    expect((await member.post(`${base}/runners/enrollments`, {})).status).toBe(403)
  })
})

describe('gateway', () => {
  it('refuses a wrong protocol version (426) and bad credentials (401)', async () => {
    const { credential } = await enroll()
    await expect(new FakeRunner({ baseUrl, credential, protocol: '2' }).connect()).rejects.toMatchObject({ status: 426 })
    await expect(new FakeRunner({ baseUrl, credential: 'rrc_nope' }).connect()).rejects.toMatchObject({ status: 401 })
  })

  it('welcomes a runner, records hello facts, and tracks online/offline', async () => {
    const { credential, hostId, runnerId } = await enroll('db-01')
    const r = await runner(credential)
    expect(r.frames[0]).toMatchObject({ type: 'welcome', runnerId, name: 'db-01' })

    const host = (await u.get(`${base}/hosts/${hostId}`)).body.host
    expect(host.runner).toMatchObject({ online: true, version: '0.1.0-test', hostname: 'web-01.prod.example', capabilities: ['exec', 'pty'] })
    expect(host.address).toBe('10.0.0.11')
    expect(host.lastCheck).toMatchObject({ ok: true, diskUsedPct: 63, memUsedPct: 41, kernel: 'Linux 6.8.0', uptime: 'up 1 day, 1 hour' })

    r.send({ type: 'facts', facts: { diskUsedPct: 91, memUsedPct: 12 } })
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}`)).body.host.lastCheck.diskUsedPct === 91)
    expect((await u.post(`${base}/hosts/${hostId}/check`)).body.check).toMatchObject({ ok: true, diskUsedPct: 91 })

    r.close()
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}`)).body.host.runner.online === false)
    expect((await u.post(`${base}/hosts/${hostId}/check`)).body.check).toMatchObject({ ok: false, error: 'The runner is offline' })
    const events = (await u.get(`${base}/hosts/${hostId}/events`)).body.events.map((e: { type: string }) => e.type)
    expect(events).toEqual(['runner.disconnected', 'runner.connected'])
  })

  it('replaces an older connection with close code 4000', async () => {
    const { credential } = await enroll()
    const first = await runner(credential)
    await runner(credential)
    expect(await first.closed).toBe(4000)
  })

  it('revoking sends `revoked`, closes, and refuses the credential afterwards', async () => {
    const { credential, runnerId } = await enroll()
    const r = await runner(credential)
    expect((await u.del(`${base}/runners/${runnerId}`)).status).toBe(204)
    await r.next('revoked')
    await r.closed
    await expect(new FakeRunner({ baseUrl, credential }).connect()).rejects.toMatchObject({ status: 401 })
  })
})

describe('command steps on runner hosts', () => {
  it('streams output into the timeline and records stdout and the exit code', async () => {
    const { credential, hostId } = await enroll()
    await runner(credential, (s, r) => {
      r.output(s.id, 'Filesystem Size Used')
      r.output(s.id, 'warning: low disk', 'stderr')
      r.output(s.id, '/dev/sda1 79G 72G')
      r.exit(s.id, 0)
    })
    const { number, id } = await commandJob(hostId, 'df -h /', { timeoutSec: 30 })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()

    const d = (await u.get(`${base}/runs/${number}`)).body
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].output).toEqual({ hostId, exitCode: 0, stdout: 'Filesystem Size Used\n/dev/sda1 79G 72G\n' })
    const events = (await u.get(`${base}/runs/${id}/events`)).body.events.filter((e: { type: string }) => e.type === 'log').map((e: { data: unknown }) => e.data)
    expect(events).toEqual(expect.arrayContaining([{ message: 'Filesystem Size Used' }, { message: 'warning: low disk', stream: 'stderr' }]))
    const placement = (await u.get(`${base}/runs/${id}/events`)).body.events.filter((e: { type: string }) => e.type === 'step.placement')
    expect(placement).toEqual([expect.objectContaining({ stepIdx: 0, data: { target: 'fleet', via: 'runner', host: expect.any(String), hostId } })])
  })

  it('sends the command, env and timeout as exec.start; non-zero exit fails the step', async () => {
    const { credential, hostId } = await enroll()
    const r = await runner(credential, (s, rr) => rr.exit(s.id, 3))
    const { number } = await commandJob(hostId, 'systemctl restart nginx', { timeoutSec: 45 })
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    expect(await r.next('exec.start')).toMatchObject({ command: 'systemctl restart nginx', timeoutSec: 45, env: {}, cwd: null })
    const d = (await u.get(`${base}/runs/${number}`)).body
    expect(d.steps[0]).toMatchObject({ status: 'failed', error: 'Command exited with code 3', output: { exitCode: 3 } })
  })

  it('fails clearly when the runner stays offline', async () => {
    const { hostId } = await enroll()
    const { number } = await commandJob(hostId, 'uptime')
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    expect((await u.get(`${base}/runs/${number}`)).body.steps[0].error).toBe('The runner on "web-01" is offline')
  })

  it('runs a command queued while the runner was briefly away once it reconnects', async () => {
    const { credential, hostId } = await enroll()
    const { number } = await commandJob(hostId, 'uptime')
    const drained = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    await new Promise((r) => setTimeout(r, 100))
    await runner(credential)
    await drained
    expect((await u.get(`${base}/runs/${number}`)).body.steps[0]).toMatchObject({ status: 'succeeded', output: { stdout: 'ran: uptime\n' } })
  })

  it('fails the step when the runner disconnects mid-command', async () => {
    const { credential, hostId } = await enroll()
    await runner(credential, (_s, rr) => setTimeout(() => rr.ws.terminate(), 50))
    const { number } = await commandJob(hostId, 'sleep 100')
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    expect((await u.get(`${base}/runs/${number}`)).body.steps[0].error).toBe('Runner: Runner disconnected')
  })

  it('cancels the command on the runner when the run is canceled', async () => {
    const { credential, hostId } = await enroll()
    const r = await runner(credential, () => {})
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.type === 'exec.cancel') r.exit(f.id, null, { canceled: true })
    })
    const { number } = await commandJob(hostId, 'sleep 100')
    const drained = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    await r.next('exec.start')
    await u.post(`${base}/runs/${number}/cancel`)
    await drained
    await r.next('exec.cancel')
    expect((await u.get(`${base}/runs/${number}`)).body.run.status).toBe('canceled')
  })
})

describe('host terminals', () => {
  const open = (path: string, token: string) =>
    new Promise<{ ws: WebSocket; status?: number; data: string[] }>((resolve) => {
      const data: string[] = []
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}${path}`, { headers: { Authorization: `Bearer ${token}` } })
      ws.on('message', (m) => data.push(m.toString()))
      ws.on('open', () => resolve({ ws, data }))
      ws.on('unexpected-response', (_q, res) => resolve({ ws, status: res.statusCode, data }))
    })

  it('relays a runner PTY and audits the session', async () => {
    const { credential, hostId } = await enroll()
    const r = await runner(credential)
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.type === 'pty.open') {
        r.send({ type: 'pty.opened', id: f.id })
        r.send({ type: 'pty.data', id: f.id, b64: Buffer.from('web-01$ ').toString('base64') })
      }
      if (f.type === 'pty.input') r.send({ type: 'pty.data', id: f.id, b64: Buffer.from(`got:${Buffer.from(f.b64, 'base64').toString()}`).toString('base64') })
    })
    const term = await open(`${base}/hosts/${hostId}/terminal?cols=100&rows=30`, u.token)
    expect(term.status).toBeUndefined()
    expect(await r.next('pty.open')).toMatchObject({ cols: 100, rows: 30 })
    term.ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    term.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
    await waitFor(async () => term.data.join('').includes('got:ls\r'))
    expect(term.data.join('')).toContain('web-01$ ')
    expect(await r.next('pty.resize')).toMatchObject({ cols: 90, rows: 20 })
    term.ws.close()
    await r.next('pty.close')
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}/events`)).body.events.some((e: { type: string }) => e.type === 'terminal.closed'))
    const types = (await u.get(`${base}/hosts/${hostId}/events`)).body.events.map((e: { type: string; data: { via?: string } }) => `${e.type}:${e.data.via ?? ''}`)
    expect(types).toEqual(expect.arrayContaining(['terminal.opened:runner', 'terminal.closed:runner']))
  })

  it('reports a runner that refuses terminals, and offline runners', async () => {
    const { credential, hostId } = await enroll()
    expect((await open(`${base}/hosts/${hostId}/terminal`, u.token)).status).toBe(503)
    const r = await runner(credential, undefined, { capabilities: ['exec'] })
    expect((await open(`${base}/hosts/${hostId}/terminal`, u.token)).status).toBe(409)
    r.close()
  })

  it('opens an SSH shell for SSH hosts; members are refused', async () => {
    await u.put(`${base}/credentials/ssh.lab`, { value: 'not-a-real-key' })
    const h = await u.post(`${base}/hosts`, { name: 'lab-01', address: '192.168.1.40', username: 'deploy', credentialKey: 'ssh.lab' })
    const term = await open(`${base}/hosts/${h.body.host.id}/terminal`, u.token)
    expect(term.status).toBeUndefined()
    await waitFor(async () => term.data.join('').includes('ssh$ '))
    term.ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }))
    await waitFor(async () => term.data.join('').includes('echo:whoami'))
    expect(sshOpened).toEqual([{ host: '192.168.1.40', username: 'deploy' }])
    term.ws.close()

    const member = await t.signup('member2@example.com')
    await t.ctx.db.system((q) => q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, [u.orgId, member.userId]))
    expect((await open(`${base}/hosts/${h.body.host.id}/terminal`, member.token)).status).toBe(403)
  })
})

describe('runner hosts in the inventory', () => {
  it('allows renaming and retagging only, and removing revokes the runner', async () => {
    const { credential, hostId } = await enroll()
    const r = await runner(credential)
    const put = await u.put(`${base}/hosts/${hostId}`, { name: 'web-prod-01', tags: ['web', 'prod'], address: '1.2.3.4' })
    expect(put.body.host).toMatchObject({ name: 'web-prod-01', tags: ['web', 'prod'], address: '10.0.0.11', transport: 'runner' })
    expect((await u.del(`${base}/hosts/${hostId}`)).status).toBe(204)
    await r.next('revoked')
    expect((await u.get(`${base}/runners`)).body.runners).toEqual([])
  })
})
