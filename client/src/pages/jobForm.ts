// Job editor form model ⇄ API payload. Pure; see jobForm.test.ts.
// The server validates everything again; this catches the obvious early.

import type { AgentConfig, AgentId, Host, Job, Step, StepKind, When } from '../lib/types'

export interface StepForm {
  key: string
  id: string
  name: string
  kind: StepKind
  when: When
  retries: string
  timeoutSec: string
  // action
  actionType: 'http' | 'ssh' | 'imap' | 'factory' | 'azure-boards' | 'teams'
  url: string
  method: string
  expectStatus: string
  headersJson: string
  body: string
  /** A host id, or ALERT_HOST for "the host the alert is about". */
  hostId: string
  command: string
  imapHost: string
  imapPort: string
  imapUser: string
  imapCredential: string
  mailbox: string
  search: string
  factoryOperation: 'orchestrate' | 'prd'
  factoryProjectId: string
  factoryPrdId: string
  factoryRequest: string
  factoryRuntime: 'claude-code' | 'omnimancer'
  factoryProvider: string
  factoryModel: string
  factoryCreatePr: boolean
  // azure-boards
  boardsProject: string
  boardsQuery: string
  boardsLimit: string
  // teams
  teamsTitle: string
  teamsMessage: string
  // agent
  agent: AgentId
  prompt: string
  repoUrl: string
  baseBranch: string
  output: 'pr' | 'branch' | 'none'
  checkCommand: string
  model: string
  /** Run in this environment (its repository) instead of a fresh container. */
  environmentId: string
  /** Run on a fleet host: a host id, ALERT_HOST, or POOL_HOST. Blank is the Routini sandbox. */
  runOnHostId: string
  /** POOL_HOST: the group to match (free text; blank matches any group). */
  runOnPoolGroup: string
  /** POOL_HOST: tags to match, space or comma separated. */
  runOnPoolTags: string
  /** Give the agent Routini's MCP tools (fleet commands, runs, incidents). */
  routini: boolean
  // approval
  message: string
  minRole: 'member' | 'admin' | 'owner'
}

export interface JobForm {
  name: string
  description: string
  enabled: boolean
  triggerKind: 'manual' | 'cron' | 'webhook' | 'alert'
  /** Alert trigger: names (comma separated; "Disk*" matches a prefix), severities, label=value lines. */
  alertNames: string
  alertSeverities: string[]
  alertLabels: string
  cronExpr: string
  cronTz: string
  steps: StepForm[]
}

/** Step host value meaning "the host the alert is about" (config `host: 'alert'`). */
export const ALERT_HOST = 'alert'
/** Agent step "Run on" value meaning "a host picked from a pool at run time" (config `runOn: { pool }`). */
export const POOL_HOST = '__pool__'

/** A spec's host fields as one form value: ALERT_HOST, a host id, or blank. */
function hostValue(target: { hostId?: string; host?: 'alert' } | undefined): string {
  if (!target) return ''
  return target.host === 'alert' ? ALERT_HOST : target.hostId ?? ''
}

/** The form value back as the spec writes it: `host: 'alert'` or a host id. */
function hostTarget(value: string): { host: 'alert' } | { hostId: string } {
  return value === ALERT_HOST ? { host: 'alert' } : { hostId: value }
}

/** An agent step's `runOn` as one form value: ALERT_HOST, POOL_HOST, a host id, or blank. */
function agentRunOnValue(target: AgentConfig['runOn'] | undefined): string {
  if (!target) return ''
  if ('pool' in target) return POOL_HOST
  return hostValue(target)
}

/** Tags from the free-text pool tags field: space or comma separated, deduplicated. */
export function poolTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
}

/** How many runner hosts match a pool's group/tags, and how many of those can run agents right now. */
export function poolMatch(hosts: Host[], group: string, tags: string[]): { matches: number; canRunNow: number } {
  const g = group.trim()
  const matches = hosts.filter((h) => h.transport === 'runner' && (!g || h.group === g) && tags.every((t) => h.tags.includes(t)))
  return { matches: matches.length, canRunNow: matches.filter((h) => runOnBlocked(h) === null).length }
}

