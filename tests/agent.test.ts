// Agent runner: stream parsing, container env, outcomes, PRs, limits, redaction.
// Docker is faked here; tests/agent-docker.e2e.test.ts runs the real image (opt-in).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor, brokeredModelAccess, type AgentDocker } from '../server/src/engine/agent'
import { PLACEHOLDER } from '../server/src/egress/types'
import { AgentStreamParser } from '../server/src/engine/agentStream'
import { createDemuxer, lineSplitter } from '../server/src/services/docker'
import type { FetchFn } from '../server/src/integrations/providers'

const TRANSCRIPT = readFileSync(join(__dirname, '../agents/fake/transcript.jsonl'), 'utf8').trim().split('\n')

// ── Parser ───────────────────────────────────────────────────────────────────

describe('AgentStreamParser', () => {
  it('turns a Claude Code transcript into timeline events and facts', () => {
    const p = new AgentStreamParser()
    const events = TRANSCRIPT.flatMap((l) => p.line(l))
    expect(events.map((e) => e.type)).toEqual(['agent.init', 'agent.message', 'agent.tool_call', 'agent.tool_result', 'agent.message', 'agent.result', 'cost'])
    expect(events[2]!.data).toMatchObject({ name: 'Bash', input: '{"command":"df -h /"}' })
    expect(events[3]!.data).toMatchObject({ name: 'Bash', ok: true })
    expect(String(events[3]!.data['output'])).toContain('91%')
    expect(p.facts).toMatchObject({ model: 'claude-sonnet-5', costUsd: 0.0421, turns: 3, resultIsError: false })
  })

  it('reads control lines and keeps a tail of plain output', () => {
    const p = new AgentStreamParser()
    p.line('::routini::{"type":"check","exitCode":2}')
    p.line('::routini::{"type":"commit","sha":"abc1234def","files":3}')
    p.line('::routini::{"type":"pushed","branch":"routini/run-7"}')
    p.line('::routini::{"type":"error","message":"git push failed"}')
    expect(p.line('npm ERR! something')).toEqual([{ type: 'log', data: { message: 'npm ERR! something' } }])
    expect(p.line('{not json')).toEqual([{ type: 'log', data: { message: '{not json' } }])
    expect(p.facts).toMatchObject({
      check: { exitCode: 2 },
      commit: { sha: 'abc1234def', files: 3 },
      pushed: { branch: 'routini/run-7' },
      errors: ['git push failed'],
      tail: ['npm ERR! something', '{not json'],
    })
  })

  it('clips very large tool output', () => {
    const p = new AgentStreamParser()
    const big = 'x'.repeat(10_000)
    const [ev] = p.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } }))
    expect(String(ev!.data['output']).length).toBeLessThan(2100)
  })
})

describe('brokeredModelAccess', () => {
  it('gives Claude on Bedrock a placeholder token and binds both Bedrock hosts', () => {
    const access = brokeredModelAccess('claude', { endpoint: 'aws-bedrock', model: '', region: 'us-west-2' }, 'ABSKreal')
    expect(access.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_BEARER_TOKEN_BEDROCK: PLACEHOLDER, ANTHROPIC_API_KEY: '' })
    expect(access.hosts).toEqual(['bedrock-runtime.us-west-2.amazonaws.com', 'bedrock.us-west-2.amazonaws.com'])
    expect(access.bindings).toEqual(access.hosts.map((host) => ({ host, header: 'authorization', format: 'bearer', secret: 'ABSKreal' })))
    expect(access.secrets).toEqual(['ABSKreal'])
  })

  it('gives other agents on Bedrock the ROUTINI_ENDPOINT contract with a region, and the same bindings', () => {
    const access = brokeredModelAccess('omnimancer', { endpoint: 'aws-bedrock', model: '', region: 'eu-central-1' }, 'ABSKreal')
    expect(access.env).toEqual({ ROUTINI_ENDPOINT: 'aws-bedrock', ROUTINI_ENDPOINT_KEY: PLACEHOLDER, ROUTINI_ENDPOINT_REGION: 'eu-central-1' })
    expect(access.hosts).toEqual(['bedrock-runtime.eu-central-1.amazonaws.com', 'bedrock.eu-central-1.amazonaws.com'])
    expect(access.bindings.every((b) => b.header === 'authorization' && b.format === 'bearer' && b.secret === 'ABSKreal')).toBe(true)
  })

  it('refuses Bedrock without a key or a region', () => {
    for (const agent of ['claude', 'omnimancer'] as const) {
      expect(() => brokeredModelAccess(agent, { endpoint: 'aws-bedrock', model: '', region: 'us-east-1' }, null)).toThrow(/No AWS Bedrock API key/)
      expect(() => brokeredModelAccess(agent, { endpoint: 'aws-bedrock', model: '' }, 'ABSKreal')).toThrow(/needs a region/)
    }
  })
})

