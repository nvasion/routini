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
import { getItem, getSource } from '../repos/backlog.js'
import type { Run, RunStep } from '../repos/runs.js'
import { alertContext } from './alerts.js'
import { pickPoolHost, PoolError } from './pool.js'
import type { Step } from './spec.js'
import { lookup, renderStep, type TemplateData } from './template.js'

/** The template data for a run: earlier steps' outputs, the trigger, and (alerts) the alert/incident/host. */
export async function buildTemplateData(app: AppContext, run: Run, steps: RunStep[]): Promise<TemplateData> {
  const t = run.trigger
  const data: TemplateData = { steps: {}, trigger: { kind: t.kind } }
  for (const s of steps) if (s.output && typeof s.output === 'object') data.steps![s.stepId] = s.output as Record<string, unknown>
  if (t.kind === 'webhook') data.trigger = { kind: t.kind, payload: t.payload }

  if (t.kind === 'alert') {
    const found = await app.db.org(run.orgId, async (q) => ({
      incident: await getIncident(q, run.orgId, t.incidentId),
      host: t.hostId ? await getHost(q, run.orgId, t.hostId) : null,
    }))
    const incident = { number: t.incidentNumber, title: found.incident?.title ?? t.alert.name }
    const host = found.host ? { name: found.host.name, address: found.host.address } : null
    data.alert = { ...t.alert }
    data.incident = { id: t.incidentId, ...incident }
    if (host) data.host = host
  }

  if (t.kind === 'backlog') {
    const found = await app.db.org(run.orgId, async (q) => ({
      item: await getItem(q, run.orgId, t.itemId),
      source: await getSource(q, run.orgId, t.sourceId),
    }))
    if (found.item && found.source) {
      data.item = {
        id: found.item.id,
        title: found.item.title,
        body: found.item.body,
        url: found.item.url,
        repo: found.item.repoUrl ?? found.source.defaultRepoUrl,
        baseBranch: found.item.baseBranch ?? found.source.defaultBaseBranch,
        labels: found.item.labels,
        source: found.source.name,
        externalId: found.item.externalId,
        factoryProjectId: found.source.factoryProjectId,
      }
    }
  }
  return data
}

export async function prepareStep(app: AppContext, run: Run, spec: Step, steps: RunStep[]): Promise<{ step: Step } | { error: string }> {
  const t = run.trigger
  const data = await buildTemplateData(app, run, steps)
  const incident = data.incident as { id: string; number: number; title: string } | undefined
  const host = data.host as { name: string; address: string } | undefined

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
  if (step.kind === 'agent' && step.config.repo && 'fromItem' in step.config.repo) {
    if (t.kind !== 'backlog') return { error: "This step uses the item's repository, but the run was not started from a backlog item" }
    const item = data.item as { title: string; repo: string | null; baseBranch: string } | undefined
    if (!item || !item.repo) return { error: `Item '${item?.title ?? ''}' has no repository; set one on the item or its source` }
    const { fromItem: _fromItem, ...rest } = step.config.repo
    step = { ...step, config: { ...step.config, repo: { url: item.repo, baseBranch: item.baseBranch, ...rest } } }
  }
  if (step.kind === 'agent' && step.config.runOn && 'pool' in step.config.runOn) {
    const pool = step.config.runOn.pool
    try {
      const picked = await app.db.org(run.orgId, (q) => pickPoolHost(q, run.orgId, pool))
      step = { ...step, config: { ...step.config, runOn: picked } }
    } catch (err) {
      if (err instanceof PoolError) return { error: err.message }
      throw err
    }
  }

  // Factory "from-step": resolve what an earlier step chose into a concrete
  // Factory operation. operationFrom stays on the config as a marker that this
  // step's git checks are required, even once it resolves to 'orchestrate'.
  if (step.kind === 'action' && step.config.type === 'factory' && step.config.operation === 'from-step') {
    const chosen = lookup(data, step.config.operationFrom!)
    const resolved = chosen === 'factory-task' || chosen === 'task' ? 'task' : chosen === 'factory-orchestration' || chosen === 'orchestrate' ? 'orchestrate' : null
    if (!resolved) return { error: `Step chose '${chosen}', which is not a Factory builder` }
    step = { ...step, config: { ...step.config, operation: resolved } }
  }

  step = renderStep(step, data)

  if (step.kind === 'action' && step.config.type === 'factory' && step.config.projectId === '') {
    return { error: "The item's source has no Factory project" }
  }

  if (step.kind === 'agent' && t.kind === 'alert' && incident) {
    step = { ...step, config: { ...step.config, prompt: alertContext(t.alert, incident, host ?? null) + step.config.prompt } }
  }
  return { step }
}
