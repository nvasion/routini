// Opt-in end-to-end: the real DockerService and the real entrypoint, with the
// fake `claude` that replays a transcript (agents/fake). Needs a Docker daemon.
//   ROUTINI_E2E_DOCKER=1 npx vitest run tests/agent-docker.e2e.test.ts
// The image is built from agents/ on first run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor } from '../server/src/engine/agent'
import { DockerService } from '../server/src/services/docker'

const enabled = process.env['ROUTINI_E2E_DOCKER'] === '1'
const IMAGE = 'routini/agent-fake:test'

describe.skipIf(!enabled)('agent container (real Docker)', () => {
  let t: TestApp
  let u: TestUser
  let worker: Worker
  const docker = new DockerService()

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-f', 'fake/Dockerfile', '-t', IMAGE, '.'], { cwd: join(__dirname, '../agents'), stdio: 'pipe' })
    t = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker, images: { claude: IMAGE } }) } } })
    u = await t.signup('e2e@example.com')
    await u.put(`/api/orgs/${u.orgSlug}/settings`, { endpointApiKeys: { anthropic: 'sk-ant-e2e-placeholder-key' } })
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 50 })
  }, 300_000)
  afterAll(async () => {
    await t?.close()
  })

  async function run(prompt: string, extra: Record<string, unknown> = {}) {
    const base = `/api/orgs/${u.orgSlug}`
    const job = await u.post(`${base}/jobs`, { name: 'e2e', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt, ...extra } }] })
    const r = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    return { base, number: r.body.run.number as number, id: r.body.run.id as string }
  }

  it('streams a transcript from a real container, runs the check, records cost', async () => {
    const { base, number, id } = await run('Look at the disk', { check: { command: 'test -d /workspace && echo check-ok' } })
    await worker.drain()
    const d = (await u.get(`${base}/runs/${number}`)).body
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[0].output).toMatchObject({ costUsd: 0.0421, model: 'claude-sonnet-5' })
    const events = (await u.get(`${base}/runs/${id}/events`)).body.events as Array<{ type: string; data: { message?: string; stream?: string } }>
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent.init', 'agent.tool_call', 'agent.tool_result', 'agent.result', 'cost']))
    expect(events.some((e) => e.data.message === '[check] check-ok')).toBe(true)
    expect(events.some((e) => e.data.message === 'plain stderr output from the agent' && e.data.stream === 'stderr')).toBe(true)
    expect(await docker.killByLabels({ 'routini.run': id })).toBe(0) // container was removed
  }, 120_000)

  it('fails the step when the check fails', async () => {
    const { base, number } = await run('Look at the disk', { check: { command: 'echo nope; exit 4' } })
    await worker.drain()
    expect((await u.get(`${base}/runs/${number}`)).body.steps[0].error).toBe('Check command failed (exit 4)')
  }, 120_000)

  it('entrypoint git flow: clone, commit, push a work branch; report no_changes when idle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routini-git-'))
    try {
      const sh = (cmd: string) => execFileSync('bash', ['-c', cmd], { cwd: dir, stdio: 'pipe' }).toString()
      sh(`git init -q --bare -b main app.git && git clone -q app.git seed && cd seed && git config user.email t@t && git config user.name t \
          && echo hi > README.md && git add . && git commit -qm init && git push -q origin main`)
      chmodSync(dir, 0o777)
      sh('chmod -R a+rwX app.git')
      const runIt = (prompt: string, branch: string) =>
        execFileSync('docker', ['run', '--rm', '-v', `${dir}:/remote`, '-e', `ROUTINI_PROMPT=${prompt}`, '-e', 'REPO_URL=file:///remote/app.git',
          '-e', 'BASE_BRANCH=main', '-e', `WORK_BRANCH=${branch}`, '-e', 'ROUTINI_OUTPUT=pr', IMAGE], { stdio: 'pipe' }).toString()

      const edited = runIt('EDIT the notes', 'routini/run-9')
      expect(edited).toMatch(/::routini::\{"type":"commit","sha":"[0-9a-f]{40}","files":1\}/)
      expect(edited).toContain('::routini::{"type":"pushed","branch":"routini/run-9"}')
      expect(sh('git --git-dir=app.git show routini/run-9:NOTES.md')).toBe('Notes written by the fake agent.\n')

      const idle = runIt('just look', 'routini/run-10')
      expect(idle).toContain('::routini::{"type":"no_changes"}')
      expect(sh('git --git-dir=app.git branch --list "routini/run-10"')).toBe('')
    } finally {
      execFileSync('docker', ['run', '--rm', '-v', `${dir}:/d`, 'alpine:3.20', 'sh', '-c', 'rm -rf /d/*'], { stdio: 'pipe' })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('kills a slow container on cancel', async () => {
    const { base, number, id } = await run('SLOW please')
    await worker.tick()
    await new Promise((r) => setTimeout(r, 3000))
    await u.post(`${base}/runs/${number}/cancel`)
    await worker.drain()
    expect((await u.get(`${base}/runs/${number}`)).body.run.status).toBe('canceled')
    expect(await docker.killByLabels({ 'routini.run': id })).toBe(0)
  }, 120_000)
})
