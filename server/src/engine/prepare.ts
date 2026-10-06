// ─────────────────────────────────────────────────────────────────────────────
// Turns a job's step spec into what actually runs: templates rendered from the
// run's trigger and earlier steps, `host: 'alert'` (a command's target or an
// agent's `runOn`) resolved to the incident's host, and the alert context put
// in front of agent prompts. Runs before
// policy, so rules see the real target host.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppContext } from '../http/common.js'
import { getHost } from '../repos/hosts.js'
import { getIncident } from '../repos/incidents.js'
import type { Run, RunStep } from '../repos/runs.js'
import { alertContext } from './alerts.js'
import type { Step } from './spec.js'
import { renderStep, type TemplateData } from './template.js'

export async function prepareStep(app: AppContext, run: Run, spec: Step, steps: RunStep[]): Promise<{ step: Step } | { error: string }> {
  const t = run.trigger
  const data: TemplateData = { steps: {}, trigger: { kind: t.kind } }
  for (const s of steps) if (s.output && typeof s.output === 'object') data.steps![s.stepId] = s.output as Record<string, unknown>
  if (t.kind === 'webhook') data.trigger = { kind: t.kind, payload: t.payload }

  let host: { name: string; address: string } | null = null
  let incident: { number: number; title: string } | null = null
  if (t.kind === 'alert') {
    const found = await app.db.org(run.orgId, async (q) => ({
      incident: await getIncident(q, run.orgId, t.incidentId),
      host: t.hostId ? await getHost(q, run.orgId, t.hostId) : null,
    }))
    incident = { number: t.incidentNumber, title: found.incident?.title ?? t.alert.name }
    host = found.host ? { name: found.host.name, address: found.host.address } : null
    data.alert = { ...t.alert }
    data.incident = { id: t.incidentId, ...incident }
    if (host) data.host = host
  }

  let step = spec
  if (step.kind === 'action' && step.config.type === 'ssh' && step.config.host === 'alert') {
    if (t.kind !== 'alert') return { error: 'This step targets the alert\'s host, but the run was not started by an alert' }
    if (!t.hostId) return { error: 'This step targets the alert\'s host, but the alert did not match a host in the fleet' }
    const { host: _alias, ...rest } = step.config
    step = { ...step, config: { ...rest, hostId: t.hostId } }
  }
  if (step.kind === 'agent' && step.config.runOn && 'host' in step.config.runOn) {
    if (t.kind !== 'alert') return { error: 'This agent step runs on the alert\'s host, but the run was not started by an alert' }
    if (!t.hostId) return { error: 'This agent step runs on the alert\'s host, but the alert did not match a host in the fleet' }
    step = { ...step, config: { ...step.config, runOn: { hostId: t.hostId } } }
  }

  step = renderStep(step, data)

  if (step.kind === 'agent' && t.kind === 'alert' && incident) {
    step = { ...step, config: { ...step.config, prompt: alertContext(t.alert, incident, host) + step.config.prompt } }
  }
  return { step }
}