describe('docker stream plumbing', () => {
  const frame = (kind: 1 | 2, s: string) => {
    const payload = Buffer.from(s)
    const h = Buffer.alloc(8)
    h[0] = kind
    h.writeUInt32BE(payload.length, 4)
    return Buffer.concat([h, payload])
  }

  it('demultiplexes frames split across chunks', () => {
    const got: string[] = []
    const demux = createDemuxer((k, b) => got.push(`${k}:${b.toString()}`))
    const all = Buffer.concat([frame(1, 'hello '), frame(2, 'oops\n'), frame(1, 'world\n')])
    for (let i = 0; i < all.length; i += 3) demux(all.subarray(i, i + 3))
    expect(got).toEqual(['stdout:hello ', 'stderr:oops\n', 'stdout:world\n'])
  })

  it('splits lines across chunk boundaries and flushes the remainder', () => {
    const lines: string[] = []
    const s = lineSplitter((l) => lines.push(l))
    s.push(Buffer.from('one\ntw'))
    s.push(Buffer.from('o\r\nthr'))
    s.flush()
    s.push(Buffer.from('ee'))
    s.flush()
    expect(lines).toEqual(['one', 'two', 'thr', 'ee'])
  })
})

// ── Executor through the engine ──────────────────────────────────────────────

interface FakeRun {
  lines?: string[]
  exitCode?: number
  hang?: boolean
}

function fakeDocker(script: () => FakeRun) {
  const spawned: Array<{ image: string; env: Record<string, string>; user?: string; labels?: Record<string, string>; memoryBytes?: number }> = []
  const killed: Array<Record<string, string>> = []
  const docker: AgentDocker = {
    async runStreaming(config, opts) {
      spawned.push(config)
      const s = script()
      for (const l of s.lines ?? []) opts.onLine(l, 'stdout')
      if (s.hang) {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { containerId: 'c1', exitCode: null, logs: [], timedOut: false, aborted: true }
      }
      return { containerId: 'c1', exitCode: s.exitCode ?? 0, logs: [], timedOut: false, aborted: false }
    },
    async killByLabels(labels) {
      killed.push(labels)
      return 1
    },
  }
  return { docker, spawned, killed }
}

const PUSHED = ['::routini::{"type":"commit","sha":"0123456789abcdef","files":2}', '::routini::{"type":"pushed","branch":"routini/run-1"}']

