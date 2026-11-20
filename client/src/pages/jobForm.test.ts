import { describe, expect, it } from 'vitest'
import type { Host, Job, StepCondition } from '../lib/types'
import { ALERT_HOST, POOL_HOST, emptyJob, emptyStep, fromJob, planBuildShipTemplate, poolMatch, runOnBlocked, runOnOptions, toPayload, type StepForm } from './jobForm'

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

  it('round-trips a step pinned to a pool (group and tags)', () => {
    const steps = agentStep({ agent: 'claude', prompt: 'Fix the flaky test', runOn: { pool: { group: 'prod', tags: ['gpu', 'linux'] } } })
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ runOnHostId: POOL_HOST, runOnPoolGroup: 'prod', runOnPoolTags: 'gpu linux' })
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([
      { id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'Fix the flaky test', runOn: { pool: { group: 'prod', tags: ['gpu', 'linux'] } } } },
    ])
  })

  it('round-trips a pool with only a group, and one with only tags', () => {
    const groupOnly = fromJob({ ...base, steps: agentStep({ agent: 'claude', prompt: 'x', runOn: { pool: { group: 'prod' } } }) })
    expect(toPayload(groupOnly).ok && (toPayload(groupOnly) as { payload: Record<string, unknown> }).payload['steps']).toEqual([
      { id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'x', runOn: { pool: { group: 'prod' } } } },
    ])
    const tagsOnly = fromJob({ ...base, steps: agentStep({ agent: 'claude', prompt: 'x', runOn: { pool: { tags: ['gpu'] } } }) })
    expect(toPayload(tagsOnly).ok && (toPayload(tagsOnly) as { payload: Record<string, unknown> }).payload['steps']).toEqual([
      { id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'x', runOn: { pool: { tags: ['gpu'] } } } },
    ])
  })

  it('splits pool tags on spaces or commas, deduplicated', () => {
    const form = { ...emptyJob(), name: 'pool' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Do it', runOnHostId: POOL_HOST, runOnPoolTags: 'gpu, linux  gpu,prod' }]
    const r = toPayload(form)
    expect(r.ok && (r.payload['steps'] as Array<{ config: { runOn: unknown } }>)[0]!.config.runOn).toEqual({ pool: { tags: ['gpu', 'linux', 'prod'] } })
  })

  it('a pool needs a group or at least one tag', () => {
    const form = { ...emptyJob(), name: 'empty pool' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Do it', runOnHostId: POOL_HOST }]
    const r = toPayload(form)
    expect(!r.ok && r.errors).toEqual(['Step 1 (Agent): a host pool needs a group or at least one tag.'])
  })

  it('a pool and an environment are mutually exclusive, either way round', () => {
    const poolForm = { ...emptyJob(), name: 'pool+env' }
    poolForm.steps = [{ ...emptyStep('agent', 0), prompt: 'Do it', environmentId: '9a1f0c2e-0000-4000-8000-000000000001', runOnHostId: POOL_HOST, runOnPoolGroup: 'prod' }]
    const r = toPayload(poolForm)
    expect(!r.ok && r.errors).toEqual(['Step 1 (Agent): run on a fleet host or in an environment, not both.'])

    // Picking an environment in the editor clears a pool selection, and vice versa (JobEditorPage's onChange); fromJob never produces both at once.
    const envForm = { ...emptyStep('agent', 0), environmentId: '9a1f0c2e-0000-4000-8000-000000000001', runOnHostId: POOL_HOST }
    expect({ ...envForm, environmentId: '' }).toMatchObject({ runOnHostId: POOL_HOST })
    expect({ ...envForm, runOnHostId: '' }).toMatchObject({ environmentId: '9a1f0c2e-0000-4000-8000-000000000001' })
  })
})

