// Environment ops on fleet hosts: RunnerEnvRuntime and RunnerBroker queue an
// `env` runner task and wait for it, the same way exec and agent tasks do
// (runner/exec.ts runRunnerTask). Nothing here is wired into the environment
// manager yet (a later task does that) — these are the runner-plumbing units
// on their own, against the protocol-faithful fake runner.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo, Socket } from 'node:net'
import type { Server } from 'node:http'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner, type EnvOpStart } from './helpers/fakeRunner'
import { EnvHostOfflineError, RunnerBroker, RunnerEnvRuntime } from '../server/src/runner/env'
import { GatewayError, NO_ENVIRONMENTS_ERROR } from '../server/src/runner/gateway'
import { sandboxNetworkName, sandboxNetworkPrefix } from '../server/src/egress/client'
import { sandboxHostConfig } from '../server/src/services/dockerClient'
import type { EgressSession } from '../server/src/egress/types'
import type { EnvContainerSpec } from '../server/src/services/envRuntime'

const ENV_CAPS = ['exec', 'pty', 'agents', 'environments']
const FLEET_EGRESS_IMAGE = 'ghcr.io/nvasion/routini-egress:latest'
const RUNTIME_OPTS = { offlineGraceMs: 300, pollMs: 25 }

let t: TestApp
let u: TestUser
let server: Server
let baseUrl: string
let base: string
const sockets = new Set<Socket>()

