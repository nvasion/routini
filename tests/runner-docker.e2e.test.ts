// Opt-in end-to-end: the real routini-runner (Go, container image built from
// ../routini-runner) enrolls against a real Routini server, runs a command step,
// serves a terminal, reports facts, and exits when revoked.
//   ROUTINI_E2E_DOCKER=1 npx vitest run tests/runner-docker.e2e.test.ts
// Needs the routini-runner checkout next to this repo (or ROUTINI_RUNNER_SRC).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { attachHostTerminal } from '../server/src/http/hostTerminal'
import type { Auth } from '../server/src/http/auth'

const enabled = process.env['ROUTINI_E2E_DOCKER'] === '1'
const SRC = process.env['ROUTINI_RUNNER_SRC'] ?? join(__dirname, '../../routini-runner')
const IMAGE = 'routini/runner:e2e'
const NAME = 'routini-runner-e2e'
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString().trim()

describe.skipIf(!enabled || !existsSync(SRC))('routini-runner (real container)', () => {
  let t: TestApp
  let u: TestUser
  let server: Server
  let port: number
  let base: string

  beforeAll(async () => {
    docker('build', '-q', '-t', IMAGE, SRC)
    try {
      docker('rm', '-f', NAME)
    } catch {
      // not running
    }
    t = await makeTestApp({ engine: { actions: { runnerPollMs: 50 } } })
    u = await t.signup('e2e-runner@example.com')
    base = `/api/orgs/${u.orgSlug}`
    server = await new Promise<Server>((resolve) => {
      const s = t.app.listen(0, '0.0.0.0', () => resolve(s))
    })
    attachHostTerminal(server, t.ctx, t.app.locals['auth'] as Auth)
    t.ctx.runners.attach(server)
    await t.ctx.runners.start()
    port = (server.address() as AddressInfo).port
  }, 600_000)

  afterAll(async () => {
    try {
      docker('rm', '-f', NAME)
    } catch {
      // gone
    }
    await t?.ctx.runners.stop()
    server?.closeAllConnections?.()
    await new Promise((r) => server?.close(r))
    await t?.close()
  })

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> => {
    const start = Date.now()
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() - start > ms) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  it('enrolls, runs commands, serves a terminal, and exits on revoke', async () => {
    const e = await u.post(`${base}/runners/enrollments`, { name: 'e2e-box', group: 'lab' })
    // host-gateway: the container reaches this test server on the Docker host (a private address).
    docker('run', '-d', '--init', '--name', NAME, '--add-host', 'routini:host-gateway', '-e', `ROUTINI_RUNNER_URL=http://routini:${port}`, '-e', `ROUTINI_RUNNER_TOKEN=${e.body.token}`, IMAGE)

    const host = await waitFor(async () => {
      const hosts = (await u.get(`${base}/hosts`)).body.hosts as Array<{ id: string; name: string; runner: { online: boolean; version: string } | null; lastCheck: { diskUsedPct?: number } | null }>
      return hosts.find((h) => h.name === 'e2e-box' && h.runner?.online)
    })
    expect(host.runner!.version).toBe('0.1.0')
    expect(host.lastCheck?.diskUsedPct).toEqual(expect.any(Number))

    // A command step on the runner host: real /bin/sh, as the runner user, output streamed back.
    const job = await u.post(`${base}/jobs`, {
      name: 'whoami',
      steps: [{ id: 'who', name: 'who', kind: 'action', config: { type: 'ssh', hostId: host.id, command: 'id -un; echo "home=$HOME"; echo oops >&2; exit 0' } }],
    })
    const run = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 50 }).drain()
    const d = (await u.get(`${base}/runs/${run.body.run.number}`)).body
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].output).toMatchObject({ exitCode: 0, stdout: 'routini-runner\nhome=/home/routini-runner\n' })
    const events = (await u.get(`${base}/runs/${run.body.run.id}/events`)).body.events
    expect(events.some((ev: { data: { message?: string; stream?: string } }) => ev.data.message === 'oops' && ev.data.stream === 'stderr')).toBe(true)

    // Interactive terminal through the runner's PTY.
    const out: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}${base}/hosts/${host.id}/terminal?cols=100&rows=30`, { headers: { Authorization: `Bearer ${u.token}` } })
    ws.on('message', (m) => out.push(m.toString()))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('unexpected-response', (_q, res) => reject(new Error(`terminal HTTP ${res.statusCode}`)))
    })
    ws.send(JSON.stringify({ type: 'input', data: 'echo "pty-$((6*7))"\r' }))
    await waitFor(async () => out.join('').includes('pty-42'), 10_000)
    ws.close()

    // Removing the runner: it gets `revoked` and exits 78 (no restart loop).
    const runnerId = (await u.get(`${base}/runners`)).body.runners[0].id
    expect((await u.del(`${base}/runners/${runnerId}`)).status).toBe(204)
    await waitFor(async () => docker('inspect', '-f', '{{.State.Running}}', NAME) === 'false', 15_000)
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', NAME)).toBe('78')
  }, 300_000)
})