describe('job form: poolMatch', () => {
  const runner = (over: Partial<Host> = {}): Host => ({ ...host(), transport: 'runner', ...over })

  it('counts runner hosts matching a group and/or tags, and how many can run agents now', () => {
    const prodGpu = runner({ id: 'h1', name: 'h1', group: 'prod', tags: ['gpu'] })
    const prodCpu = runner({ id: 'h2', name: 'h2', group: 'prod', tags: ['cpu'] })
    const labGpu = runner({ id: 'h3', name: 'h3', group: 'lab', tags: ['gpu'], runner: { ...host().runner!, online: false } })
    const ssh = host({ id: 'h4', name: 'h4', transport: 'ssh', runner: null, group: 'prod', tags: ['gpu'] })
    const hosts = [prodGpu, prodCpu, labGpu, ssh]

    expect(poolMatch(hosts, 'prod', ['gpu'])).toEqual({ matches: 1, canRunNow: 1 })
    expect(poolMatch(hosts, 'prod', [])).toEqual({ matches: 2, canRunNow: 2 })
    expect(poolMatch(hosts, '', ['gpu'])).toEqual({ matches: 2, canRunNow: 1 })
    expect(poolMatch(hosts, '', [])).toEqual({ matches: 3, canRunNow: 2 })
  })
})

