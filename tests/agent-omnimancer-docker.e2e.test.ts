// Opt-in end-to-end: the real Omnimancer agent image (agents/omnimancer) through
// the worker and DockerService. Needs a Docker daemon and outbound HTTPS to AWS.
//   ROUTINI_E2E_DOCKER=1 npx vitest run tests/agent-omnimancer-docker.e2e.test.ts
// The image is built from agents/ on first run (installs Omnimancer from GitHub).
// No real model key: it proves the launcher, Omnimancer's headless mode, the
// Bedrock call and the error path, not a successful completion.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor } from '../server/src/engine/agent'
import { DockerService } from '../server/src/services/docker'

const enabled = process.env['ROUTINI_E2E_DOCKER'] === '1'
const IMAGE = 'routini/agent-omnimancer:test'

describe.skipIf(!enabled)('Omnimancer agent container (real Docker)', () => {
  let t: TestApp
  let u: TestUser
  let worker: Worker
  const docker = new DockerService()
  const base = () => `/api/orgs/${u.orgSlug}`

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-f', 'omnimancer/Dockerfile', '-t', IMAGE, '.'], { cwd: join(__dirname, '../agents'), stdio: 'pipe' })
    t = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker, images: { omnimancer: IMAGE } }) } } })
    u = await t.signup('omni-e2e@example.com')
    await u.put(`${base()}/settings`, {
      ai: { agents: { omnimancer: { endpoint: 'aws-bedrock', region: 'us-east-1', model: '' } } },
      endpointApiKeys: { 'aws-bedrock': 'ABSKnot-a-real-bedrock-key' },
    })
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 50 })
  }, 600_000)
  afterAll(async () => {
    await t?.close()
  })

  async function run(extra: Record<string, unknown> = {}) {
    const job = await u.post(`${base()}/jobs`, { name: 'omni-e2e', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'omnimancer', prompt: 'Say hello', ...extra } }] })
    const r = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
    await worker.drain(60_000) // ~5 min of 5 ms ticks: real model calls retry with backoff
    const detail = (await u.get(`${base()}/runs/${r.body.run.number}`)).body
    const events = (await u.get(`${base()}/runs/${r.body.run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    return { step: detail.steps[0], events }
  }

  it('reports the launcher refusal when Bedrock has no model', async () => {
    const { step } = await run()
    expect(step.status).toBe('failed')
    expect(step.error).toBe('Agent exited with code 1: Omnimancer on Bedrock needs a model id (Settings → Models, or the step\'s model)')
  }, 120_000)

  it('runs Omnimancer headless against Bedrock and surfaces the API error', async () => {
    const { step, events } = await run({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' })
    expect(events.find((e) => e.type === 'agent.init')?.data).toMatchObject({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' })
    expect(step.status).toBe('failed')
    expect(step.error).toMatch(/^Agent exited with code 1: .*AWS Bedrock API error/)
    expect(JSON.stringify(events)).not.toContain('ABSKnot-a-real-bedrock-key')
  }, 300_000)
})