beforeEach(async () => {
  t = await makeTestApp()
  u = await t.signup('fleet-env@example.com')
  base = `/api/orgs/${u.orgSlug}`
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
  const r = new FakeRunner({ baseUrl, credential, capabilities: ENV_CAPS, ...o })
  await r.connect()
  return r
}

/** The runner_tasks rows as stored, payload as text so a test can grep it. */
const taskRows = () => t.ctx.db.system((q) => q.query<{ payload: string; status: string }>(`SELECT payload::text AS payload, status FROM runner_tasks ORDER BY created_at`))

function envRuntime(runnerId: string, hostName = 'web-01'): RunnerEnvRuntime {
  return new RunnerEnvRuntime({ db: t.ctx.db, box: t.ctx.box, orgId: u.orgId, runnerId, hostName, ...RUNTIME_OPTS })
}

function broker(runnerId: string, hostName = 'web-01'): RunnerBroker {
  return new RunnerBroker({ db: t.ctx.db, box: t.ctx.box, orgId: u.orgId, runnerId, hostName, egressImage: FLEET_EGRESS_IMAGE, ...RUNTIME_OPTS })
}

/** Answers every env op a happy-path test needs, recording each frame's args by op. */
function happyPath(): { onEnvOp: (s: EnvOpStart, r: FakeRunner) => void; seen: Record<string, EnvOpStart> } {
  const seen: Record<string, EnvOpStart> = {}
  const onEnvOp = (s: EnvOpStart, r: FakeRunner) => {
    seen[s.op] = s
    switch (s.op) {
      case 'container.start':
        return r.envDone(s.id, { data: { containerId: 'container-abc123' } })
      case 'container.state':
        return r.envDone(s.id, { data: { state: 'running' } })
      case 'network.ensure':
        return r.envDone(s.id, { data: { network: sandboxNetworkName(sandboxNetworkPrefix(), u.orgId) } })
      case 'session.open':
        return r.envDone(s.id, { data: { caPem: '-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----' } })
      case 'session.close':
        return r.envDone(s.id, { data: { egress: { requests: 4, intercepted: 2, blocked: ['evil.example'] } } })
      case 'exec':
        r.envOutput(s.id, 'hello from the container')
        return r.envDone(s.id, { exitCode: 0 })
      default:
        return r.envDone(s.id)
    }
  }
  return { onEnvOp, seen }
}

// ── RunnerEnvRuntime ─────────────────────────────────────────────────────────

describe('RunnerEnvRuntime', () => {
  it('sends the right frame for every op and returns what the runner reports', async () => {
    const { credential, runnerId } = await enroll()
    const { onEnvOp, seen } = happyPath()
    await connect(credential, { onEnvOp })
    const rt = envRuntime(runnerId)

    await rt.ensureVolume('env-vol-1', { 'routini.managed': 'true' })
    expect(seen['volume.ensure']).toMatchObject({ op: 'volume.ensure', args: { name: 'env-vol-1', labels: { 'routini.managed': 'true' } } })

    await rt.removeVolume('env-vol-1')
    expect(seen['volume.remove']).toMatchObject({ op: 'volume.remove', args: { name: 'env-vol-1' } })

    const spec: EnvContainerSpec = { name: 'env-1', image: 'routini/agent-claude:latest', volume: 'env-vol-1', labels: { 'routini.env': 'env-1' }, cpus: 2, memoryMb: 4096, network: 'routini-sb-x', env: { FOO: 'bar' } }
    const containerId = await rt.startContainer(spec)
    expect(containerId).toBe('container-abc123')
    expect(seen['container.start']).toMatchObject({
      op: 'container.start',
      args: { name: 'env-1', image: spec.image, volume: 'env-vol-1', labels: { 'routini.env': 'env-1' }, cpus: 2, memoryMb: 4096, pidsLimit: sandboxHostConfig().PidsLimit, network: 'routini-sb-x', env: { FOO: 'bar' } },
    })

    expect(await rt.state(containerId)).toBe('running')
    expect(seen['container.state']).toMatchObject({ op: 'container.state', args: { containerId } })

    const lines: Array<{ line: string; stream: string }> = []
    const execResult = await rt.exec(containerId, ['echo', 'hi'], { env: { SECRET: 'super-secret-value' }, workdir: '/workspace/app', timeoutMs: 4000, onLine: (line, stream) => lines.push({ line, stream }) })
    expect(execResult).toEqual({ exitCode: 0, timedOut: false, aborted: false })
    expect(seen['exec']).toMatchObject({ op: 'exec', args: { containerId, cmd: ['echo', 'hi'], workdir: '/workspace/app', timeoutSec: 4, env: { SECRET: 'super-secret-value' } } })
    expect(lines).toEqual([{ line: 'hello from the container', stream: 'stdout' }])

    await rt.pull('routini/agent-claude:latest')
    expect(seen['pull']).toMatchObject({ op: 'pull', args: { image: 'routini/agent-claude:latest' } })

    await rt.removeContainer(containerId)
    expect(seen['container.remove']).toMatchObject({ op: 'container.remove', args: { containerId } })

    // Nothing secret ever touched the task row, and sealed blobs are scrubbed on finish.
    const rows = await taskRows()
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      expect(row.status).toBe('done')
      expect(row.payload).not.toContain('sealed')
      expect(row.payload).not.toContain('super-secret-value')
    }
  })

  it('defaults exec\'s workdir to /workspace when none is given', async () => {
    const { credential, runnerId } = await enroll()
    const { onEnvOp, seen } = happyPath()
    await connect(credential, { onEnvOp })
    await envRuntime(runnerId).exec('container-x', ['true'], { timeoutMs: 1000, onLine: () => {} })
    expect(seen['exec']).toMatchObject({ args: { workdir: '/workspace' } })
  })

  it('execTty refuses: fleet terminals go through RunnerGateway.openEnvTty', async () => {
    const { credential, runnerId } = await enroll()
    await connect(credential)
    await expect(envRuntime(runnerId).execTty('container-x', { cols: 80, rows: 24 })).rejects.toThrow('Terminals on fleet hosts go through RunnerGateway.openEnvTty')
  })

  it('throws EnvHostOfflineError when the runner never connects, without reporting a container missing', async () => {
    const { runnerId } = await enroll()
    const rt = envRuntime(runnerId)
    await expect(rt.ensureVolume('v', {})).rejects.toThrow(EnvHostOfflineError)
    await expect(rt.state('container-x')).rejects.toThrow('The runner on "web-01" is offline')
    const rows = await taskRows()
    for (const row of rows) expect(row.status).toBe('failed')
  })

  it('refuses a runner without the environments capability, sealing nothing', async () => {
    const { credential, runnerId } = await enroll()
    const r = await connect(credential, { capabilities: ['exec', 'pty', 'agents'] })
    await expect(envRuntime(runnerId).ensureVolume('v', {})).rejects.toThrow(NO_ENVIRONMENTS_ERROR)
    expect(r.frames.some((f) => f['type'] === 'env.op')).toBe(false)
    const rows = await taskRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'failed' })
  })

  it('wraps any other failure as Error(result.error)', async () => {
    const { credential, runnerId } = await enroll()
    await connect(credential, { onEnvOp: (s, r) => r.envDone(s.id, { ok: false, error: 'the host is out of disk space' }) })
    await expect(envRuntime(runnerId).ensureVolume('v', {})).rejects.toThrow('the host is out of disk space')
  })

  it('aborts with env.cancel and resolves (not throws) with aborted: true', async () => {
    const { credential, runnerId } = await enroll()
    const r = await connect(credential, { onEnvOp: () => {} })
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string; id: string }
      if (f.type === 'env.cancel') r.envDone(f.id, { canceled: true })
    })
    const ac = new AbortController()
    const pending = envRuntime(runnerId).exec('container-x', ['sleep', '100'], { timeoutMs: 60_000, signal: ac.signal, onLine: () => {} })
    await r.next('env.op', (f) => f['op'] === 'exec')
    ac.abort()
    expect(await pending).toEqual({ exitCode: null, timedOut: false, aborted: true })
    expect(r.frames.some((f) => f['type'] === 'env.cancel')).toBe(true)
  })
})