/** Only alert-triggered jobs can target the host an alert is about. */
function checkAlertHost(value: string, form: JobForm, label: string, errors: string[]): void {
  if (value === ALERT_HOST && form.triggerKind !== 'alert') errors.push(`${label}: only alert-triggered jobs can run on the alert's host.`)
}

/** One entry of the agent step's "Run on" select. */
export interface RunOnOption {
  value: string
  label: string
  /** Listed so the choice is visible, but not selectable; the label says why. */
  disabled?: boolean
}

/**
 * Why a fleet host cannot take agent work, or null when it can. Revoked and
 * disconnected runners read the same ("offline"): either way nothing reaches them.
 */
export function runOnBlocked(host: Host): string | null {
  const r = host.runner
  if (!r || r.revoked || !r.online) return 'offline'
  if (!r.capabilities.includes('agents')) return 'agents not enabled'
  return null
}

/**
 * The "Run on" choices for an agent step: the Routini sandbox (the default),
 * the alert's host, and every runner host. Hosts that cannot run agents are
 * listed but disabled so it is clear why they can't be picked.
 */
export function runOnOptions(opts: { hosts: Host[]; alertTrigger: boolean; selected: string }): RunOnOption[] {
  const options: RunOnOption[] = [{ value: '', label: 'Routini sandbox' }]
  // Always listed, so the choice is discoverable and a value saved under an
  // alert trigger stays visible after the trigger changes — but only selectable
  // on alert-triggered jobs, which is what toPayload enforces.
  options.push({ value: ALERT_HOST, label: `The alert's host${opts.alertTrigger ? '' : ' (alert-triggered jobs only)'}`, disabled: !opts.alertTrigger })
  options.push({ value: POOL_HOST, label: 'A host from a pool...' })
  for (const h of opts.hosts) {
    if (h.transport !== 'runner') continue
    const blocked = runOnBlocked(h)
    options.push({ value: h.id, label: blocked ? `${h.name} (${blocked})` : h.name, disabled: blocked !== null })
  }
  // A host that has left the fleet: keep the saved value visible and named by
  // its id, rather than silently moving the step back to the sandbox.
  if (opts.selected && !options.some((o) => o.value === opts.selected)) options.push({ value: opts.selected, label: `Host ${opts.selected} (no longer in the fleet)`, disabled: true })
  return options
}

let counter = 0
const nextKey = () => `s${++counter}`

export function emptyStep(kind: StepKind, index: number): StepForm {
  return {
    key: nextKey(),
    id: `step-${index + 1}`,
    name: kind === 'approval' ? 'Approval' : kind === 'agent' ? 'Agent' : 'Action',
    kind,
    when: 'on_success',
    retries: '0',
    timeoutSec: '',
    actionType: 'http',
    url: '',
    method: 'GET',
    expectStatus: '',
    headersJson: '',
    body: '',
    hostId: '',
    command: '',
    imapHost: '',
    imapPort: '',
    imapUser: '',
    imapCredential: '',
    mailbox: '',
    search: '',
    factoryOperation: 'orchestrate',
    factoryProjectId: '',
    factoryPrdId: '',
    factoryRequest: '',
    factoryRuntime: 'claude-code',
    factoryProvider: '',
    factoryModel: '',
    factoryCreatePr: true,
    boardsProject: '',
    boardsQuery: '',
    boardsLimit: '',
    teamsTitle: '',
    teamsMessage: '',
    agent: 'claude',
    prompt: '',
    repoUrl: '',
    baseBranch: 'main',
    output: 'pr',
    checkCommand: '',
    model: '',
    environmentId: '',
    runOnHostId: '',
    runOnPoolGroup: '',
    runOnPoolTags: '',
    routini: false,
    message: '',
    minRole: 'member',
  }
}

