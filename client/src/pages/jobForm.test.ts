import { describe, expect, it } from 'vitest'
import type { Host, Job } from '../lib/types'
import { ALERT_HOST, emptyJob, emptyStep, fromJob, runOnBlocked, runOnOptions, toPayload } from './jobForm'

const job: Job = {
  id: 'j1',
  name: '5xx triage',
  description: 'Investigate and fix',
  enabled: true,
  trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' },
  nextRunAt: null,
  createdAt: '',
  updatedAt: '',
  steps: [
    { id: 'probe', name: 'Probe', kind: 'action', when: 'on_success', retries: 2, timeoutSec: 30, config: { type: 'http', url: 'https://api.example.com/health', method: 'GET', expectStatus: 200, headers: { 'X-Probe': '1' } } },
    { id: 'disk', name: 'Disk', kind: 'action', when: 'always', retries: 0, config: { type: 'ssh', hostId: 'h1', command: 'df -h / | tail -1' } },
    { id: 'gate', name: 'Gate', kind: 'approval', when: 'on_success', retries: 0, config: { message: 'Clear logs?', minRole: 'admin' } },
    { id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'Cap journald', repo: { url: 'https://github.com/acme/infra', baseBranch: 'main' }, output: 'pr', check: { command: 'make lint' } } },
  ],
}

describe('job form', () => {
  it('round-trips a job through the form without changing it', () => {
    const r = toPayload(fromJob(job))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload).toEqual({ name: job.name, description: job.description, enabled: true, trigger: job.trigger, steps: job.steps.map((s) => (s.retries ? s : { ...s, retries: undefined })).map(stripUndefined) })
  })

  it('reports every missing field with the step it belongs to', () => {
    const form = emptyJob()
    form.steps = [emptyStep('action', 0), { ...emptyStep('action', 1), actionType: 'ssh' }, emptyStep('agent', 2), emptyStep('approval', 3)]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'Give the job a name.',
      'Step 1 (Action): enter a URL.',
      'Step 2 (Action): choose a host.',
      'Step 2 (Action): enter a command.',
      'Step 3 (Agent): tell the agent what to do.',
      'Step 4 (Approval): say what is being approved.',
    ])
  })

  it('rejects bad cron, headers and timeouts', () => {
    const form = { ...emptyJob(), name: 'x', triggerKind: 'cron' as const, cronExpr: '* *' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test', headersJson: '{oops', timeoutSec: 'abc' }]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'The schedule needs 5 cron fields: minute hour day month weekday.',
      'Step 1 (Action): timeout must be a whole number of seconds.',
      'Step 1 (Action): headers must be a JSON object.',
    ])
  })

  it('omits repo output when no repository is set', () => {
    const form = { ...emptyJob(), name: 'look' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Summarise the logs', output: 'pr' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'step-1', name: 'Agent', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'Summarise the logs' } }])
  })
})

function stripUndefined<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T
}

// ── Agent steps: where they run ──────────────────────────────────────────────

const HOST_ID = '11111111-2222-4333-8444-555555555555'

const host = (over: Partial<Host> = {}): Host => ({
  id: HOST_ID,
  name: 'web-01',
  group: 'prod',
  address: '10.0.0.11',
  port: 22,
  username: null,
  auth: 'key',
  credentialKey: null,
  tags: [],
  lastCheck: null,
  transport: 'runner',
  runner: { id: 'r1', name: 'web-01', version: '0.1.0', hostname: 'web-01', online: true, connectedAt: null, lastSeenAt: null, capabilities: ['exec', 'agents'], facts: null, revoked: false },
  ...over,
})

describe('job form: agent "Run on"', () => {
  const base: Job = { ...job, trigger: { kind: 'manual' }, steps: [] }
  const agentStep = (config: Job['steps'][number]['config']): Job['steps'] => [{ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config } as Job['steps'][number]]

  it('round-trips a step pinned to a fleet host', () => {
    const steps = agentStep({ agent: 'claude', prompt: 'Restart nginx', runOn: { hostId: HOST_ID } })
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]!.runOnHostId).toBe(HOST_ID)
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'Restart nginx', runOn: { hostId: HOST_ID } } }])
  })

  it("round-trips the alert's host, and only on alert-triggered jobs", () => {
    const steps = agentStep({ agent: 'claude', prompt: 'Look at the disk', runOn: { host: 'alert' } })
    const alertJob: Job = { ...base, trigger: { kind: 'alert', match: {} }, steps }
    const form = fromJob(alertJob)
    expect(form.steps[0]!.runOnHostId).toBe(ALERT_HOST)
    const r = toPayload(form)
    expect(r.ok && r.payload).toMatchObject({ steps: [{ config: { runOn: { host: 'alert' } } }] })

    const manual = toPayload({ ...form, triggerKind: 'manual' })
    expect(!manual.ok && manual.errors).toEqual(["Step 1 (Fix): only alert-triggered jobs can run on the alert's host."])
  })

  it('defaults to the sandbox: no runOn in the payload', () => {
    const form = fromJob({ ...base, steps: agentStep({ agent: 'claude', prompt: 'Think' }) })
    expect(form.steps[0]!.runOnHostId).toBe('')
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'Think' } }])
  })

  it('refuses a fleet host and an environment together', () => {
    const form = { ...emptyJob(), name: 'both' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Do it', environmentId: '9a1f0c2e-0000-4000-8000-000000000001', runOnHostId: HOST_ID }]
    const r = toPayload(form)
    expect(!r.ok && r.errors).toEqual(['Step 1 (Agent): run on a fleet host or in an environment, not both.'])
  })
})