describe('job form: runOnOptions', () => {
  const opts = (over: Partial<Parameters<typeof runOnOptions>[0]> = {}) => runOnOptions({ hosts: [], alertTrigger: false, selected: '', ...over })

  it('offers the sandbox first and lists only runner hosts', () => {
    const ssh = host({ id: 'h-ssh', name: 'lab-01', transport: 'ssh', runner: null })
    expect(opts({ hosts: [host(), ssh] })).toEqual([
      { value: '', label: 'Routini sandbox' },
      { value: ALERT_HOST, label: "The alert's host (alert-triggered jobs only)", disabled: true },
      { value: POOL_HOST, label: 'A host from a pool...' },
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
    expect(opts({ hosts: [offline, revoked, noAgents, gone] }).slice(3)).toEqual([
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

  it('never adds a ghost entry for the sandbox, the alert host or the pool option', () => {
    expect(opts({ selected: '' })).toHaveLength(3)
    expect(opts({ selected: ALERT_HOST, alertTrigger: true })).toHaveLength(3)
    expect(opts({ selected: POOL_HOST })).toHaveLength(3)
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

  it('round-trips a single-task step with a repository and max retries', () => {
    const steps: Job['steps'] = [
      { id: 'task', name: 'Task', kind: 'action', when: 'on_success', retries: 0, config: { type: 'factory', operation: 'task', projectId: 'routini', request: 'Fix the flaky test', repoUrl: 'https://github.com/acme/app', maxRetries: 3, runtime: 'claude-code' } },
    ]
    const r = toPayload(fromJob({ ...base, steps }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual(steps.map(({ retries: _r, ...s }) => s))
  })

  it('round-trips a from-step step naming an earlier step, with a repository', () => {
    const steps: Job['steps'] = [
      { id: 'plan', name: 'Plan', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'Plan', returns: [{ name: 'builder', type: 'text' }] } },
      {
        id: 'from',
        name: 'From step',
        kind: 'action',
        when: 'on_success',
        retries: 0,
        config: { type: 'factory', operation: 'from-step', operationFrom: 'steps.plan.out.builder', projectId: 'routini', request: '{{steps.plan.out.builder}}', repoUrl: 'https://github.com/acme/app', runtime: 'claude-code' },
      },
    ]
    const r = toPayload(fromJob({ ...base, steps }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual(steps.map(({ retries: _r, ...s }) => s))
  })

  it('drops createPr, maxRetries and repoUrl when not set, for task and from-step', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [
      { ...emptyStep('action', 0), actionType: 'factory', factoryOperation: 'task', factoryProjectId: 'routini', factoryRequest: 'Fix it' },
      { ...emptyStep('action', 1), actionType: 'factory', factoryOperation: 'from-step', factoryOperationFrom: 'steps.step-1.out.builder', factoryProjectId: 'routini', factoryRequest: 'Fix it' },
    ]
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([
      { id: 'step-1', name: 'Action', kind: 'action', when: 'on_success', config: { type: 'factory', operation: 'task', projectId: 'routini', request: 'Fix it', runtime: 'claude-code' } },
      {
        id: 'step-2',
        name: 'Action',
        kind: 'action',
        when: 'on_success',
        config: { type: 'factory', operation: 'from-step', operationFrom: 'steps.step-1.out.builder', projectId: 'routini', request: 'Fix it', runtime: 'claude-code' },
      },
    ])
  })

  it('rejects max retries outside 0 to 5', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'factory', factoryOperation: 'task', factoryProjectId: 'routini', factoryRequest: 'x', factoryMaxRetries: '6' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): max retries must be a whole number from 0 to 5.'])

    form.steps[0]!.factoryMaxRetries = '-1'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): max retries must be a whole number from 0 to 5.'])
  })

  it('validates a from-step path: shape, root and "earlier step"', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'factory', factoryOperation: 'from-step', factoryProjectId: 'routini', factoryRequest: 'x', factoryOperationFrom: 'bad path!' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): the step path must use only letters, numbers and "_.-" (max 200 characters).'])

    form.steps[0]!.factoryOperationFrom = 'trigger.kind'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): the step path must start with steps.'])

    form.steps[0]!.factoryOperationFrom = 'steps.later.out.builder'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): the step path must name a step that runs before this one.'])
  })
})

describe('job form: agent startFrom (pull back from Factory)', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips startFrom naming an earlier Factory step', () => {
    const steps: Job['steps'] = [
      { id: 'factory', name: 'Factory', kind: 'action', when: 'on_success', retries: 0, config: { type: 'factory', operation: 'task', projectId: 'routini', request: 'Fix it', runtime: 'claude-code' } },
      {
        id: 'build',
        name: 'Build',
        kind: 'agent',
        when: 'on_success',
        retries: 0,
        config: { agent: 'claude', prompt: 'Build', repo: { url: 'https://github.com/acme/app', baseBranch: 'main' }, output: 'pr', startFrom: { step: 'factory' } },
      },
    ]
    const form = fromJob({ ...base, steps })
    expect(form.steps[1]!.startFromStep).toBe('factory')
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual(steps.map(({ retries: _r, ...s }) => s))
  })

  it("flags a read-only step that tries to start from Factory's result", () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [
      { ...emptyStep('action', 0), actionType: 'factory', factoryOperation: 'task', factoryProjectId: 'routini', factoryRequest: 'x' },
      { ...emptyStep('agent', 1), prompt: 'Build', repoUrl: 'https://github.com/acme/app', repoReadOnly: true, startFromStep: 'step-1' },
    ]
    const r = toPayload(form)
    expect(!r.ok && r.errors).toEqual(["Step 2 (Agent): A read-only step can't start from Factory's result."])
  })

  it('needs a repository, and not an environment', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [
      { ...emptyStep('action', 0), actionType: 'factory', factoryOperation: 'task', factoryProjectId: 'routini', factoryRequest: 'x' },
      { ...emptyStep('agent', 1), prompt: 'Build', startFromStep: 'step-1' },
    ]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(["Step 2 (Agent): starting from Factory's result needs a repository."])

    form.steps[1] = { ...form.steps[1]!, environmentId: '9a1f0c2e-0000-4000-8000-000000000001' }
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(["Step 2 (Agent): starting from Factory's result needs a repository, not an environment."])
  })

  it('must name an earlier Factory step', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Build', repoUrl: 'https://github.com/acme/app', startFromStep: 'nope' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Agent): "Starts from" must name an earlier Factory step.'])
  })

  it('omits startFrom entirely when blank', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Build', repoUrl: 'https://github.com/acme/app' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([
      { id: 'step-1', name: 'Agent', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'Build', repo: { url: 'https://github.com/acme/app', baseBranch: 'main' }, output: 'pr' } },
    ])
  })
})

