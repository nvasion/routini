// Fleet environments end to end: an environment with a host_id runs its
// lifecycle (create/stop/delete), its agent steps and its terminal through
// that host's own routini-runner instead of Routini's Docker host — and the
// sweeper leaves it alone while the runner is offline, restoring its session
// once it reconnects.
//
// tests/runner-env.test.ts covers RunnerEnvRuntime/RunnerBroker/openEnvTty in
// isolation against the protocol-faithful fake runner; tests/environments.test.ts
// covers environments on Routini's own Docker host. This file is the wiring
// in server/src/engine/environments.ts (placement) and agent.ts between them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeRunner, fleetEnvHappyPath, type EnvOpStart } from './helpers/fakeRunner'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor, type AgentDocker } from '../server/src/engine/agent'
import { attachTerminal } from '../server/src/http/terminal'
import { stepFacts } from '../server/src/engine/policy'
import type { Step } from '../server/src/engine/spec'
import { GatewayError } from '../server/src/runner/gateway'
import { sandboxNetworkName, sandboxNetworkPrefix } from '../server/src/egress/client'
import { sandboxHostConfig } from '../server/src/services/dockerClient'
import { PLACEHOLDER } from '../server/src/egress/types'
import type { Auth } from '../server/src/http/auth'

const TRANSCRIPT = readFileSync(join(__dirname, '../agents/fake/transcript.jsonl'), 'utf8').trim().split('\n')
const ENV_CAPS = ['exec', 'pty', 'agents', 'environments']
const FLEET_IMAGE = 'ghcr.io/nvasion/routini-agent-claude:latest'
const FLEET_EGRESS_IMAGE = 'ghcr.io/nvasion/routini-egress:latest'
const GITHUB = 'ghp_ENVFLEETrealtoken0123456789abcdef'
const ANTHROPIC = 'sk-ant-api03-ENVFLEET-REALKEY-0123456789'

/** A fleet environment's agent step must never start a container on Routini's own Docker host. */
const noDocker: AgentDocker = {
  async runStreaming() {
    throw new Error('an environment step started a local container')
  },
  async killByLabels() {
    return 0
  },
}

let t: TestApp
let u: TestUser
let server: Server
let baseUrl: string
let base: string
const sockets = new Set<Socket>()

beforeEach(async () => {
  t = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker: noDocker, runnerPollMs: 25, runnerOfflineGraceMs: 300 }) } } })
  u = await t.signup('env-fleet@example.com')
  base = `/api/orgs/${u.orgSlug}`
  await u.put(`${base}/settings`, { endpointApiKeys: { anthropic: ANTHROPIC } })
  await u.put(`${base}/integrations/github`, { credentials: { token: GITHUB } })
  server = t.app.listen(0)
  sockets.clear()
  server.on('connection', (s) => sockets.add(s))
  t.ctx.runners.attach(server)
  attachTerminal(server, t.ctx, t.app.locals['auth'] as Auth)
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

