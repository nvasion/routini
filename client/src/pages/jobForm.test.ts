import { describe, expect, it } from 'vitest'
import type { Job } from '../lib/types'
import { emptyJob, emptyStep, fromJob, toPayload } from './jobForm'

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