describe('job form: Azure Boards steps', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips a step with project, query and limit', () => {
    const steps: Job['steps'] = [
      { id: 'board', name: 'Board sweep', kind: 'action', when: 'on_success', retries: 0, config: { type: 'azure-boards', project: 'Fabrikam', query: 'SELECT [System.Id] FROM WorkItems WHERE [State] <> "Closed"', limit: 25 } },
    ]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ boardsProject: 'Fabrikam', boardsQuery: 'SELECT [System.Id] FROM WorkItems WHERE [State] <> "Closed"', boardsLimit: '25' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([{ id: 'board', name: 'Board sweep', kind: 'action', when: 'on_success', config: { type: 'azure-boards', project: 'Fabrikam', query: 'SELECT [System.Id] FROM WorkItems WHERE [State] <> "Closed"', limit: 25 } }])
  })

  it('round-trips a step with only a project (query and limit optional)', () => {
    const steps: Job['steps'] = [{ id: 'board', name: 'Board', kind: 'action', when: 'on_success', retries: 0, config: { type: 'azure-boards', project: 'Fabrikam' } }]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ boardsProject: 'Fabrikam', boardsQuery: '', boardsLimit: '' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([{ id: 'board', name: 'Board', kind: 'action', when: 'on_success', config: { type: 'azure-boards', project: 'Fabrikam' } }])
  })

  it('drops a whitespace-only query and keeps an unset limit', () => {
    const form = { ...emptyJob(), name: 'sweep' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'azure-boards', boardsProject: 'Fabrikam', boardsQuery: '   ' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'step-1', name: 'Action', kind: 'action', when: 'on_success', config: { type: 'azure-boards', project: 'Fabrikam' } }])
  })

  it('requires a project', () => {
    const form = { ...emptyJob(), name: 'sweep' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'azure-boards' }]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Step 1 (Action): enter the Azure DevOps project.'])
  })

  it('rejects a limit outside 1..200', () => {
    const form = { ...emptyJob(), name: 'sweep' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'azure-boards', boardsProject: 'Fabrikam', boardsLimit: '0' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): limit must be a whole number from 1 to 200.'])
    form.steps[0]!.boardsLimit = '201'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): limit must be a whole number from 1 to 200.'])
    form.steps[0]!.boardsLimit = '12.5'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): limit must be a whole number from 1 to 200.'])
  })
})

describe('job form: Teams steps', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips a step with message and title', () => {
    const steps: Job['steps'] = [{ id: 'notify', name: 'Notify', kind: 'action', when: 'on_success', retries: 0, config: { type: 'teams', message: 'Board sweep finished.', title: 'Routini' } }]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ teamsTitle: 'Routini', teamsMessage: 'Board sweep finished.' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([{ id: 'notify', name: 'Notify', kind: 'action', when: 'on_success', config: { type: 'teams', message: 'Board sweep finished.', title: 'Routini' } }])
  })

  it('round-trips a step without a title (optional)', () => {
    const steps: Job['steps'] = [{ id: 'notify', name: 'Notify', kind: 'action', when: 'on_success', retries: 0, config: { type: 'teams', message: 'Board sweep finished.' } }]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ teamsTitle: '', teamsMessage: 'Board sweep finished.' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([{ id: 'notify', name: 'Notify', kind: 'action', when: 'on_success', config: { type: 'teams', message: 'Board sweep finished.' } }])
  })

  it('requires a message', () => {
    const form = { ...emptyJob(), name: 'notify' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'teams', teamsTitle: 'Hi' }]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Step 1 (Action): enter the message to post.'])
  })

  it('rejects a title longer than 200 characters', () => {
    const form = { ...emptyJob(), name: 'notify' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'teams', teamsMessage: 'Hi', teamsTitle: 'x'.repeat(201) }]
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Step 1 (Action): the title can be at most 200 characters.'])
  })

  it('trims a blank title out of the payload', () => {
    const form = { ...emptyJob(), name: 'notify' }
    form.steps = [{ ...emptyStep('action', 0), actionType: 'teams', teamsMessage: 'Hi', teamsTitle: '   ' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'step-1', name: 'Action', kind: 'action', when: 'on_success', config: { type: 'teams', message: 'Hi' } }])
  })
})