async function enroll(name = 'fleet-01'): Promise<{ runnerId: string; credential: string; hostId: string; name: string }> {
  const e = await u.post(`${base}/runners/enrollments`, { name, group: 'prod', tags: ['prod'] })
  expect(e.status, JSON.stringify(e.body)).toBe(201)
  const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.prod.example`, os: 'linux', arch: 'amd64', version: '0.4.0' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}

async function connect(credential: string, o: Partial<ConstructorParameters<typeof FakeRunner>[0]> = {}): Promise<FakeRunner> {
  const r = new FakeRunner({ baseUrl, credential, capabilities: ENV_CAPS, ...o })
  await r.connect()
  return r
}

const taskRows = () => t.ctx.db.system((q) => q.query<{ payload: string; status: string }>(`SELECT payload::text AS payload, status FROM runner_tasks ORDER BY created_at`))

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Creates a fleet environment and waits for provisioning to finish; returns the view. */
async function createEnv(hostId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown> & { id: string; status: string }> {
  const res = await u.post(`${base}/environments`, { name: 'fleet-dev', hostId, ...body })
  expect(res.status, JSON.stringify(res.body)).toBe(202)
  await t.ctx.envs.idle()
  return (await u.get(`${base}/environments/${res.body.environment.id}`)).body.environment
}

// ── Provisioning ─────────────────────────────────────────────────────────────

describe('provisioning a fleet environment', () => {
  it('provisions over the runner in order, sealing the session and proxy vars, and becomes running', async () => {
    const { credential, hostId, name } = await enroll()
    const { onEnvOp, ops } = fleetEnvHappyPath()
    await connect(credential, { onEnvOp })

    const env = await createEnv(hostId, { repo: { url: 'https://github.com/acme/app', branch: 'main' } })
    expect(env).toMatchObject({ status: 'running', hostId, host: { id: hostId, name }, image: FLEET_IMAGE })

    expect(ops.map((o) => o.op)).toEqual(['volume.ensure', 'network.ensure', 'session.open', 'container.start', 'exec', 'exec'])
    const [volumeEnsure, networkEnsure, sessionOpen, containerStart, caExec, cloneExec] = ops as [EnvOpStart, EnvOpStart, EnvOpStart, EnvOpStart, EnvOpStart, EnvOpStart]

    expect(volumeEnsure.args).toMatchObject({ labels: { 'routini.org': u.orgId, 'routini.environment': env.id } })
    expect(networkEnsure.args).toMatchObject({ network: sandboxNetworkName(sandboxNetworkPrefix(), u.orgId), egressImage: FLEET_EGRESS_IMAGE })

    const session = sessionOpen.args['session'] as { token: string; bindings: Array<Record<string, unknown>>; allowedHosts: string[] }
    expect(session.token).toMatch(/^[0-9a-f]{48}$/)
    expect(session.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'github.com', secret: GITHUB })]))
    expect(session.allowedHosts).toContain('github.com')

    expect(containerStart.args).toMatchObject({ image: FLEET_IMAGE, pidsLimit: sandboxHostConfig().PidsLimit })
    const containerEnv = containerStart.args['env'] as Record<string, string>
    expect(containerEnv['HTTPS_PROXY']).toBe(`http://routini:${session.token}@routini-egress:3128`)
    expect(containerEnv['ROUTINI_CA_PEM']).toContain('BEGIN CERTIFICATE')

    expect(caExec.args['cmd']).toEqual(expect.arrayContaining([expect.stringContaining('ROUTINI_CA_PEM')]))
    expect(cloneExec.args['cmd']).toEqual(expect.arrayContaining([expect.stringContaining('clone')]))
    const cloneEnv = cloneExec.args['env'] as Record<string, string>
    // The real token never reaches the sandboxed process; the proxy adds it.
    expect(cloneEnv['GITHUB_TOKEN']).toBe(PLACEHOLDER)

    // Nowhere in the stored task rows, in the clear.
    for (const row of await taskRows()) {
      expect(row.payload).not.toContain(GITHUB)
      expect(row.payload).not.toContain(session.token)
      expect(row.payload).not.toContain('sealed')
    }
  })

  it('stop sends container.remove and session.close; delete also sends volume.remove', async () => {
    const { credential, hostId } = await enroll()
    const { onEnvOp, ops } = fleetEnvHappyPath()
    await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)

    ops.length = 0
    const stopped = await u.post(`${base}/environments/${env.id}/stop`)
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200)
    expect(stopped.body.environment.status).toBe('stopped')
    expect(ops.map((o) => o.op)).toEqual(['container.remove', 'session.close'])

    ops.length = 0
    const deleted = await u.del(`${base}/environments/${env.id}`)
    expect(deleted.status).toBe(204)
    expect(ops.map((o) => o.op)).toContain('volume.remove')
  })

  it('reports the environment\'s own 409 once its host\'s runner is revoked', async () => {
    const { credential, hostId, name, runnerId } = await enroll()
    const { onEnvOp } = fleetEnvHappyPath()
    await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)

    await t.ctx.db.system((q) => q.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [runnerId]))
    const res = await u.post(`${base}/environments/${env.id}/exec`, { command: 'echo hi' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(`The environment's host "${name}" has no active runner`)
  })
})