export function emptyJob(): JobForm {
  return { name: '', description: '', enabled: true, triggerKind: 'manual', cronExpr: '0 9 * * 1-5', cronTz: guessTz(), alertNames: '', alertSeverities: [], alertLabels: '', steps: [emptyStep('action', 0)] }
}

function guessTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function fromJob(job: Job): JobForm {
  return {
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    triggerKind: job.trigger.kind,
    cronExpr: job.trigger.kind === 'cron' ? job.trigger.expr : '0 9 * * 1-5',
    cronTz: job.trigger.kind === 'cron' ? job.trigger.tz : guessTz(),
    alertNames: job.trigger.kind === 'alert' ? (job.trigger.match.alertnames ?? []).join(', ') : '',
    alertSeverities: job.trigger.kind === 'alert' ? job.trigger.match.severities ?? [] : [],
    alertLabels:
      job.trigger.kind === 'alert'
        ? Object.entries(job.trigger.match.labels ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')
        : '',
    steps: job.steps.map((s, i) => fromStep(s, i)),
  }
}

function fromStep(s: Step, i: number): StepForm {
  const f = { ...emptyStep(s.kind, i), id: s.id, name: s.name, when: s.when, retries: String(s.retries ?? 0), timeoutSec: s.timeoutSec ? String(s.timeoutSec) : '' }
  if (s.kind === 'action') {
    const c = s.config
    f.actionType = c.type
    if (c.type === 'http') {
      Object.assign(f, { url: c.url, method: c.method ?? 'GET', expectStatus: c.expectStatus ? String(c.expectStatus) : '', headersJson: c.headers ? JSON.stringify(c.headers, null, 2) : '', body: c.body ?? '' })
    } else if (c.type === 'ssh') {
      Object.assign(f, { hostId: hostValue(c), command: c.command })
    } else if (c.type === 'factory') {
      Object.assign(f, {
        factoryOperation: c.operation,
        factoryProjectId: c.projectId ?? '',
        factoryPrdId: c.prdId ?? '',
        factoryRequest: c.request ?? '',
        factoryRuntime: c.runtime ?? 'claude-code',
        factoryProvider: c.provider ?? '',
        factoryModel: c.model ?? '',
        factoryCreatePr: c.createPr ?? true,
      })
    } else if (c.type === 'azure-boards') {
      Object.assign(f, { boardsProject: c.project, boardsQuery: c.query ?? '', boardsLimit: c.limit ? String(c.limit) : '' })
    } else if (c.type === 'teams') {
      Object.assign(f, { teamsTitle: c.title ?? '', teamsMessage: c.message })
    } else if (c.type === 'imap') {
      Object.assign(f, { imapHost: c.host, imapPort: c.port ? String(c.port) : '', imapUser: c.username, imapCredential: c.credentialKey, mailbox: c.mailbox ?? '', search: c.search ?? '' })
    }
  } else if (s.kind === 'agent') {
    const c = s.config
    Object.assign(f, {
      agent: c.agent,
      prompt: c.prompt,
      repoUrl: c.repo?.url ?? '',
      baseBranch: c.repo?.baseBranch ?? 'main',
      output: c.output ?? (c.repo || c.environmentId ? 'pr' : 'none'),
      checkCommand: c.check?.command ?? '',
      model: c.model ?? '',
      environmentId: c.environmentId ?? '',
      runOnHostId: agentRunOnValue(c.runOn),
      runOnPoolGroup: c.runOn && 'pool' in c.runOn ? (c.runOn.pool.group ?? '') : '',
      runOnPoolTags: c.runOn && 'pool' in c.runOn ? (c.runOn.pool.tags ?? []).join(' ') : '',
      routini: c.routini === true,
    })
  } else {
    Object.assign(f, { message: s.config.message, minRole: s.config.minRole ?? 'member' })
  }
  return f
}

export type PayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; errors: string[] }