describe('job form: step condition (if)', () => {
  const base = { ...job, trigger: { kind: 'manual' } as const }
  const twoSteps = (ifCond: StepCondition): Job => ({
    ...base,
    steps: [
      { id: 'probe', name: 'Probe', kind: 'action', when: 'on_success', retries: 0, config: { type: 'http', url: 'https://x.test' } },
      { id: 'fix', name: 'Fix', kind: 'action', when: 'on_success', retries: 0, if: ifCond, config: { type: 'http', url: 'https://y.test' } },
    ],
  })

  function roundTrips(ifCond: StepCondition) {
    const form = fromJob(twoSteps(ifCond))
    expect(form.steps[1]).toMatchObject({ ifPath: ifCond.path, ifOp: ifCond.op })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.payload['steps'] as Array<Record<string, unknown>>)[1]!['if']).toEqual(ifCond)
  }

  it('round-trips eq', () => roundTrips({ path: 'steps.probe.out.builder', op: 'eq', value: 'routini' }))
  it('round-trips ne', () => roundTrips({ path: 'steps.probe.out.builder', op: 'ne', value: 'routini' }))
  it('round-trips in', () => roundTrips({ path: 'steps.probe.out.builder', op: 'in', value: ['routini', 'factory-task'] }))
  it('round-trips not_in', () => roundTrips({ path: 'steps.probe.out.builder', op: 'not_in', value: ['routini', 'factory-task'] }))
  it('round-trips exists', () => roundTrips({ path: 'trigger.kind', op: 'exists' }))
  it('round-trips missing', () => roundTrips({ path: 'trigger.kind', op: 'missing' }))

  it('omits `if` entirely when no operator is chosen', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'step-1', name: 'Action', kind: 'action', when: 'on_success', config: { type: 'http', url: 'https://x.test', method: 'GET' } }])
  })

  it("flags a condition on a step that doesn't run before it", () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test', ifPath: 'steps.later.out.x', ifOp: 'eq', ifValue: 'y' }]
    const r = toPayload(form)
    expect(!r.ok && r.errors).toEqual(["Step 1 condition refers to step 'later', which does not run before it"])
  })

  it('rejects a malformed path and a path with the wrong root', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test', ifPath: 'bad path!', ifOp: 'eq', ifValue: 'y' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition path must use only letters, numbers and "_.-" (max 200 characters).'])

    form.steps[0]!.ifPath = 'nope.x'
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition path must start with steps. or trigger.'])
  })

  it('eq/ne need a value, at most 200 characters', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test', ifPath: 'trigger.kind', ifOp: 'eq', ifValue: '' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition needs a value.'])

    form.steps[0]!.ifValue = 'x'.repeat(201)
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition value must be at most 200 characters.'])
  })

  it('in/not_in need 1 to 20 comma-separated values', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('action', 0), url: 'https://x.test', ifPath: 'trigger.kind', ifOp: 'in', ifValue: '' }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition needs 1 to 20 values.'])

    form.steps[0]!.ifValue = Array.from({ length: 21 }, (_, i) => `v${i}`).join(', ')
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Action): condition needs 1 to 20 values.'])
  })
})