// ── Agent steps ──────────────────────────────────────────────────────────────

describe('agent steps in a fleet environment', () => {
  it('opens its own session, execs through the runner with that session\'s proxy env, and records no agent minutes', async () => {
    const { credential, hostId, name } = await enroll()
    const sessions: Array<{ token: string }> = []
    const { onEnvOp, ops } = fleetEnvHappyPath({
      'session.open': (s, r) => {
        sessions.push(s.args['session'] as { token: string })
        r.envDone(s.id, { data: { caPem: '-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----' } })
      },
      exec: (s, r) => {
        const cmd = s.args['cmd'] as string[]
        if (cmd[0] === 'routini-entrypoint') {
          for (const line of TRANSCRIPT) r.envOutput(s.id, line)
        }
        r.envDone(s.id, { exitCode: 0 })
      },
    })
    await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)
    // The environment's own session from provisioning; the step below opens a second one.
    expect(sessions).toHaveLength(1)

    const job = await u.post(`${base}/jobs`, {
      name: 'In fleet env',
      steps: [{ id: 'work', name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'fix it', environmentId: env.id, output: 'none' } }],
    })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    const run = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()

    const detail = (await u.get(`${base}/runs/${run.body.run.number}`)).body
    expect(detail.steps[0].status, detail.steps[0].error).toBe('succeeded')
    expect(detail.run.status).toBe('succeeded')
    expect(detail.run.agentSeconds).toBe(0)

    expect(sessions).toHaveLength(2)
    const stepSession = sessions[1]!

    const events = (await u.get(`${base}/runs/${run.body.run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    expect(events.filter((e) => e.type === 'step.placement').map((e) => e.data)).toEqual([{ target: 'fleet', via: 'runner', host: name, hostId, environment: 'fleet-dev' }])
    expect(events.some((e) => e.type === 'log' && e.data['message'] === `Starting claude agent in environment "fleet-dev" on ${name} via routini-runner`)).toBe(true)

    const entrypointExec = ops.find((o) => o.op === 'exec' && (o.args['cmd'] as string[])[0] === 'routini-entrypoint')!
    const execEnv = entrypointExec.args['env'] as Record<string, string>
    expect(execEnv['HTTPS_PROXY']).toBe(`http://routini:${stepSession.token}@routini-egress:3128`)
    expect(execEnv['ANTHROPIC_API_KEY']).toBe(PLACEHOLDER)
    expect(JSON.stringify(execEnv)).not.toContain(ANTHROPIC)

    for (const row of await taskRows()) {
      expect(row.payload).not.toContain(ANTHROPIC)
      expect(row.payload).not.toContain(GITHUB)
    }
  })
})

// ── Sweep ────────────────────────────────────────────────────────────────────

describe('sweep', () => {
  it('leaves a fleet environment running while its runner is offline, sending nothing, then renews its session on reconnect', async () => {
    const { credential, hostId } = await enroll()
    const { onEnvOp, ops } = fleetEnvHappyPath()
    const runner = await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)

    ops.length = 0
    runner.close()
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}`)).body.host.runner.online === false)

    expect(await t.ctx.envs.sweep()).toBe(0)
    expect(ops).toEqual([])
    expect((await u.get(`${base}/environments/${env.id}`)).body.environment.status).toBe('running')

    await connect(credential, { onEnvOp })
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}`)).body.host.runner.online === true)
    expect(await t.ctx.envs.sweep()).toBe(0) // no status change: just a session renewal
    expect(ops.map((o) => o.op)).toEqual(['container.state', 'session.open'])
  })
})