export function toPayload(form: JobForm): PayloadResult {
  const errors: string[] = []
  if (!form.name.trim()) errors.push('Give the job a name.')
  if (form.triggerKind === 'cron' && form.cronExpr.trim().split(/\s+/).length !== 5) errors.push('The schedule needs 5 cron fields: minute hour day month weekday.')
  if (form.steps.length === 0) errors.push('Add at least one step.')

  const steps = form.steps.map((s, i) => {
    const label = `Step ${i + 1} (${s.name || s.kind})`
    const base: Record<string, unknown> = { id: s.id.trim() || `step-${i + 1}`, name: s.name.trim() || `Step ${i + 1}`, kind: s.kind, when: s.when }
    const retries = Number(s.retries || 0)
    if (retries) base['retries'] = retries
    if (s.timeoutSec.trim()) {
      const t = Number(s.timeoutSec)
      if (!Number.isInteger(t) || t < 1) errors.push(`${label}: timeout must be a whole number of seconds.`)
      else base['timeoutSec'] = t
    }
    if (s.kind === 'action') {
      if (s.actionType === 'http') {
        if (!s.url.trim()) errors.push(`${label}: enter a URL.`)
        const cfg: Record<string, unknown> = { type: 'http', url: s.url.trim(), method: s.method }
        if (s.expectStatus.trim()) cfg['expectStatus'] = Number(s.expectStatus)
        if (s.headersJson.trim()) {
          try {
            cfg['headers'] = JSON.parse(s.headersJson)
          } catch {
            errors.push(`${label}: headers must be a JSON object.`)
          }
        }
        if (s.body) cfg['body'] = s.body
        base['config'] = cfg
      } else if (s.actionType === 'ssh') {
        if (!s.hostId) errors.push(`${label}: choose a host.`)
        checkAlertHost(s.hostId, form, label, errors)
        if (!s.command.trim()) errors.push(`${label}: enter a command.`)
        base['config'] = { type: 'ssh', ...hostTarget(s.hostId), command: s.command }
      } else if (s.actionType === 'factory') {
        const idOk = (v: string) => /^[A-Za-z0-9_-]+$/.test(v.trim())
        if (s.factoryOperation === 'prd') {
          if (!idOk(s.factoryPrdId)) errors.push(`${label}: enter the Factory PRD id.`)
          base['config'] = { type: 'factory', operation: 'prd', prdId: s.factoryPrdId.trim() }
        } else {
          if (!idOk(s.factoryProjectId)) errors.push(`${label}: enter the Factory project id.`)
          if (!s.factoryRequest.trim()) errors.push(`${label}: describe what Factory should build.`)
          const cfg: Record<string, unknown> = { type: 'factory', operation: 'orchestrate', projectId: s.factoryProjectId.trim(), request: s.factoryRequest, runtime: s.factoryRuntime, createPr: s.factoryCreatePr }
          if (s.factoryProvider.trim()) cfg['provider'] = s.factoryProvider.trim()
          if (s.factoryModel.trim()) cfg['model'] = s.factoryModel.trim()
          base['config'] = cfg
        }
      } else if (s.actionType === 'azure-boards') {
        const project = s.boardsProject.trim()
        if (!project) errors.push(`${label}: enter the Azure DevOps project.`)
        const limitTrim = s.boardsLimit.trim()
        if (limitTrim) {
          const n = Number(limitTrim)
          if (!Number.isInteger(n) || n < 1 || n > 200) errors.push(`${label}: limit must be a whole number from 1 to 200.`)
        }
        const cfg: Record<string, unknown> = { type: 'azure-boards', project }
        if (s.boardsQuery.trim()) cfg['query'] = s.boardsQuery
        if (limitTrim) {
          const n = Number(limitTrim)
          if (Number.isInteger(n) && n >= 1 && n <= 200) cfg['limit'] = n
        }
        base['config'] = cfg
      } else if (s.actionType === 'teams') {
        if (!s.teamsMessage.trim()) errors.push(`${label}: enter the message to post.`)
        if (s.teamsTitle.length > 200) errors.push(`${label}: the title can be at most 200 characters.`)
        const cfg: Record<string, unknown> = { type: 'teams', message: s.teamsMessage }
        if (s.teamsTitle.trim()) cfg['title'] = s.teamsTitle.trim()
        base['config'] = cfg
      } else if (s.actionType === 'imap') {
        if (!s.imapHost.trim() || !s.imapUser.trim() || !s.imapCredential.trim()) errors.push(`${label}: IMAP needs host, username and a credential.`)
        const cfg: Record<string, unknown> = { type: 'imap', host: s.imapHost.trim(), username: s.imapUser.trim(), credentialKey: s.imapCredential.trim() }
        if (s.imapPort.trim()) cfg['port'] = Number(s.imapPort)
        if (s.mailbox.trim()) cfg['mailbox'] = s.mailbox.trim()
        if (s.search.trim()) cfg['search'] = s.search.trim()
        base['config'] = cfg
      }
    } else if (s.kind === 'agent') {
      if (!s.prompt.trim()) errors.push(`${label}: tell the agent what to do.`)
      const cfg: Record<string, unknown> = { agent: s.agent, prompt: s.prompt }
      if (s.environmentId) {
        // The environment brings its own repository.
        cfg['environmentId'] = s.environmentId
        cfg['output'] = s.output
      } else if (s.repoUrl.trim()) {
        cfg['repo'] = { url: s.repoUrl.trim(), baseBranch: s.baseBranch.trim() || 'main' }
        cfg['output'] = s.output
      }
      if (s.runOnHostId) {
        // The server rejects both too; catching it here keeps the message next
        // to the two fields that disagree.
        if (s.environmentId) errors.push(`${label}: run on a fleet host or in an environment, not both.`)
        if (s.runOnHostId === POOL_HOST) {
          const group = s.runOnPoolGroup.trim()
          const tags = poolTags(s.runOnPoolTags)
          if (!group && !tags.length) errors.push(`${label}: a host pool needs a group or at least one tag.`)
          else cfg['runOn'] = { pool: { ...(group ? { group } : {}), ...(tags.length ? { tags } : {}) } }
        } else {
          checkAlertHost(s.runOnHostId, form, label, errors)
          cfg['runOn'] = hostTarget(s.runOnHostId)
        }
      }
      if (s.checkCommand.trim()) cfg['check'] = { command: s.checkCommand.trim() }
      if (s.model.trim()) cfg['model'] = s.model.trim()
      if (s.routini) cfg['routini'] = true
      base['config'] = cfg
    } else {
      if (!s.message.trim()) errors.push(`${label}: say what is being approved.`)
      base['config'] = { message: s.message.trim(), minRole: s.minRole }
      delete base['retries']
    }
    return base
  })

  if (errors.length) return { ok: false, errors }
  const trigger =
    form.triggerKind === 'cron'
      ? { kind: 'cron', expr: form.cronExpr.trim(), tz: form.cronTz.trim() || 'UTC' }
      : form.triggerKind === 'alert'
        ? { kind: 'alert', match: alertMatch(form, errors) }
        : { kind: form.triggerKind }
  if (errors.length) return { ok: false, errors }
  return { ok: true, payload: { name: form.name.trim(), description: form.description, enabled: form.enabled, trigger, steps } }
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** The alert trigger's match from the form; blank fields match anything. */
export function alertMatch(form: JobForm, errors: string[]): Record<string, unknown> {
  const match: Record<string, unknown> = {}
  const names = list(form.alertNames)
  if (names.length) match['alertnames'] = names
  if (form.alertSeverities.length) match['severities'] = form.alertSeverities
  const labels: Record<string, string> = {}
  for (const line of form.alertLabels.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) errors.push(`Alert labels: "${line}" should look like name=value.`)
    else labels[m[1]!] = m[2]!
  }
  if (Object.keys(labels).length) match['labels'] = labels
  return match
}