describe('job form: agent returns', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips returns with choices, a choice that requires an integration, and defaults', () => {
    const steps: Job['steps'] = [
      {
        id: 'plan',
        name: 'Plan',
        kind: 'agent',
        when: 'on_success',
        retries: 0,
        config: {
          agent: 'claude',
          prompt: 'Plan it',
          returns: [
            { name: 'builder', type: 'choice', choices: [{ value: 'routini' }, { value: 'factory-task', requires: 'factory' }] },
            { name: 'request', type: 'text' },
            { name: 'confidence', type: 'number', required: false, description: 'How sure, 0-100' },
          ],
        },
      },
    ]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({
      returns: [
        { name: 'builder', type: 'choice', choicesText: 'routini, factory-task:factory', required: true },
        { name: 'request', type: 'text', choicesText: '', required: true },
        { name: 'confidence', type: 'number', choicesText: '', required: false, description: 'How sure, 0-100' },
      ],
    })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.payload['steps'] as Array<{ config: { returns: unknown } }>)[0]!.config.returns).toEqual([
      { name: 'builder', type: 'choice', choices: [{ value: 'routini' }, { value: 'factory-task', requires: 'factory' }] },
      { name: 'request', type: 'text' },
      { name: 'confidence', type: 'number', required: false, description: 'How sure, 0-100' },
    ])
  })

  it('requires a lowercase name, unique across fields', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [
      {
        ...emptyStep('agent', 0),
        prompt: 'p',
        returns: [
          { key: 'a', name: 'Bad Name', type: 'text', choicesText: '', required: true, description: '' },
          { key: 'b', name: 'ok', type: 'text', choicesText: '', required: true, description: '' },
          { key: 'c', name: 'ok', type: 'text', choicesText: '', required: true, description: '' },
        ],
      },
    ]
    const r = toPayload(form)
    expect(!r.ok && r.errors).toEqual([
      'Step 1 (Agent): return field 1: name must start with a lowercase letter and contain only letters, numbers and _ (max 40 characters).',
      'Step 1 (Agent): return field 3: name "ok" is already used.',
    ])
  })

  it('needs 1 to 20 valid choices', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'p', returns: [{ key: 'a', name: 'builder', type: 'choice', choicesText: 'Bad Value', required: true, description: '' }] }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Agent): return field 1: choice "Bad Value" must be lowercase letters, numbers, "_-" (max 60 characters).'])

    form.steps[0]!.returns[0]!.choicesText = ''
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Agent): return field 1: needs 1 to 20 choices.'])
  })

  it('limits the description to 300 characters', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'p', returns: [{ key: 'a', name: 'note', type: 'text', choicesText: '', required: true, description: 'x'.repeat(301) }] }]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toEqual(['Step 1 (Agent): return field 1: description must be at most 300 characters.'])
  })

  it('allows at most 20 return fields', () => {
    const form = { ...emptyJob(), name: 'x' }
    form.steps = [
      { ...emptyStep('agent', 0), prompt: 'p', returns: Array.from({ length: 21 }, (_, i) => ({ key: String(i), name: `f${i}`, type: 'text' as const, choicesText: '', required: true, description: '' })) },
    ]
    expect((toPayload(form) as { ok: false; errors: string[] }).errors).toContain('Step 1 (Agent): at most 20 return fields.')
  })
})