// ── RunnerBroker ─────────────────────────────────────────────────────────────

describe('RunnerBroker', () => {
  it('ensures the network, opens and closes a session, and builds the container env from the cached CA', async () => {
    const { credential, runnerId } = await enroll()
    const { onEnvOp, seen } = happyPath()
    await connect(credential, { onEnvOp })
    const b = broker(runnerId)

    const token = b.newToken()
    expect(token).toMatch(/^[0-9a-f]{48}$/)

    const network = await b.network(u.orgId)
    expect(network).toBe(sandboxNetworkName(sandboxNetworkPrefix(), u.orgId))
    expect(seen['network.ensure']).toMatchObject({ args: { network, egressImage: FLEET_EGRESS_IMAGE } })

    await expect(b.containerEnv(token)).rejects.toThrow('containerEnv() called before a session was opened on this host')

    const boundSecret = 'bound-credential-xyz'
    const session: EgressSession = {
      token,
      orgId: u.orgId,
      label: 'env:env-1',
      allowedHosts: ['api.example.com'],
      bindings: [{ host: 'api.example.com', header: 'authorization', format: 'bearer', secret: boundSecret }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await b.open(session)
    expect(seen['session.open']).toMatchObject({ op: 'session.open', args: { session } })
    // The session (token and bound credential) is sealed: the open task's own row never holds it in the clear.
    const openRow = (await taskRows()).find((row) => row.payload.includes('"op": "session.open"'))
    expect(openRow).toBeTruthy()
    expect(openRow!.payload).not.toContain('sealed')
    expect(openRow!.payload).not.toContain(token)
    expect(openRow!.payload).not.toContain(boundSecret)

    const env = await b.containerEnv(token)
    expect(env).toMatchObject({
      HTTPS_PROXY: `http://routini:${token}@routini-egress:3128`,
      HTTP_PROXY: `http://routini:${token}@routini-egress:3128`,
      https_proxy: `http://routini:${token}@routini-egress:3128`,
      http_proxy: `http://routini:${token}@routini-egress:3128`,
      NO_PROXY: '',
      no_proxy: '',
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      ROUTINI_CA_PEM: '-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----',
    })

    const stats = await b.close(token)
    expect(stats).toEqual({ requests: 4, intercepted: 2, blocked: ['evil.example'] })
    // session.close names the session by its (opaque, single-use) token as a plain op arg; that is not a secret.
    expect(seen['session.close']).toMatchObject({ args: { token } })

    // The bound credential never leaks, no matter which task row; every sealed blob is scrubbed on finish.
    const rows = await taskRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.payload).not.toContain('sealed')
      expect(row.payload).not.toContain(boundSecret)
    }
  })

  it('close() never throws, even when the runner is offline', async () => {
    const { runnerId } = await enroll()
    await expect(broker(runnerId).close('whatever-token')).resolves.toBeNull()
  })
})

