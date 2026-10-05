// Opt-in end-to-end for environments on a real Docker daemon, with the fake
// agent image (agents/fake: real entrypoint, replayed Claude transcript).
//   ROUTINI_E2E_DOCKER=1 npx vitest run tests/environments-docker.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { DockerEnvRuntime } from '../server/src/services/envRuntime'
import { agentExecutor } from '../server/src/engine/agent'
import { Worker } from '../server/src/engine/worker'
import { attachTerminal } from '../server/src/http/terminal'
import type { Auth } from '../server/src/http/auth'

const enabled = process.env['ROUTINI_E2E_DOCKER'] === '1'
const IMAGE = 'routini/agent-fake:test'

describe.skipIf(!enabled)('environments (real Docker)', () => {
  let t: TestApp
  let u: TestUser
  let server: Server
  let envId: string
  const runtime = new DockerEnvRuntime()
  const base = () => `/api/orgs/${u.orgSlug}/environments`
  const sh = async (cmd: string) => {
    const res = await u.post(`${base()}/${envId}/exec`, { command: cmd })
    return res.body as { exitCode: number; output: string }
  }

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-f', 'fake/Dockerfile', '-t', IMAGE, '.'], { cwd: join(__dirname, '../agents'), stdio: 'pipe' })
    t = await makeTestApp({ envRuntime: runtime, engine: { executors: { agent: agentExecutor({ images: { claude: IMAGE } }) } } })
    u = await t.signup('env-e2e@example.com')
    await u.put(`/api/orgs/${u.orgSlug}/settings`, { endpointApiKeys: { anthropic: 'sk-ant-e2e-placeholder' } })
    server = t.app.listen(0)
    attachTerminal(server, t.ctx, t.app.locals['auth'] as Auth)
    const res = await u.post(base(), { name: 'e2e', image: IMAGE })
    envId = res.body.environment.id
    await t.ctx.envs.idle()
  }, 300_000)

  afterAll(async () => {
    if (envId) await u.del(`${base()}/${envId}`).catch(() => {})
    await new Promise((r) => server?.close(r))
    await t?.close()
  })

  it('starts as uid 1000 with /workspace writable', async () => {
    expect((await u.get(`${base()}/${envId}`)).body.environment.status).toBe('running')
    const r = await sh('id -u && touch /workspace/probe && echo writable')
    expect(r.output).toBe('1000\nwritable\n')
  })

  it('keeps /workspace across stop and start, but not the container', async () => {
    await sh('echo kept > /workspace/kept.txt && echo gone > /tmp/gone.txt')
    await u.post(`${base()}/${envId}/stop`)
    await u.post(`${base()}/${envId}/start`)
    await t.ctx.envs.idle()
    const r = await sh('cat /workspace/kept.txt; cat /tmp/gone.txt 2>/dev/null || echo tmp-reset')
    expect(r.output).toBe('kept\ntmp-reset\n')
  }, 60_000)

  it('kills the whole process tree when an exec is aborted', async () => {
    const env = await t.ctx.envs.ensureRunning(u.orgId, envId)
    const controller = new AbortController()
    const started = Date.now()
    const p = runtime.exec(env.containerId!, ['bash', '-c', 'sleep 300 & sleep 300; wait'], { timeoutMs: 60_000, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 1000))
    controller.abort()
    const result = await p
    expect(result.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
    // Match the workload's own sleeps, not the kill helper's grace-period sleep.
    const ps = await sh('ps -o args | grep -c "^sleep 300$" || true')
    expect(ps.output.trim()).toBe('0')
  }, 60_000)

  it('serves an interactive terminal over WebSocket', async () => {
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}${base()}/${envId}/terminal?cols=100&rows=30`, { headers: { Authorization: `Bearer ${u.token}` } })
    let out = ''
    ws.on('message', (m) => (out += m.toString()))
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ type: 'input', data: 'echo "sum=$((20+22))"\r' }))
    for (let i = 0; i < 100 && !out.includes('sum=42'); i++) await new Promise((r) => setTimeout(r, 50))
    expect(out).toContain('sum=42')
    const closed = new Promise((r) => ws.on('close', r))
    ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
    await closed
  }, 30_000)

  it('runs an agent step in its own git worktree and pushes the branch', async () => {
    // A "remote" repository inside the environment, and a checkout of it.
    const setup = await sh(
      'cd /workspace && git init -q --bare -b main remote.git && git clone -q remote.git app 2>/dev/null && cd app && ' +
        'git config user.email t@t && git config user.name t && echo hi > README.md && git add . && git commit -qm init && git push -q origin main && echo ready',
    )
    expect(setup.output.trim()).toBe('ready')
    await t.ctx.db.org(u.orgId, (q) =>
      q.query(`UPDATE environments SET repo = $2 WHERE id = $1`, [envId, JSON.stringify({ url: 'file:///workspace/remote.git', branch: 'main', dir: 'app' })]),
    )
    // The spec's repo URL rules (https on a known host) apply to job definitions, not to an environment's own checkout.
    const job = await u.post(`/api/orgs/${u.orgSlug}/jobs`, {
      name: 'Edit in env',
      steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'EDIT the notes', environmentId: envId, output: 'branch' } }],
    })
    await u.post(`/api/orgs/${u.orgSlug}/jobs/${job.body.job.id}/run`)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 50 }).drain()
    const run = (await u.get(`/api/orgs/${u.orgSlug}/runs/1`)).body
    expect(run.run.status).toBe('succeeded')
    expect(run.steps[0].output).toMatchObject({ changes: true, branch: 'routini/run-1' })

    const check = await sh('git --git-dir=/workspace/remote.git show routini/run-1:NOTES.md; cd /workspace/app && git status --porcelain | wc -l; git branch --show-current')
    expect(check.output).toBe('Notes written by the fake agent.\n0\nmain\n')
    const wt = await sh('ls /workspace/.routini/')
    expect(wt.output.trim()).toBe('routini-run-1')
  }, 120_000)

  it('delete removes the container and the volume', async () => {
    const env = await t.ctx.envs.ensureRunning(u.orgId, envId)
    expect((await u.del(`${base()}/${envId}`)).status).toBe(204)
    expect(await runtime.state(env.containerId!)).toBe('missing')
    expect(() => execFileSync('docker', ['volume', 'inspect', env.volume], { stdio: 'pipe' })).toThrow()
    envId = ''
  }, 60_000)
})