describe('job form: read-only repo', () => {
  it('forces output to none and marks the repo read-only, even if a stale form still says "pr"', () => {
    const form = { ...emptyJob(), name: 'ro' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'Plan', repoUrl: 'https://github.com/acme/app', repoReadOnly: true, output: 'pr' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([
      {
        id: 'step-1',
        name: 'Agent',
        kind: 'agent',
        when: 'on_success',
        config: { agent: 'claude', prompt: 'Plan', repo: { url: 'https://github.com/acme/app', baseBranch: 'main', readOnly: true }, output: 'none' },
      },
    ])
  })

  it('round-trips a read-only repo', () => {
    const steps: Job['steps'] = [
      {
        id: 'plan',
        name: 'Plan',
        kind: 'agent',
        when: 'on_success',
        retries: 0,
        config: { agent: 'claude', prompt: 'Plan', repo: { url: 'https://github.com/acme/app', baseBranch: 'main', readOnly: true }, output: 'none' },
      },
    ]
    const form = fromJob({ ...job, steps })
    expect(form.steps[0]!.repoReadOnly).toBe(true)
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual(steps.map(({ retries: _r, ...s }) => s))
  })
})

describe('job form: "Plan, build, ship" template', () => {
  it('prefills a read-only plan step with typed returns, a Factory hand-off gated on its choice, and a build step that pulls Factory\'s result', () => {
    const form = planBuildShipTemplate()
    expect(form.steps.map((s) => s.id)).toEqual(['plan', 'factory', 'build'])

    const [plan, factory, build] = form.steps as [StepForm, StepForm, StepForm]
    expect(plan).toMatchObject({ name: 'Plan the work', kind: 'agent', repoReadOnly: true, output: 'none' })
    expect(plan.returns.map((f) => f.name)).toEqual(['builder', 'request', 'reason'])

    expect(factory).toMatchObject({
      name: 'Hand off to Factory',
      kind: 'action',
      actionType: 'factory',
      factoryOperation: 'from-step',
      factoryOperationFrom: 'steps.plan.out.builder',
      factoryRequest: '{{steps.plan.out.request}}',
      factoryProjectId: '',
      ifPath: 'steps.plan.out.builder',
      ifOp: 'in',
      ifValue: 'factory-task, factory-orchestration',
    })

    expect(build).toMatchObject({
      name: 'Build and open PR',
      kind: 'agent',
      startFromStep: 'factory',
      prompt: "If Factory built it, merge origin/main, run the check and fix only what fails. Otherwise build it yourself: {{steps.plan.out.request}}",
      output: 'pr',
    })

    // The Factory project id and the build step's repository are, like an agent step's
    // repository elsewhere, left for the editor to fill in before the job can run.
    const filled = { ...form, name: 'Ship it' }
    filled.steps = [plan, { ...factory, factoryProjectId: 'routini' }, { ...build, repoUrl: 'https://github.com/acme/app' }]
    const r = toPayload(filled)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const steps = r.payload['steps'] as Array<Record<string, unknown>>
    expect(steps).toHaveLength(3)
    expect(steps[1]).toMatchObject({
      id: 'factory',
      name: 'Hand off to Factory',
      if: { path: 'steps.plan.out.builder', op: 'in', value: ['factory-task', 'factory-orchestration'] },
      config: { type: 'factory', operation: 'from-step', operationFrom: 'steps.plan.out.builder', projectId: 'routini', request: '{{steps.plan.out.request}}', runtime: 'claude-code' },
    })
    expect(steps[2]).toMatchObject({ id: 'build', config: { startFrom: { step: 'factory' } } })
  })
})

describe('job form: IMAP steps still round-trip', () => {
  const base = { ...job, steps: [] as Job['steps'] }

  it('round-trips an imap step', () => {
    const steps: Job['steps'] = [{ id: 'inbox', name: 'Inbox', kind: 'action', when: 'on_success', retries: 0, config: { type: 'imap', host: 'mail.example.com', port: 993, username: 'ops', credentialKey: 'mail_pw', mailbox: 'INBOX', search: 'UNSEEN' } }]
    const form = fromJob({ ...base, steps })
    expect(form.steps[0]).toMatchObject({ actionType: 'imap', imapHost: 'mail.example.com', imapPort: '993', imapUser: 'ops', imapCredential: 'mail_pw', mailbox: 'INBOX', search: 'UNSEEN' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload['steps']).toEqual([{ id: 'inbox', name: 'Inbox', kind: 'action', when: 'on_success', config: { type: 'imap', host: 'mail.example.com', port: 993, username: 'ops', credentialKey: 'mail_pw', mailbox: 'INBOX', search: 'UNSEEN' } }])
  })
})