// ── RunnerGateway.openEnvTty ─────────────────────────────────────────────────

describe('RunnerGateway.openEnvTty', () => {
  it('round-trips data, input, resize and exit over env.tty.*', async () => {
    const { credential, runnerId } = await enroll()
    const r = await connect(credential)
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string; id: string; cols?: number; rows?: number; containerId?: string; b64?: string }
      if (f.type === 'env.tty.open') {
        expect(f).toMatchObject({ containerId: 'container-abc123', cols: 100, rows: 30 })
        r.envTtyOpened(f.id)
        r.envTtyData(f.id, 'workspace$ ')
      }
      if (f.type === 'env.tty.input') r.envTtyData(f.id, `got:${Buffer.from(f.b64 ?? '', 'base64').toString('utf8')}`)
    })
    const pty = await t.ctx.runners.openEnvTty(runnerId, 'container-abc123', 100, 30)
    const chunks: string[] = []
    pty.onData((c) => chunks.push(c.toString('utf8')))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(chunks.join('')).toContain('workspace$ ')

    pty.write('ls\r')
    expect(await r.next('env.tty.input')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(chunks.join('')).toContain('got:ls\r')

    pty.resize(80, 24)
    expect(await r.next('env.tty.resize')).toMatchObject({ cols: 80, rows: 24 })

    pty.close()
    await r.next('env.tty.close')
    expect(await pty.done).toBeNull()
  })

  it('resolves done with the exit code the runner reports', async () => {
    const { credential, runnerId } = await enroll()
    const r = await connect(credential)
    r.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string; id: string }
      if (f.type === 'env.tty.open') r.envTtyOpened(f.id)
    })
    const pty = await t.ctx.runners.openEnvTty(runnerId, 'container-abc123', 80, 24)
    r.envTtyExit(pty.id, 3)
    expect(await pty.done).toBe(3)
  })

  it('refuses without the environments capability, and when the runner is offline', async () => {
    const { credential, runnerId } = await enroll()
    await expect(t.ctx.runners.openEnvTty(runnerId, 'c-1', 80, 24)).rejects.toMatchObject({ status: 503 })
    await connect(credential, { capabilities: ['exec', 'pty', 'agents'] })
    const err = await t.ctx.runners.openEnvTty(runnerId, 'c-1', 80, 24).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ status: 409, message: NO_ENVIRONMENTS_ERROR })
  })
})

// The real runner (routini-runner envx) answers every env.op with exactly this
// frame shape. Written out by hand, not through FakeRunner.envDone, so the
// server is held to PROTOCOL.md 2.8 rather than to the fake.
describe('env.done wire format (PROTOCOL.md 2.8)', () => {
  it('reads the op payload from `result`, as routini-runner sends it', async () => {
    const e = await enroll()
    await connect(e.credential, {
      capabilities: ENV_CAPS,
      onEnvOp: (s, r) => {
        const result =
          s.op === 'network.ensure' ? { network: s.args['network'] } : s.op === 'session.open' ? { caPem: 'PEM' } : s.op === 'container.start' ? { containerId: 'c-1' } : { state: 'running' }
        r.send({ type: 'env.done', id: s.id, ok: true, error: null, exitCode: null, timedOut: false, canceled: false, result })
      },
    })
    const b = broker(e.runnerId)
    expect(await b.network(u.orgId)).toBe(sandboxNetworkName(sandboxNetworkPrefix(), u.orgId))
    await b.open({ token: 'tok', orgId: u.orgId, label: 'env:x', allowedHosts: [], bindings: [], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect((await b.containerEnv('tok'))['ROUTINI_CA_PEM']).toBe('PEM')
    const rt = envRuntime(e.runnerId)
    expect(await rt.startContainer({ name: 'routini-env-x', image: 'ghcr.io/nvasion/routini-agent-claude:latest', volume: 'routini-env-x', labels: {}, cpus: 1, memoryMb: 512 })).toBe('c-1')
    expect(await rt.state('c-1')).toBe('running')
  })
})