// ── Exec route and terminal ──────────────────────────────────────────────────

describe('exec and terminal over the runner', () => {
  it('runs a one-shot command through the runner', async () => {
    const { credential, hostId } = await enroll()
    const { onEnvOp, ops } = fleetEnvHappyPath({
      exec: (s, r) => {
        r.envOutput(s.id, 'hello from the fleet host')
        r.envDone(s.id, { exitCode: 0 })
      },
    })
    await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)
    ops.length = 0

    const res = await u.post(`${base}/environments/${env.id}/exec`, { command: 'echo hi' })
    expect(res.body).toMatchObject({ exitCode: 0, output: 'hello from the fleet host\n' })
    const cmdExec = ops.find((o) => o.op === 'exec')!
    expect(cmdExec.args['cmd']).toEqual(['bash', '-lc', 'echo hi'])
  })

  it('opens a terminal through the runner\'s PTY', async () => {
    const { credential, hostId } = await enroll()
    const { onEnvOp } = fleetEnvHappyPath()
    const runner = await connect(credential, { onEnvOp })
    runner.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string; id: string; cols?: number; rows?: number; b64?: string }
      if (f.type === 'env.tty.open') runner.envTtyOpened(f.id)
      // Echoes input back, like the environment terminal test on Routini's own Docker host does.
      if (f.type === 'env.tty.input') runner.envTtyData(f.id, `echo:${Buffer.from(f.b64 ?? '', 'base64').toString('utf8')}`)
    })
    const env = await createEnv(hostId)

    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}${base}/environments/${env.id}/terminal?cols=100&rows=30`, { headers: { Authorization: `Bearer ${u.token}` } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('unexpected-response', (_req, r) => reject(new Error(`HTTP ${r.statusCode}`)))
    })
    // Only replying to input (no unsolicited prompt) sidesteps a race between the
    // server pushing data right after the upgrade and the client attaching its listener.
    const received = new Promise<string>((resolve) => ws.once('message', (m) => resolve(m.toString())))
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(await received).toBe('echo:ls\r')
    ws.close()
  })

  it('closes the terminal with the GatewayError message when the host has no active runner', async () => {
    const { credential, hostId } = await enroll()
    const { onEnvOp } = fleetEnvHappyPath()
    const runner = await connect(credential, { onEnvOp })
    const env = await createEnv(hostId)
    runner.close()
    await waitFor(async () => (await u.get(`${base}/hosts/${hostId}`)).body.host.runner.online === false)

    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}${base}/environments/${env.id}/terminal`, { headers: { Authorization: `Bearer ${u.token}` } })
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0))
      ws.on('open', () => resolve(0))
    })
    expect(status).toBe(new GatewayError(503, '').status)
  })
})

// ── Policy ───────────────────────────────────────────────────────────────────

describe('policy', () => {
  it('matches an agent step in a fleet environment by that host\'s tags, as fleet placement', async () => {
    const e = await u.post(`${base}/runners/enrollments`, { name: 'fleet-pol', group: 'prod', tags: ['gpu'] })
    expect(e.status, JSON.stringify(e.body)).toBe(201)
    const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: 'fleet-pol.prod.example', os: 'linux', arch: 'amd64', version: '0.4.0' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const hostId = r.body.hostId as string
    await t.ctx.db.system((q) => q.query('UPDATE runners SET capabilities = $1 WHERE id = $2', [ENV_CAPS, r.body.runnerId]))

    const { onEnvOp } = fleetEnvHappyPath()
    await connect(r.body.credential, { onEnvOp })
    const env = await createEnv(hostId, { name: 'fleet-pol-env' })

    const step: Step = { id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'fix it', environmentId: env.id } }
    const facts = await t.ctx.db.org(u.orgId, (q) => stepFacts(q, u.orgId, step))
    expect(facts).toMatchObject({ kind: 'agent', agentPlacement: 'fleet', host: { tags: ['gpu'], group: 'prod' } })
  })
})
