// Job editor form model ⇄ API payload. Pure; see jobForm.test.ts.
// The server validates everything again; this catches the obvious early.

import type { AgentConfig, AgentId, AgentReturnField, Host, Job, Step, StepCondition, StepKind, When } from '../lib/types'

/** One row of an agent step's "Returns" list editor. `choicesText` is comma separated; a choice that needs an integration is written `value:integrationId` (e.g. `factory-task:factory`). */
export interface ReturnFieldForm {
  key: string
  name: string
  type: AgentReturnField['type']
  choicesText: string
  required: boolean
  description: string
}

/** "" means the step has no condition. */
export type IfOp = '' | StepCondition['op']

export interface StepForm {
  key: string
  id: string
  name: string
  kind: StepKind
  when: When
  retries: string
  timeoutSec: string
  // condition ("Run this step only if"), on every kind
  ifPath: string
  ifOp: IfOp
  /** eq/ne: the raw value. in/not_in: comma separated. exists/missing: unused. */
  ifValue: string
  /** On a backlog run, moves the item to this state when the step starts. '' means no change. */
  stage: '' | 'planning' | 'building' | 'finishing'
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
  factoryOperation: 'orchestrate' | 'prd' | 'task' | 'from-step'
  /** from-step only: a template path like steps.plan.out.builder, naming an earlier step. */
  factoryOperationFrom: string
  factoryProjectId: string
  factoryPrdId: string
  factoryRequest: string
  /** The Factory project's origin must match this repo, or the step fails before dispatch. Not used by PRD. */
  factoryRepoUrl: string
  /** task only: '0' to '5'. */
  factoryMaxRetries: string
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
  /** Use the backlog item's own repository (only meaningful on a backlog job) instead of `repoUrl`. */
  repoFromItem: boolean
  output: 'pr' | 'branch' | 'none'
  /** A shallow, read-only checkout next to `repoUrl` (or the item's repo); forces `output` to 'none'. */
  repoReadOnly: boolean
  checkCommand: string
  model: string
  /** Typed fields this step returns; later steps read them as {{steps.<id>.out.<name>}}. */
  returns: ReturnFieldForm[]
  /** Pull an earlier Factory step's result into this step's clone: the id of an earlier action step of type factory, or blank for "the repository". */
  startFromStep: string
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
  /** Cron only: "Run once per backlog item" — picks ready items instead of (or alongside) the clock. */
  backlogEnabled: boolean
  backlogSourceIds: string[]
  /** Comma separated; blank matches any label. */
  backlogLabels: string
  /** "Up to N per run", 1-20. */
  backlogMaxPerFire: string
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

/**
 * The earlier action steps of type factory, as `{id, name}` for an agent
 * step's "Starts from" select — the same "earlier step" set `toPayload`'s
 * `buildStartFrom` validates against, with ids defaulted the same way.
 */
export function earlierFactorySteps(steps: StepForm[], index: number): Array<{ id: string; name: string }> {
  return steps
    .map((s, i) => ({ s, id: s.id.trim() || `step-${i + 1}` }))
    .slice(0, index)
    .filter(({ s }) => s.kind === 'action' && s.actionType === 'factory')
    .map(({ s, id }) => ({ id, name: s.name.trim() || 'Action' }))
}

let counter = 0
const nextKey = () => `s${++counter}`

/** A blank row for the "Returns" list editor. */
export function emptyReturnField(): ReturnFieldForm {
  return { key: nextKey(), name: '', type: 'text', choicesText: '', required: true, description: '' }
}

export function emptyStep(kind: StepKind, index: number): StepForm {
  return {
    key: nextKey(),
    id: `step-${index + 1}`,
    name: kind === 'approval' ? 'Approval' : kind === 'agent' ? 'Agent' : 'Action',
    kind,
    when: 'on_success',
    retries: '0',
    timeoutSec: '',
    ifPath: '',
    ifOp: '',
    ifValue: '',
    stage: '',
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
    // Only meaningful once "Decided by an earlier step" is picked, but this is the shape
    // every from-step hand-off needs (see the "Plan, build, ship" template), so new steps
    // start with it filled in rather than blank.
    factoryOperationFrom: 'steps.plan.out.builder',
    factoryProjectId: '',
    factoryPrdId: '',
    factoryRequest: '',
    factoryRepoUrl: '',
    factoryMaxRetries: '0',
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
    repoFromItem: false,
    output: 'pr',
    repoReadOnly: false,
    checkCommand: '',
    model: '',
    returns: [],
    startFromStep: '',
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
  return {
    name: '',
    description: '',
    enabled: true,
    triggerKind: 'manual',
    cronExpr: '0 9 * * 1-5',
    cronTz: guessTz(),
    alertNames: '',
    alertSeverities: [],
    alertLabels: '',
    backlogEnabled: false,
    backlogSourceIds: [],
    backlogLabels: '',
    backlogMaxPerFire: '5',
    steps: [emptyStep('action', 0)],
  }
}

/** The query value for the "Plan, build, ship" starter: /jobs/new?template=plan-build-ship. */
export const PLAN_BUILD_SHIP_TEMPLATE = 'plan-build-ship'

/**
 * The "Plan, build, ship" starter: a read-only planning step whose typed
 * output (what to build, and why) decides who builds it. When the plan picks
 * Factory, a hand-off step sends it one task or orchestration (gated by the
 * plan's choice via `if`); the build step then pulls Factory's result into
 * its own clone (`startFrom`) and finishes the job, or builds it itself when
 * Factory was skipped.
 */
export function planBuildShipTemplate(): JobForm {
  const plan: StepForm = {
    ...emptyStep('agent', 0),
    id: 'plan',
    name: 'Plan the work',
    prompt: 'Read the task and the repository. Choose routini unless the work is large. Write a brief with acceptance criteria in request and say why in reason.',
    repoReadOnly: true,
    output: 'none',
    returns: [
      { key: nextKey(), name: 'builder', type: 'choice', choicesText: 'routini, factory-task:factory, factory-orchestration:factory', required: true, description: '' },
      { key: nextKey(), name: 'request', type: 'text', choicesText: '', required: true, description: '' },
      { key: nextKey(), name: 'reason', type: 'text', choicesText: '', required: true, description: '' },
    ],
  }
  const factory: StepForm = {
    ...emptyStep('action', 1),
    id: 'factory',
    name: 'Hand off to Factory',
    actionType: 'factory',
    factoryOperation: 'from-step',
    factoryOperationFrom: 'steps.plan.out.builder',
    factoryRequest: '{{steps.plan.out.request}}',
    factoryProjectId: '',
    ifPath: 'steps.plan.out.builder',
    ifOp: 'in',
    ifValue: 'factory-task, factory-orchestration',
  }
  const build: StepForm = {
    ...emptyStep('agent', 2),
    id: 'build',
    name: 'Build and open PR',
    prompt: "If Factory built it, merge origin/main, run the check and fix only what fails. Otherwise build it yourself: {{steps.plan.out.request}}",
    startFromStep: 'factory',
    output: 'pr',
  }
  return { ...emptyJob(), steps: [plan, factory, build] }
}

function guessTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function fromJob(job: Job): JobForm {
  const backlog = job.trigger.kind === 'cron' ? job.trigger.backlog : undefined
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
    backlogEnabled: backlog !== undefined,
    backlogSourceIds: backlog?.sourceIds ?? [],
    backlogLabels: (backlog?.labels ?? []).join(', '),
    backlogMaxPerFire: backlog ? String(backlog.maxPerFire) : '5',
    steps: job.steps.map((s, i) => fromStep(s, i)),
  }
}

/** A step's `if` as the three form fields; no condition round-trips to blanks. */
function fromCondition(c: StepCondition | undefined): Pick<StepForm, 'ifPath' | 'ifOp' | 'ifValue'> {
  if (!c) return { ifPath: '', ifOp: '', ifValue: '' }
  const value = c.op === 'in' || c.op === 'not_in' ? (Array.isArray(c.value) ? c.value.join(', ') : '') : typeof c.value === 'string' ? c.value : ''
  return { ifPath: c.path, ifOp: c.op, ifValue: value }
}

/** An agent's `returns` as the list editor's rows; a choice's `requires` round-trips as `value:integrationId`. */
function fromReturns(returns: AgentReturnField[] | undefined): ReturnFieldForm[] {
  return (returns ?? []).map((r) => ({
    key: nextKey(),
    name: r.name,
    type: r.type,
    choicesText: (r.choices ?? []).map((c) => (c.requires ? `${c.value}:${c.requires}` : c.value)).join(', '),
    required: r.required ?? true,
    description: r.description ?? '',
  }))
}

function fromStep(s: Step, i: number): StepForm {
  const f = {
    ...emptyStep(s.kind, i),
    id: s.id,
    name: s.name,
    when: s.when,
    retries: String(s.retries ?? 0),
    timeoutSec: s.timeoutSec ? String(s.timeoutSec) : '',
    stage: s.stage ?? ('' as const),
    ...fromCondition(s.if),
  }
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
        factoryOperationFrom: c.operationFrom ?? '',
        factoryProjectId: c.projectId ?? '',
        factoryPrdId: c.prdId ?? '',
        factoryRequest: c.request ?? '',
        factoryRepoUrl: c.repoUrl ?? '',
        factoryMaxRetries: c.maxRetries !== undefined ? String(c.maxRetries) : '0',
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
    const repoFromItem = c.repo !== undefined && 'fromItem' in c.repo
    Object.assign(f, {
      agent: c.agent,
      prompt: c.prompt,
      repoUrl: c.repo && !repoFromItem ? (c.repo as { url: string }).url : '',
      baseBranch: c.repo && !repoFromItem ? (c.repo as { baseBranch: string }).baseBranch : 'main',
      repoFromItem,
      output: c.output ?? (c.repo || c.environmentId ? 'pr' : 'none'),
      repoReadOnly: c.repo?.readOnly === true,
      checkCommand: c.check?.command ?? '',
      model: c.model ?? '',
      returns: fromReturns(c.returns),
      startFromStep: c.startFrom?.step ?? '',
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

const IF_PATH_RE = /^[A-Za-z0-9_.-]{1,200}$/

/**
 * A step's `if` from its three form fields, or undefined when no condition is
 * set (ifOp === ''). Mirrors the server contract (engine/spec.ts): path shape
 * and root, value shape per operator, and the "earlier step" rule.
 */
function buildCondition(s: StepForm, i: number, earlierIds: string[], label: string, errors: string[]): StepCondition | undefined {
  if (!s.ifOp) return undefined
  const path = s.ifPath.trim()
  if (!path || !IF_PATH_RE.test(path)) {
    errors.push(`${label}: condition path must use only letters, numbers and "_.-" (max 200 characters).`)
    return undefined
  }
  const [root, refId] = path.split('.')
  if (root !== 'steps' && root !== 'trigger') {
    errors.push(`${label}: condition path must start with steps. or trigger.`)
    return undefined
  }
  if (root === 'steps' && !earlierIds.includes(refId ?? '')) {
    errors.push(`Step ${i + 1} condition refers to step '${refId ?? ''}', which does not run before it`)
    return undefined
  }
  if (s.ifOp === 'exists' || s.ifOp === 'missing') return { path, op: s.ifOp }
  if (s.ifOp === 'in' || s.ifOp === 'not_in') {
    const values = list(s.ifValue)
    if (values.length < 1 || values.length > 20) errors.push(`${label}: condition needs 1 to 20 values.`)
    for (const v of values) if (v.length > 200) errors.push(`${label}: each condition value must be at most 200 characters.`)
    return { path, op: s.ifOp, value: values }
  }
  const value = s.ifValue.trim()
  if (!value) errors.push(`${label}: condition needs a value.`)
  else if (value.length > 200) errors.push(`${label}: condition value must be at most 200 characters.`)
  return { path, op: s.ifOp, value }
}

/**
 * A "Decided by an earlier step" Factory step's `operationFrom`: a template
 * path naming an EARLIER step's output (the path shape mirrors `if`, but it
 * is always rooted at `steps`, never `trigger`).
 */
function buildFactoryOperationFrom(raw: string, earlierIds: string[], label: string, errors: string[]): string {
  const path = raw.trim()
  if (!path || !IF_PATH_RE.test(path)) {
    errors.push(`${label}: the step path must use only letters, numbers and "_.-" (max 200 characters).`)
    return path
  }
  const [root, refId] = path.split('.')
  if (root !== 'steps') errors.push(`${label}: the step path must start with steps.`)
  else if (!earlierIds.includes(refId ?? '')) errors.push(`${label}: the step path must name a step that runs before this one.`)
  return path
}

/**
 * An agent step's `startFrom`: pulls an earlier Factory step's result into
 * this step's own clone (Contract B, engine/spec.ts). It needs this step's
 * own repository — not an environment, not a read-only checkout — and must
 * name an earlier action step of type factory.
 */
function buildStartFrom(s: StepForm, i: number, steps: StepForm[], stepIds: string[], label: string, errors: string[]): { step: string } | undefined {
  if (!s.startFromStep) return undefined
  if (s.environmentId) errors.push(`${label}: starting from Factory's result needs a repository, not an environment.`)
  else if (!s.repoUrl.trim()) errors.push(`${label}: starting from Factory's result needs a repository.`)
  if (s.repoReadOnly) errors.push(`${label}: A read-only step can't start from Factory's result.`)
  const j = stepIds.slice(0, i).indexOf(s.startFromStep)
  const target = j >= 0 ? steps[j] : undefined
  if (!target || target.kind !== 'action' || target.actionType !== 'factory') errors.push(`${label}: "Starts from" must name an earlier Factory step.`)
  return { step: s.startFromStep }
}

const RETURN_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/
const RETURN_CHOICE_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/

/**
 * An agent step's `returns` from the "Returns" list editor, or undefined when
 * the list is empty. Mirrors engine/returns.ts's validateReturns limits: at
 * most 20 fields with unique names, 1-20 choices, description <= 300 chars.
 * A choice's `requires` is written in choicesText as `value:integrationId`.
 */
function buildReturns(s: StepForm, label: string, errors: string[]): AgentReturnField[] | undefined {
  if (s.returns.length === 0) return undefined
  if (s.returns.length > 20) errors.push(`${label}: at most 20 return fields.`)
  const seen = new Set<string>()
  return s.returns.map((r, ri) => {
    const rLabel = `${label}: return field ${ri + 1}`
    const name = r.name.trim()
    if (!RETURN_NAME_RE.test(name)) errors.push(`${rLabel}: name must start with a lowercase letter and contain only letters, numbers and _ (max 40 characters).`)
    else if (seen.has(name)) errors.push(`${rLabel}: name "${name}" is already used.`)
    seen.add(name)
    const field: AgentReturnField = { name, type: r.type }
    if (r.type === 'choice') {
      const choices = list(r.choicesText).map((c) => {
        const [value = '', requires] = c.split(':').map((x) => x.trim())
        return requires ? { value, requires } : { value }
      })
      if (choices.length < 1 || choices.length > 20) errors.push(`${rLabel}: needs 1 to 20 choices.`)
      for (const c of choices) if (!RETURN_CHOICE_RE.test(c.value)) errors.push(`${rLabel}: choice "${c.value}" must be lowercase letters, numbers, "_-" (max 60 characters).`)
      field.choices = choices
    }
    if (!r.required) field.required = false
    const description = r.description.trim()
    if (description.length > 300) errors.push(`${rLabel}: description must be at most 300 characters.`)
    else if (description) field.description = description
    return field
  })
}

/**
 * A cron trigger's "Run once per backlog item" block from the Schedule tab:
 * at most 20 sources, at most 10 labels of 1-60 characters, and "up to N per
 * run" as a whole number 1-20. Mirrors the server's cron `backlog` validation
 * (engine/spec.ts); undefined when the switch is off.
 */
function buildBacklogBlock(form: JobForm, errors: string[]): { sourceIds?: string[]; labels?: string[]; maxPerFire: number } | undefined {
  if (!form.backlogEnabled) return undefined
  const sourceIds = [...new Set(form.backlogSourceIds)]
  if (sourceIds.length > 20) errors.push('Schedule: choose at most 20 sources.')
  const labels = list(form.backlogLabels)
  if (labels.length > 10) errors.push('Schedule: at most 10 labels.')
  for (const l of labels) if (l.length < 1 || l.length > 60) errors.push('Schedule: each label must be 1 to 60 characters.')
  const raw = form.backlogMaxPerFire.trim()
  const maxPerFire = Number(raw)
  if (!raw || !Number.isInteger(maxPerFire) || maxPerFire < 1 || maxPerFire > 20) errors.push('Schedule: "up to" must be a whole number from 1 to 20.')
  return { ...(sourceIds.length ? { sourceIds } : {}), ...(labels.length ? { labels } : {}), maxPerFire }
}

export type PayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; errors: string[] }

export function toPayload(form: JobForm): PayloadResult {
  const errors: string[] = []
  if (!form.name.trim()) errors.push('Give the job a name.')
  if (form.triggerKind === 'cron' && form.cronExpr.trim().split(/\s+/).length !== 5) errors.push('The schedule needs 5 cron fields: minute hour day month weekday.')
  if (form.steps.length === 0) errors.push('Add at least one step.')

  const stepIds = form.steps.map((s, i) => s.id.trim() || `step-${i + 1}`)
  const steps = form.steps.map((s, i) => {
    const label = `Step ${i + 1} (${s.name || s.kind})`
    const base: Record<string, unknown> = { id: stepIds[i], name: s.name.trim() || `Step ${i + 1}`, kind: s.kind, when: s.when }
    const retries = Number(s.retries || 0)
    if (retries) base['retries'] = retries
    if (s.timeoutSec.trim()) {
      const t = Number(s.timeoutSec)
      if (!Number.isInteger(t) || t < 1) errors.push(`${label}: timeout must be a whole number of seconds.`)
      else base['timeoutSec'] = t
    }
    const condition = buildCondition(s, i, stepIds.slice(0, i), label, errors)
    if (condition) base['if'] = condition
    if (s.stage) base['stage'] = s.stage
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
          const cfg: Record<string, unknown> = { type: 'factory', operation: s.factoryOperation, projectId: s.factoryProjectId.trim(), request: s.factoryRequest, runtime: s.factoryRuntime }
          if (s.factoryProvider.trim()) cfg['provider'] = s.factoryProvider.trim()
          if (s.factoryModel.trim()) cfg['model'] = s.factoryModel.trim()
          if (s.factoryRepoUrl.trim()) cfg['repoUrl'] = s.factoryRepoUrl.trim()
          if (s.factoryOperation === 'from-step') {
            cfg['operationFrom'] = buildFactoryOperationFrom(s.factoryOperationFrom, stepIds.slice(0, i), label, errors)
          } else if (s.factoryOperation === 'task') {
            const maxRetries = s.factoryMaxRetries.trim()
            if (maxRetries) {
              const n = Number(maxRetries)
              if (!Number.isInteger(n) || n < 0 || n > 5) errors.push(`${label}: max retries must be a whole number from 0 to 5.`)
              else if (n > 0) cfg['maxRetries'] = n
            }
          } else {
            // orchestrate
            cfg['createPr'] = s.factoryCreatePr
          }
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
      } else if (s.repoFromItem) {
        const repo: Record<string, unknown> = { fromItem: true }
        if (s.repoReadOnly) repo['readOnly'] = true
        cfg['repo'] = repo
        cfg['output'] = s.repoReadOnly ? 'none' : s.output
      } else if (s.repoUrl.trim()) {
        const repo: Record<string, unknown> = { url: s.repoUrl.trim(), baseBranch: s.baseBranch.trim() || 'main' }
        // A read-only checkout can't produce a pull request or branch; the editor
        // forces this too, but it is enforced here so a stale form can't slip through.
        if (s.repoReadOnly) repo['readOnly'] = true
        cfg['repo'] = repo
        cfg['output'] = s.repoReadOnly ? 'none' : s.output
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
      const returns = buildReturns(s, label, errors)
      if (returns) cfg['returns'] = returns
      const startFrom = buildStartFrom(s, i, form.steps, stepIds, label, errors)
      if (startFrom) cfg['startFrom'] = startFrom
      base['config'] = cfg
    } else {
      if (!s.message.trim()) errors.push(`${label}: say what is being approved.`)
      base['config'] = { message: s.message.trim(), minRole: s.minRole }
      delete base['retries']
    }
    return base
  })

  if (errors.length) return { ok: false, errors }
  const backlog = form.triggerKind === 'cron' ? buildBacklogBlock(form, errors) : undefined
  const trigger =
    form.triggerKind === 'cron'
      ? { kind: 'cron', expr: form.cronExpr.trim(), tz: form.cronTz.trim() || 'UTC', ...(backlog ? { backlog } : {}) }
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