describe('agent steps', () => {
  let t: TestApp
  let u: TestUser
  let worker: Worker
  let script: () => FakeRun
  let fake: ReturnType<typeof fakeDocker>
  const prCalls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = []
  let prStatus = 201
  const githubFetch: FetchFn = async (url, init) => {
    prCalls.push({ url, body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>)['Authorization']) })
    return new Response(JSON.stringify(prStatus === 201 ? { html_url: 'https://github.com/acme/app/pull/42', number: 42 } : { message: 'Validation Failed' }), { status: prStatus })
  }
  const base = () => `/api/orgs/${u.orgSlug}`

  beforeEach(async () => {
    prCalls.length = 0
    prStatus = 201
    script = () => ({ lines: TRANSCRIPT })
    fake = fakeDocker(() => script())
    t = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker: fake.docker, fetchImpl: githubFetch, images: { claude: 'routini/agent-claude:test' } }) } } })
    u = await t.signup('agent@example.com')
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 })
    await u.put(`${base()}/settings`, { endpointApiKeys: { anthropic: 'sk-ant-api03-REALKEY-0123456789' } })
  })
  afterEach(() => t.close())

  async function run(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const job = await u.post(`${base()}/jobs`, { name: 'Agent job', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'Fix the disk alert', ...config }, ...extra }] })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    const r = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
    await worker.drain()
    const detail = (await u.get(`${base()}/runs/${r.body.run.number}`)).body
    const events = (await u.get(`${base()}/runs/${r.body.run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>
    return { detail, events, step: detail.steps[0] }
  }

  it('runs the agent as uid 1000 with the prompt, model key and labels, and records cost', async () => {
    const { detail, events, step } = await run({})
    expect(detail.run.status).toBe('succeeded')
    const spawned = fake.spawned[0]!
    expect(spawned.image).toBe('routini/agent-claude:test')
    expect(spawned.user).toBe('1000:1000')
    expect(spawned.memoryBytes).toBe(4096 * 1024 * 1024)
    expect(spawned.env).toMatchObject({ ROUTINI_PROMPT: 'Fix the disk alert', ROUTINI_OUTPUT: 'none', ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEY-0123456789' })
    expect(spawned.env['ROUTINI_SYSTEM_PROMPT']).toMatch(/unattended/)
    expect(spawned.env).not.toHaveProperty('REPO_URL')
    expect(spawned.labels).toMatchObject({ 'routini.managed': 'true', 'routini.run': detail.run.id, 'routini.step': '0' })
    expect(step.output).toMatchObject({ costUsd: 0.0421, model: 'claude-sonnet-5', changes: false })
    expect(detail.run.costUsd).toBeCloseTo(0.0421)
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent.init', 'agent.tool_call', 'agent.tool_result', 'agent.result', 'cost']))
    expect(events.filter((e) => e.type === 'step.placement').map((e) => e.data)).toEqual([{ target: 'sandbox', host: expect.any(String) }])
  })

  it('opens a pull request from the worker after the container pushes', async () => {
    await u.put(`${base()}/integrations/github`, { credentials: { token: 'ghp_integrationtoken0123456789abcdef' } })
    script = () => ({ lines: [...TRANSCRIPT, ...PUSHED] })
    const { detail, events, step } = await run({ repo: { url: 'https://github.com/acme/app', baseBranch: 'main' }, check: { command: 'npm test' } })
    expect(detail.run.status).toBe('succeeded')
    const env = fake.spawned[0]!.env
    expect(env).toMatchObject({ REPO_URL: 'https://github.com/acme/app', BASE_BRANCH: 'main', WORK_BRANCH: 'routini/run-1', CHECK_COMMAND: 'npm test', ROUTINI_OUTPUT: 'pr', GITHUB_TOKEN: 'ghp_integrationtoken0123456789abcdef' })
    expect(prCalls).toHaveLength(1)
    expect(prCalls[0]!.url).toBe('https://api.github.com/repos/acme/app/pulls')
    expect(prCalls[0]!.auth).toBe('Bearer ghp_integrationtoken0123456789abcdef')
    expect(prCalls[0]!.body).toMatchObject({ head: 'routini/run-1', base: 'main', title: 'Agent job (Routini run #1)' })
    expect(String(prCalls[0]!.body['body'])).toContain('journald has no SystemMaxUse cap')
    expect(step.output.pullRequest).toEqual({ url: 'https://github.com/acme/app/pull/42', number: 42 })
    expect(events.find((e) => e.type === 'artifact')!.data).toEqual({ kind: 'pull_request', url: 'https://github.com/acme/app/pull/42', number: 42, branch: 'routini/run-1' })
  })

  it('fails honestly when the pushed branch cannot become a PR', async () => {
    script = () => ({ lines: PUSHED })
    const noToken = await run({ repo: { url: 'https://github.com/acme/app', baseBranch: 'main' } })
    expect(noToken.step.status).toBe('failed')
    expect(noToken.step.error).toMatch(/GitHub integration is not connected/)
    expect(noToken.step.output.branch).toBe('routini/run-1')

    await u.put(`${base()}/integrations/github`, { credentials: { token: 'ghp_x0123456789abcdefghij' } })
    prStatus = 422
    const refused = await run({ repo: { url: 'https://github.com/acme/app', baseBranch: 'main' } })
    expect(refused.step.error).toMatch(/GitHub refused the pull request \(HTTP 422: Validation Failed\)/)
  })

  it('reports a failed check, a crashed agent, and an agent error result', async () => {
    script = () => ({ lines: [...TRANSCRIPT, '[check] 1 failing test', '::routini::{"type":"check","exitCode":1}'], exitCode: 3 })
    expect((await run({ check: { command: 'npm test' } })).step.error).toBe('Check command failed (exit 1)')

    script = () => ({ lines: ['segfault-ish noise', '::routini::{"type":"error","message":"agent exited with code 2"}'], exitCode: 2 })
    expect((await run({})).step.error).toBe('Agent exited with code 2: agent exited with code 2')

    script = () => ({ lines: ['{"type":"result","subtype":"error_max_turns","is_error":true,"result":"ran out of turns","total_cost_usd":0.5}'] })
    expect((await run({})).step.error).toBe('The agent reported an error: ran out of turns')
  })

  it('treats "no changes" as success without a PR', async () => {
    script = () => ({ lines: [...TRANSCRIPT, '::routini::{"type":"no_changes"}'] })
    const { step } = await run({ repo: { url: 'https://github.com/acme/app', baseBranch: 'main' } })
    expect(step.status).toBe('succeeded')
    expect(step.output.changes).toBe(false)
    expect(prCalls).toHaveLength(0)
  })

  it('wires OpenRouter through the Anthropic-compatible endpoint', async () => {
    await u.put(`${base()}/settings`, { ai: { agents: { claude: { endpoint: 'openrouter', model: 'anthropic/claude-opus-5' } } }, endpointApiKeys: { openrouter: 'sk-or-v1-abcdefgh12345678' } })
    await run({})
    expect(fake.spawned[0]!.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-abcdefgh12345678',
      ANTHROPIC_API_KEY: '',
      ROUTINI_MODEL: 'anthropic/claude-opus-5',
    })
  })

  it('wires AWS Bedrock natively with a Bedrock API key and region', async () => {
    await u.put(`${base()}/settings`, { ai: { agents: { claude: { endpoint: 'aws-bedrock', region: 'eu-west-1', model: 'eu.anthropic.claude-test' } } }, endpointApiKeys: { 'aws-bedrock': 'ABSKbedrockkey0123456789' } })
    await run({})
    expect(fake.spawned[0]!.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'eu-west-1',
      AWS_BEARER_TOKEN_BEDROCK: 'ABSKbedrockkey0123456789',
      ANTHROPIC_API_KEY: '',
      ROUTINI_MODEL: 'eu.anthropic.claude-test',
    })
  })

  it('passes Omnimancer its Bedrock endpoint, key and region', async () => {
    const t2 = await makeTestApp({ engine: { executors: { agent: agentExecutor({ docker: fake.docker, images: { omnimancer: 'routini/agent-omnimancer:test' } }) } } })
    try {
      const u2 = await t2.signup('omni@example.com')
      const base2 = `/api/orgs/${u2.orgSlug}`
      await u2.put(`${base2}/settings`, { ai: { agents: { omnimancer: { endpoint: 'aws-bedrock', region: 'us-west-2', model: 'us.anthropic.claude-test' } } }, endpointApiKeys: { 'aws-bedrock': 'ABSKomnikey0123456789' } })
      const job = await u2.post(`${base2}/jobs`, { name: 'Omni', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'omnimancer', prompt: 'Fix it' } }] })
      await u2.post(`${base2}/jobs/${job.body.job.id}/run`)
      await new Worker(t2.ctx, t2.ctx.engine, { heartbeatMs: 20 }).drain()
      expect(fake.spawned[0]!.env).toMatchObject({
        ROUTINI_ENDPOINT: 'aws-bedrock',
        ROUTINI_ENDPOINT_KEY: 'ABSKomnikey0123456789',
        ROUTINI_ENDPOINT_REGION: 'us-west-2',
        ROUTINI_MODEL: 'us.anthropic.claude-test',
      })
      expect(fake.spawned[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    } finally {
      await t2.close()
    }
  })

  it('refuses to start without a model key or an image', async () => {
    await t.ctx.db.org(u.orgId, (q) => q.query(`DELETE FROM credentials WHERE key = 'ai.key.anthropic'`))
    expect((await run({})).step.error).toMatch(/No Anthropic API key is stored/)
    expect((await run({ agent: 'omnimancer' })).step.error).toMatch(/No runner image is configured for the omnimancer agent/)
    expect(fake.spawned).toHaveLength(0)
  })

  it('enforces agent minutes and the daily budget before spawning', async () => {
    await u.put(base(), { limits: { agentMinutesPerDay: 1, dailyBudgetUsd: 0.04 } })
    expect((await run({})).detail.run.status).toBe('succeeded') // spends $0.0421, over the $0.04 budget
    const blocked = await run({})
    expect(blocked.step.error).toMatch(/limit_exceeded:daily_budget/)
    expect(fake.spawned).toHaveLength(1)
  })

  it('redacts secrets the agent prints', async () => {
    script = () => ({ lines: ['echoing my key: sk-ant-api03-REALKEY-0123456789', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the key is sk-ant-api03-REALKEY-0123456789' }] } })] })
    const { events } = await run({})
    const dump = JSON.stringify(events)
    expect(dump).not.toContain('REALKEY')
    expect(dump).toContain('[REDACTED]')
  })

  it('stops the container on cancel', async () => {
    script = () => ({ lines: ['working…'], hang: true })
    const job = await u.post(`${base()}/jobs`, { name: 'Long', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'SLOW' } }] })
    const r = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
    await worker.tick()
    for (let i = 0; i < 200 && fake.spawned.length === 0; i++) await new Promise((res) => setTimeout(res, 10))
    await u.post(`${base()}/runs/${r.body.run.number}/cancel`)
    await worker.drain()
    expect((await u.get(`${base()}/runs/${r.body.run.number}`)).body.run.status).toBe('canceled')
  })
})