describe('job form: runOnOptions', () => {
  const opts = (over: Partial<Parameters<typeof runOnOptions>[0]> = {}) => runOnOptions({ hosts: [], alertTrigger: false, selected: '', ...over })

  it('offers the sandbox first and lists only runner hosts', () => {
    const ssh = host({ id: 'h-ssh', name: 'lab-01', transport: 'ssh', runner: null })
    expect(opts({ hosts: [host(), ssh] })).toEqual([
      { value: '', label: 'Routini sandbox' },
      { value: ALERT_HOST, label: "The alert's host (alert-triggered jobs only)", disabled: true },
      { value: HOST_ID, label: 'web-01', disabled: false },
    ])
  })

  it("enables the alert's host only on alert-triggered jobs", () => {
    expect(opts({ alertTrigger: true })[1]).toEqual({ value: ALERT_HOST, label: "The alert's host", disabled: false })
  })

  it('lists hosts that cannot take agents, disabled, with the reason', () => {
    const offline = host({ id: 'h-off', name: 'web-02', runner: { ...host().runner!, online: false } })
    // Revoked runners read as "offline" too: either way no work reaches them.
    const revoked = host({ id: 'h-rev', name: 'web-03', runner: { ...host().runner!, revoked: true } })
    const noAgents = host({ id: 'h-exec', name: 'web-04', runner: { ...host().runner!, capabilities: ['exec'] } })
    const gone = host({ id: 'h-null', name: 'web-05', runner: null })
    expect(opts({ hosts: [offline, revoked, noAgents, gone] }).slice(2)).toEqual([
      { value: 'h-off', label: 'web-02 (offline)', disabled: true },
      { value: 'h-rev', label: 'web-03 (offline)', disabled: true },
      { value: 'h-exec', label: 'web-04 (agents not enabled)', disabled: true },
      { value: 'h-null', label: 'web-05 (offline)', disabled: true },
    ])
  })

  it('keeps a saved host that has left the fleet visible and named by its id', () => {
    const list = opts({ selected: HOST_ID })
    expect(list.at(-1)).toEqual({ value: HOST_ID, label: `Host ${HOST_ID} (no longer in the fleet)`, disabled: true })
    // Still one entry per host once it is back.
    expect(opts({ hosts: [host()], selected: HOST_ID }).filter((o) => o.value === HOST_ID)).toHaveLength(1)
  })

  it('never adds a ghost entry for the sandbox or the alert host', () => {
    expect(opts({ selected: '' })).toHaveLength(2)
    expect(opts({ selected: ALERT_HOST, alertTrigger: true })).toHaveLength(2)
  })

  it('names why a host is blocked', () => {
    expect(runOnBlocked(host())).toBeNull()
    expect(runOnBlocked(host({ runner: null }))).toBe('offline')
    expect(runOnBlocked(host({ runner: { ...host().runner!, capabilities: [] } }))).toBe('agents not enabled')
  })
})

describe('job form: Factory steps', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips orchestrate and PRD steps', () => {
    const steps: Job['steps'] = [
      { id: 'build', name: 'Build', kind: 'action', when: 'on_success', retries: 0, config: { type: 'factory', operation: 'orchestrate', projectId: 'routini', request: 'Add SSO', runtime: 'omnimancer', provider: 'openrouter', model: 'anthropic/claude-opus-5', createPr: false } },
      { id: 'prd', name: 'PRD', kind: 'action', when: 'on_success', retries: 0, config: { type: 'factory', operation: 'prd', prdId: 'prd_42' } },
    ]
    const r = toPayload(fromJob({ ...base, steps }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual(steps.map(({ retries: _r, ...s }) => s))
  })

  it('drops provider and model when blank and validates ids', () => {
    const form = fromJob({ ...base, steps: [] })
    form.steps = [
      { ...emptyStep('action', 0), actionType: 'factory', factoryProjectId: 'routini', factoryRequest: 'x' },
      { ...emptyStep('action', 1), actionType: 'factory', factoryProjectId: 'bad id', factoryRequest: '' },
      { ...emptyStep('action', 2), actionType: 'factory', factoryOperation: 'prd' },
    ]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Step 2 (Action): enter the Factory project id.', 'Step 2 (Action): describe what Factory should build.', 'Step 3 (Action): enter the Factory PRD id.'])
    form.steps = form.steps.slice(0, 1)
    const ok = toPayload(form)
    expect(ok.ok && ok.payload['steps']).toEqual([{ id: 'step-1', name: 'Action', kind: 'action', when: 'on_success', config: { type: 'factory', operation: 'orchestrate', projectId: 'routini', request: 'x', runtime: 'claude-code', createPr: true } }])
  })
})
