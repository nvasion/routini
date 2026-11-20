// ─────────────────────────────────────────────────────────────────────────────
// Job specification: triggers and steps, and their validation.
//
// A job is a trigger plus an ordered list of steps. Each step is one of:
//   action    – a deterministic operation (http / ssh / imap / factory / azure-boards / teams)
//   agent     – a coding agent in a container (executor arrives in M3)
//   approval  – pause the run until a person approves or denies
// `when` decides whether a step runs, relative to the outcome of the last step
// that actually ran: on_success (default), on_failure, or always.
// ─────────────────────────────────────────────────────────────────────────────

import { CronExpressionParser } from 'cron-parser'
import { AGENT_IDS, type AgentId } from '../integrations/catalog.js'
import type { Role } from '../repos/identity.js'
import { validateRepoUrl } from '../utils/repoUrl.js'
import { RESERVED_PREFIXES, validateCredentialKey } from '../repos/credentials.js'
import { credentialKeys, placeholderPaths } from './template.js'

export type Trigger =
  | { kind: 'manual' }
  | { kind: 'cron'; expr: string; tz: string; backlog?: BacklogTrigger }
  | { kind: 'webhook' }
  | { kind: 'alert'; match: AlertMatch }

/** Makes a cron job also pick ready backlog items, one run each, every fire. */
export interface BacklogTrigger {
  /** Only these sources; omitted means any. */
  sourceIds?: string[]
  /** Only items with all of these labels; omitted means any. */
  labels?: string[]
  /** At most this many items per fire. */
  maxPerFire: number
}

/** Which alerts start an alert-triggered job. Every given condition must hold. */
export interface AlertMatch {
  /** Alert names (exact, or a prefix ending in "*"). */
  alertnames?: string[]
  severities?: string[]
  /** Label values (exact, or a prefix ending in "*"). */
  labels?: Record<string, string>
}

export type When = 'on_success' | 'on_failure' | 'always'

/**
 * Skips the step when the condition is false. `path` is a template path
 * (without braces) rooted at `steps` or `trigger`, compared as a string via
 * engine/template.ts `lookup()`; `exists`/`missing` test for a non-empty value.
 */
export interface IfCondition {
  path: string
  op: 'eq' | 'ne' | 'in' | 'not_in' | 'exists' | 'missing'
  value?: string | string[]
}

/** `actual` is the string `lookup()` (engine/template.ts) returned for `cond.path`. */
export function evaluateIf(cond: IfCondition, actual: string): boolean {
  switch (cond.op) {
    case 'eq':
      return actual === cond.value
    case 'ne':
      return actual !== cond.value
    case 'in':
      return (cond.value as string[]).includes(actual)
    case 'not_in':
      return !(cond.value as string[]).includes(actual)
    case 'exists':
      return actual !== ''
    case 'missing':
      return actual === ''
  }
}

export type ActionConfig =
  | {
      type: 'http'
      url: string
      method?: string
      /** A value may be credential references and literal text only, e.g. `Bearer {{credentials.<key>}}`. */
      headers?: Record<string, string>
      body?: string
      expectStatus?: number
      timeoutMs?: number
      /** Headers that reference credentials, filled by the executor. Set by templating at run time, never by job authors. */
      credentialHeaders?: Record<string, string>
    }
  /** A command on a host, over SSH or routini-runner. `host: 'alert'` targets the incident's host. */
  | { type: 'ssh'; hostId?: string; host?: 'alert'; command: string; /** Set by templating at run time, never by job authors. */ env?: Record<string, string> }
  | { type: 'imap'; host: string; port?: number; username: string; credentialKey: string; mailbox?: string; search?: string; tls?: boolean }
  | {
      type: 'factory'
      operation: 'orchestrate' | 'prd' | 'task' | 'from-step'
      /** `from-step` only: a template path (e.g. `steps.plan.out.builder`) naming an earlier step. */
      operationFrom?: string
      projectId?: string
      prdId?: string
      request?: string
      runtime?: 'claude-code' | 'omnimancer'
      provider?: string
      model?: string
      createPr?: boolean
      /** The Factory project's origin must be this repo. */
      repoUrl?: string
      /** `task` only, 0-5. */
      maxRetries?: number
    }
  | { type: 'azure-boards'; project: string; query?: string; limit?: number }
  | { type: 'teams'; message: string; title?: string }

/** A field an agent returns, written to `$ROUTINI_OUT_FILE` as one JSON object. */
export interface ReturnField {
  name: string
  type: 'text' | 'number' | 'boolean' | 'choice'
  /** For type "choice". Each choice may need an integration (`requires`); unavailable ones are dropped. */
  choices?: { value: string; requires?: string }[]
  /** Default true. */
  required?: boolean
  description?: string
}

/** A concrete repository for an agent step; `readOnly` forbids `output: 'pr' | 'branch'`. */
export interface AgentRepo {
  url: string
  baseBranch: string
  readOnly?: boolean
}
/** The run's backlog item's own repository (its `repoUrl`, or its source's default); resolved by prepareStep. */
export interface FromItemRepo {
  fromItem: true
  readOnly?: boolean
}

/** Narrows a possibly-unresolved `repo` to its concrete shape; `undefined` for `fromItem` (prepareStep resolves it before the engine or policy ever reads `.url`). */
export function concreteRepo(repo: AgentRepo | FromItemRepo | undefined): AgentRepo | undefined {
  return repo && !('fromItem' in repo) ? repo : undefined
}

export interface AgentConfig {
  agent: AgentId
  prompt: string
  repo?: AgentRepo | FromItemRepo
  output?: 'pr' | 'branch' | 'none'
  check?: { command: string }
  model?: string
  /** Typed fields the agent must write before it finishes; later steps read them as `{{steps.<id>.out.<name>}}`. */
  returns?: ReturnField[]
  /** Run inside this persistent environment (and its repository) instead of a fresh container. */
  environmentId?: string
  /**
   * Pull an earlier Factory action step's result into this agent's clone before
   * it starts. The step must be an earlier `action` step of type `factory`; needs
   * `repo` (not `environmentId`), and `repo` must not be `readOnly`.
   */
  startFrom?: { step: string }
  /**
   * Run on this fleet host (routini-runner with the agents capability)
   * instead of the Routini sandbox; `pool` picks the least busy host that
   * matches, resolved at run time (see engine/pool.ts).
   */
  runOn?: { hostId: string } | { host: 'alert' } | { pool: { group?: string; tags?: string[] } }
  /** Give the agent Routini's own MCP tools (fleet commands, runs, incidents) with a run-scoped token. */
  routini?: boolean
  resources?: { cpus?: number; memoryMb?: number }
}

export interface ApprovalConfig {
  message: string
  minRole?: Exclude<Role, 'viewer'>
}

export const STAGES = ['planning', 'building', 'finishing'] as const
export type Stage = (typeof STAGES)[number]

interface StepBase {
  id: string
  name: string
  when: When
  timeoutSec?: number
  retries: number
  if?: IfCondition
  /** A backlog run moves its item to this state when the step starts running. */
  stage?: Stage
}
export type Step =
  | (StepBase & { kind: 'action'; config: ActionConfig })
  | (StepBase & { kind: 'agent'; config: AgentConfig })
  | (StepBase & { kind: 'approval'; config: ApprovalConfig })

export interface JobSpec {
  name: string
  description: string
  trigger: Trigger
  steps: Step[]
  enabled: boolean
}

export const MAX_STEPS = 30
export const MAX_RETRIES = 5
export const MAX_TIMEOUT_SEC = 6 * 60 * 60

export class SpecError extends Error {}
const fail = (msg: string): never => {
  throw new SpecError(msg)
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, path: string, max = 1000, opts: { optional?: boolean; allowEmpty?: boolean } = {}): string | undefined => {
  if (v === undefined && opts.optional) return undefined
  if (typeof v !== 'string') return fail(`${path} must be a string`)
  if (!opts.allowEmpty && v.trim() === '') return fail(`${path} must not be empty`)
  if (v.length > max) return fail(`${path} must be at most ${max} characters`)
  return v
}
const int = (v: unknown, path: string, min: number, max: number): number | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return fail(`${path} must be an integer between ${min} and ${max}`)
  return v
}

/** A header naming credentials holds only literal text and `{{credentials.<key>}}` of keys a job may read. */
function checkCredentialRefs(value: string, path: string): void {
  const keys = credentialKeys(value)
  if (!keys.length) return
  if (keys.length !== placeholderPaths(value).length) fail(`${path} can't mix a credential with other placeholders`)
  for (const key of keys) {
    try {
      validateCredentialKey(key)
    } catch (err) {
      fail(`${path}: ${(err as Error).message}`)
    }
    if (RESERVED_PREFIXES.some((pre) => key.startsWith(pre))) fail(`${path}: credentials starting with ${RESERVED_PREFIXES.join(' or ')} are managed by Routini`)
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Next fire time strictly after `after`, or throws SpecError for an invalid expression. */
export function nextCronTime(expr: string, tz: string, after: Date): Date {
  if (expr.trim().split(/\s+/).length !== 5) fail('trigger.expr must be a 5-field cron expression (minute hour day month weekday)')
  if (!isValidTimeZone(tz)) fail(`trigger.tz "${tz}" is not a known time zone`)
  try {
    return CronExpressionParser.parse(expr, { currentDate: after, tz }).next().toDate()
  } catch (err) {
    return fail(`trigger.expr is not a valid cron expression: ${(err as Error).message}`)
  }
}

export function parseTrigger(raw: unknown): Trigger {
  if (!isObj(raw)) return fail('trigger must be an object')
  switch (raw['kind']) {
    case 'manual':
      return { kind: 'manual' }
    case 'webhook':
      return { kind: 'webhook' }
    case 'alert':
      return { kind: 'alert', match: parseAlertMatch(raw['match']) }
    case 'cron': {
      const expr = str(raw['expr'], 'trigger.expr', 100)!.trim()
      const tz = raw['tz'] === undefined ? 'UTC' : str(raw['tz'], 'trigger.tz', 64)!
      nextCronTime(expr, tz, new Date()) // validates
      const backlog = raw['backlog'] !== undefined ? parseBacklogTrigger(raw['backlog']) : undefined
      return { kind: 'cron', expr, tz, ...(backlog ? { backlog } : {}) }
    }
    default:
      return fail('trigger.kind must be one of: manual, cron, webhook, alert')
  }
}

function parseBacklogTrigger(raw: unknown): BacklogTrigger {
  if (!isObj(raw)) return fail('trigger.backlog must be an object')
  let sourceIds: string[] | undefined
  if (raw['sourceIds'] !== undefined) {
    const v = raw['sourceIds']
    if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
      fail('trigger.backlog.sourceIds must be a list of up to 20 source ids')
    }
    sourceIds = [...new Set(v as string[])]
  }
  let labels: string[] | undefined
  if (raw['labels'] !== undefined) {
    const v = raw['labels']
    if (!Array.isArray(v) || v.length > 10 || !v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 60)) {
      fail('trigger.backlog.labels must be a list of up to 10 strings of 1 to 60 characters')
    }
    labels = [...new Set(v as string[])]
  }
  if (raw['maxPerFire'] === undefined) fail('trigger.backlog.maxPerFire must be an integer between 1 and 20')
  const maxPerFire = int(raw['maxPerFire'], 'trigger.backlog.maxPerFire', 1, 20)!
  return { ...(sourceIds?.length ? { sourceIds } : {}), ...(labels?.length ? { labels } : {}), maxPerFire }
}

function parseAlertMatch(raw: unknown): AlertMatch {
  if (raw === undefined) return {}
  if (!isObj(raw)) return fail('trigger.match must be an object')
  const list = (v: unknown, path: string): string[] | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 200)) return fail(`${path} must be a list of up to 20 strings`)
    return [...new Set((v as string[]).map((x) => x.trim()))]
  }
  const m: AlertMatch = {}
  const names = list(raw['alertnames'], 'trigger.match.alertnames')
  if (names?.length) m.alertnames = names
  const sev = list(raw['severities'], 'trigger.match.severities')
  if (sev?.length) m.severities = sev.map((s) => s.toLowerCase())
  if (raw['labels'] !== undefined) {
    if (!isObj(raw['labels'])) fail('trigger.match.labels must be an object of strings')
    const entries = Object.entries(raw['labels'] as Record<string, unknown>)
    if (entries.length > 20) fail('trigger.match.labels: at most 20 labels')
    const labels: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(k) || typeof v !== 'string' || v.length > 200) fail('trigger.match.labels must map label names to strings')
      labels[k] = v as string
    }
    if (entries.length) m.labels = labels
  }
  return m
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Factory step's `projectId`/`repoUrl` may be exactly these, filled from the run's backlog item at render time. */
export const ITEM_PROJECT_PLACEHOLDER = '{{item.factoryProjectId}}'
export const ITEM_REPO_PLACEHOLDER = '{{item.repo}}'

function parseAction(c: Record<string, unknown>, p: string): ActionConfig {
  switch (c['type']) {
    case 'http': {
      const method = (str(c['method'], `${p}.method`, 10, { optional: true }) ?? 'GET').toUpperCase()
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail(`${p}.method is not a supported HTTP method`)
      let headers: Record<string, string> | undefined
      if (c['headers'] !== undefined) {
        if (!isObj(c['headers'])) fail(`${p}.headers must be an object of strings`)
        headers = {}
        for (const [k, v] of Object.entries(c['headers'] as Record<string, unknown>)) {
          if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(k)) fail(`${p}.headers must map header names to strings`)
          checkCredentialRefs(v as string, `${p}.headers.${k}`)
          headers[k] = v as string
        }
      }
      return {
        type: 'http',
        url: str(c['url'], `${p}.url`, 2000)!,
        method,
        headers,
        body: str(c['body'], `${p}.body`, 100_000, { optional: true, allowEmpty: true }),
        expectStatus: int(c['expectStatus'], `${p}.expectStatus`, 100, 599),
        timeoutMs: int(c['timeoutMs'], `${p}.timeoutMs`, 1, 30_000),
      }
    }
    case 'ssh': {
      const command = str(c['command'], `${p}.command`, 8000)!
      if (c['host'] !== undefined) {
        if (c['host'] !== 'alert') fail(`${p}.host must be "alert" (the incident's host)`)
        if (c['hostId'] !== undefined) fail(`${p}: use either hostId or host, not both`)
        return { type: 'ssh', host: 'alert', command }
      }
      const hostId = str(c['hostId'], `${p}.hostId`, 36)!
      if (!UUID_RE.test(hostId)) fail(`${p}.hostId must be a host id`)
      return { type: 'ssh', hostId, command }
    }
    case 'imap':
      return {
        type: 'imap',
        host: str(c['host'], `${p}.host`, 253)!,
        port: int(c['port'], `${p}.port`, 1, 65535),
        username: str(c['username'], `${p}.username`, 254)!,
        credentialKey: str(c['credentialKey'], `${p}.credentialKey`, 128)!,
        mailbox: str(c['mailbox'], `${p}.mailbox`, 200, { optional: true }),
        search: str(c['search'], `${p}.search`, 20, { optional: true }),
        tls: c['tls'] === undefined ? undefined : c['tls'] === true,
      }
    case 'factory': {
      const operation = (c['operation'] ?? 'orchestrate') as 'orchestrate' | 'prd' | 'task' | 'from-step'
      if (!['orchestrate', 'prd', 'task', 'from-step'].includes(operation)) fail(`${p}.operation must be orchestrate, prd, task or from-step`)
      const id = (k: string, allowItemPlaceholder?: string) => {
        const v = str(c[k], `${p}.${k}`, 64)!
        if (allowItemPlaceholder && v === allowItemPlaceholder) return v
        if (!/^[A-Za-z0-9_-]+$/.test(v)) fail(`${p}.${k} is not a valid id`)
        return v
      }
      if (operation === 'prd') {
        if (c['repoUrl'] !== undefined) fail(`${p}.repoUrl is only valid for orchestrate, task or from-step`)
        if (c['maxRetries'] !== undefined) fail(`${p}.maxRetries is only valid for operation "task"`)
        if (c['operationFrom'] !== undefined) fail(`${p}.operationFrom is only valid for operation "from-step"`)
        return { type: 'factory', operation, prdId: id('prdId') }
      }

      const runtime = c['runtime']
      if (runtime !== undefined && runtime !== 'claude-code' && runtime !== 'omnimancer') fail(`${p}.runtime must be claude-code or omnimancer`)

      const createPr = c['createPr'] === undefined ? undefined : c['createPr'] === true
      if (createPr && (operation === 'task' || operation === 'from-step')) fail(`Routini opens the pull request for this step's work`)

      let repoUrl: string | undefined
      if (c['repoUrl'] !== undefined) {
        repoUrl = str(c['repoUrl'], `${p}.repoUrl`, 500)!
        if (repoUrl !== ITEM_REPO_PLACEHOLDER) {
          const check = validateRepoUrl(repoUrl)
          if (!check.valid) fail(`${p}.repoUrl: ${check.error}`)
        }
      }

      let maxRetries: number | undefined
      if (c['maxRetries'] !== undefined) {
        if (operation !== 'task') fail(`${p}.maxRetries is only valid for operation "task"`)
        maxRetries = int(c['maxRetries'], `${p}.maxRetries`, 0, 5)
      }

      let operationFrom: string | undefined
      if (operation === 'from-step') {
        operationFrom = str(c['operationFrom'], `${p}.operationFrom`, 200)!
        if (!/^steps\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(operationFrom)) fail(`${p}.operationFrom must be a template path rooted at "steps." (e.g. steps.plan.out.builder)`)
      } else if (c['operationFrom'] !== undefined) {
        fail(`${p}.operationFrom is only valid for operation "from-step"`)
      }

      return {
        type: 'factory',
        operation,
        operationFrom,
        projectId: id('projectId', ITEM_PROJECT_PLACEHOLDER),
        request: str(c['request'], `${p}.request`, 20_000)!,
        runtime: runtime as 'claude-code' | 'omnimancer' | undefined,
        provider: str(c['provider'], `${p}.provider`, 40, { optional: true }),
        model: str(c['model'], `${p}.model`, 200, { optional: true }),
        createPr,
        repoUrl,
        maxRetries,
      }
    }
    case 'azure-boards': {
      const project = str(c['project'], `${p}.project`, 64)!
      // ADO forbids these characters (and a leading dot); control characters would also forge log lines.
      if (!/^[^\/\\?#%*:|"<>.\x00-\x1f\x7f][^\/\\?#%*:|"<>\x00-\x1f\x7f]*$/.test(project)) fail(`${p}.project is not a valid Azure DevOps project name`)
      return {
        type: 'azure-boards',
        project,
        query: str(c['query'], `${p}.query`, 4000, { optional: true }),
        limit: int(c['limit'], `${p}.limit`, 1, 200),
      }
    }
    case 'teams':
      return {
        type: 'teams',
        message: str(c['message'], `${p}.message`, 20_000)!,
        title: str(c['title'], `${p}.title`, 200, { optional: true }),
      }
    default:
      return fail(`${p}.type must be one of: http, ssh, imap, factory, azure-boards, teams`)
  }
}

const IF_PATH_RE = /^[A-Za-z0-9_.-]{1,200}$/
const IF_OPS = ['eq', 'ne', 'in', 'not_in', 'exists', 'missing'] as const

/**
 * `if.path` must be rooted at `steps`, `trigger` or `item`; a `steps.<id>`
 * path must name a step that runs earlier in the job (`priorIds`, in order).
 */
function parseIf(raw: unknown, p: string, stepNumber: number, priorIds: readonly string[]): IfCondition {
  if (!isObj(raw)) return fail(`${p}.if must be an object`)
  const path = str(raw['path'], `${p}.if.path`, 200)!
  if (!IF_PATH_RE.test(path)) fail(`${p}.if.path must match ^[A-Za-z0-9_.-]{1,200}$`)
  const [root, stepId] = path.split('.')
  if (root !== 'steps' && root !== 'trigger' && root !== 'item') fail(`${p}.if.path must start with "steps.", "trigger." or "item."`)
  if (root === 'steps' && (!stepId || !priorIds.includes(stepId))) {
    fail(`Step ${stepNumber} condition refers to step '${stepId ?? ''}', which does not run before it`)
  }
  const op = raw['op']
  if (!IF_OPS.includes(op as (typeof IF_OPS)[number])) fail(`${p}.if.op must be one of: ${IF_OPS.join(', ')}`)
  if (op === 'eq' || op === 'ne') return { path, op, value: str(raw['value'], `${p}.if.value`, 200)! }
  if (op === 'in' || op === 'not_in') {
    const v = raw['value']
    if (!Array.isArray(v) || v.length < 1 || v.length > 20 || !v.every((x) => typeof x === 'string' && x.length <= 200)) {
      fail(`${p}.if.value must be a list of 1 to 20 strings`)
    }
    return { path, op, value: v as string[] }
  }
  // exists / missing
  if (raw['value'] !== undefined) fail(`${p}.if.value must not be set for op "${op}"`)
  return { path, op: op as 'exists' | 'missing' }
}

const RETURN_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/
const CHOICE_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/
const MAX_RETURN_FIELDS = 20

function parseReturns(raw: unknown, p: string): ReturnField[] {
  if (!Array.isArray(raw)) return fail(`${p}.returns must be an array`)
  if (raw.length > MAX_RETURN_FIELDS) fail(`${p}.returns: at most ${MAX_RETURN_FIELDS} fields`)
  const names = new Set<string>()
  return raw.map((r, i): ReturnField => {
    const rp = `${p}.returns[${i}]`
    if (!isObj(r)) return fail(`${rp} must be an object`)
    const name = str(r['name'], `${rp}.name`, 40)!
    if (!RETURN_NAME_RE.test(name)) fail(`${rp}.name must match ^[a-z][a-zA-Z0-9_]{0,39}$`)
    if (names.has(name)) fail(`${rp}.name "${name}" is used by another return field`)
    names.add(name)
    const type = r['type']
    if (!['text', 'number', 'boolean', 'choice'].includes(type as string)) fail(`${rp}.type must be one of: text, number, boolean, choice`)
    const field: ReturnField = { name, type: type as ReturnField['type'] }
    if (type === 'choice') {
      const raw2 = r['choices']
      if (!Array.isArray(raw2) || raw2.length < 1 || raw2.length > 20) fail(`${rp}.choices must be a list of 1 to 20 choices`)
      field.choices = (raw2 as unknown[]).map((c, j) => {
        const cp = `${rp}.choices[${j}]`
        if (!isObj(c)) return fail(`${cp} must be an object`)
        const value = str(c['value'], `${cp}.value`, 60)!
        if (!CHOICE_VALUE_RE.test(value)) fail(`${cp}.value must match ^[a-z0-9][a-z0-9_-]{0,59}$`)
        const requires = str(c['requires'], `${cp}.requires`, 40, { optional: true })
        return requires ? { value, requires } : { value }
      })
    } else if (r['choices'] !== undefined) {
      fail(`${rp}.choices is only valid when type is "choice"`)
    }
    if (r['required'] !== undefined) {
      if (typeof r['required'] !== 'boolean') fail(`${rp}.required must be true or false`)
      field.required = r['required'] as boolean
    }
    if (r['description'] !== undefined) field.description = str(r['description'], `${rp}.description`, 300)
    return field
  })
}

const GROUP_RE = /^[A-Za-z0-9 ._-]{1,60}$/
const TAG_RE = /^[A-Za-z0-9._:-]{1,40}$/

/** `pool.group` and `pool.tags`, validated; at least one of them is required. */
function parsePool(raw: unknown, p: string, bad: () => never): { pool: { group?: string; tags?: string[] } } {
  if (!isObj(raw)) return bad()
  const pool: { group?: string; tags?: string[] } = {}
  if (raw['group'] !== undefined) {
    if (typeof raw['group'] !== 'string' || !GROUP_RE.test(raw['group'])) return bad()
    pool.group = raw['group']
  }
  if (raw['tags'] !== undefined) {
    const tags = raw['tags']
    if (!Array.isArray(tags) || tags.length > 20 || !tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) return bad()
    pool.tags = [...new Set(tags as string[])]
  }
  if (!pool.group && !pool.tags?.length) return bad()
  return { pool }
}

/** `runOn` names exactly one target: a fleet host id, the alert's host, or a pool of fleet hosts. */
function parseRunOn(raw: unknown, p: string): NonNullable<AgentConfig['runOn']> {
  const bad = (): never => fail(`${p}.runOn must be { hostId }, { host: 'alert' } or { pool: { group?, tags? } }`)
  if (!isObj(raw)) return bad()
  const keys = (['hostId', 'host', 'pool'] as const).filter((k) => raw[k] !== undefined)
  if (keys.length !== 1) return bad()
  if (raw['hostId'] !== undefined) {
    const hostId = raw['hostId']
    return typeof hostId === 'string' && UUID_RE.test(hostId) ? { hostId } : bad()
  }
  if (raw['host'] !== undefined) return raw['host'] === 'alert' ? { host: 'alert' } : bad()
  return parsePool(raw['pool'], p, bad)
}

/**
 * `startFrom.step` must name an earlier `action` step of type `factory`
 * (`priorSteps`, in order); the agent config needs `repo` for it, and not
 * `environmentId` or a read-only `repo`.
 */
function parseStartFrom(raw: unknown, p: string, cfg: AgentConfig, priorSteps: readonly Step[]): AgentConfig['startFrom'] {
  if (!isObj(raw)) return fail(`${p}.startFrom must be an object`)
  const stepId = str((raw as Record<string, unknown>)['step'], `${p}.startFrom.step`, 40)!
  const source = priorSteps.find((s) => s.id === stepId)
  if (!source) return fail(`${p}.startFrom.step "${stepId}" does not name a step that runs before it`)
  if (source.kind !== 'action' || source.config.type !== 'factory') return fail(`${p}.startFrom.step "${stepId}" must be an earlier Factory action step`)
  if (cfg.environmentId) return fail(`${p}.startFrom needs ${p}.repo, not ${p}.environmentId`)
  if (!cfg.repo) return fail(`${p}.startFrom needs ${p}.repo.url`)
  if (cfg.repo.readOnly) return fail(`A read-only step can't start from Factory's result`)
  return { step: stepId }
}

function parseAgent(c: Record<string, unknown>, p: string, priorSteps: readonly Step[]): AgentConfig {
  if (!AGENT_IDS.includes(c['agent'] as AgentId)) fail(`${p}.agent must be one of: ${AGENT_IDS.join(', ')}`)
  const cfg: AgentConfig = { agent: c['agent'] as AgentId, prompt: str(c['prompt'], `${p}.prompt`, 50_000)! }
  if (c['repo'] !== undefined) {
    if (!isObj(c['repo'])) fail(`${p}.repo must be an object`)
    const r = c['repo'] as Record<string, unknown>
    if (r['readOnly'] !== undefined && typeof r['readOnly'] !== 'boolean') fail(`${p}.repo.readOnly must be true or false`)
    const readOnly = r['readOnly'] === true ? { readOnly: true as const } : {}
    if (r['fromItem'] === true) {
      cfg.repo = { fromItem: true, ...readOnly }
    } else {
      const branch = str(r['baseBranch'] ?? 'main', `${p}.repo.baseBranch`, 200)!
      if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes('..')) fail(`${p}.repo.baseBranch is not a valid branch name`)
      const url = str(r['url'], `${p}.repo.url`, 500)!
      const check = validateRepoUrl(url)
      if (!check.valid) fail(`${p}.repo.url: ${check.error}`)
      cfg.repo = { url, baseBranch: branch, ...readOnly }
    }
  }
  if (c['environmentId'] !== undefined) {
    const envId = str(c['environmentId'], `${p}.environmentId`, 36)!
    if (!UUID_RE.test(envId)) fail(`${p}.environmentId must be an environment id`)
    if (cfg.repo) fail(`${p}: use either environmentId (its repository) or repo, not both`)
    cfg.environmentId = envId
  }
  if (c['runOn'] !== undefined) {
    const runOn = parseRunOn(c['runOn'], p)
    if (cfg.environmentId) fail(`${p}: run on a fleet host or in an environment, not both`)
    cfg.runOn = runOn
  }
  if (c['output'] !== undefined) {
    if (!['pr', 'branch', 'none'].includes(c['output'] as string)) fail(`${p}.output must be one of: pr, branch, none`)
    if (c['output'] !== 'none' && !cfg.repo && !cfg.environmentId) fail(`${p}.output "${String(c['output'])}" needs ${p}.repo or ${p}.environmentId`)
    if (c['output'] !== 'none' && cfg.repo?.readOnly) fail(`A read-only repository can't produce a pull request or branch`)
    cfg.output = c['output'] as AgentConfig['output']
  } else if (cfg.repo) {
    cfg.output = cfg.repo.readOnly ? 'none' : 'pr'
  }
  if (c['check'] !== undefined) {
    if (!isObj(c['check'])) fail(`${p}.check must be an object`)
    cfg.check = { command: str((c['check'] as Record<string, unknown>)['command'], `${p}.check.command`, 4000)! }
  }
  if (c['model'] !== undefined) cfg.model = str(c['model'], `${p}.model`, 200)
  if (c['returns'] !== undefined) cfg.returns = parseReturns(c['returns'], p)
  if (c['routini'] !== undefined) {
    if (typeof c['routini'] !== 'boolean') fail(`${p}.routini must be true or false`)
    if (c['routini']) cfg.routini = true
  }
  if (c['resources'] !== undefined) {
    if (!isObj(c['resources'])) fail(`${p}.resources must be an object`)
    const r = c['resources'] as Record<string, unknown>
    cfg.resources = { cpus: int(r['cpus'], `${p}.resources.cpus`, 1, 8), memoryMb: int(r['memoryMb'], `${p}.resources.memoryMb`, 512, 16_384) }
  }
  if (c['startFrom'] !== undefined) cfg.startFrom = parseStartFrom(c['startFrom'], p, cfg, priorSteps)
  return cfg
}

export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail('steps must be a non-empty array')
  if (raw.length > MAX_STEPS) fail(`a job can have at most ${MAX_STEPS} steps`)
  const ids = new Set<string>()
  // Ids of steps already parsed, in order: an `if` may only reference one of these.
  const priorIds: string[] = []
  // Steps already parsed, in order: an agent's `startFrom` may only reference one of these.
  const priorSteps: Step[] = []
  const steps = raw.map((s, i): Step => {
    const p = `steps[${i}]`
    if (!isObj(s)) return fail(`${p} must be an object`)
    const id = s['id'] === undefined ? `step-${i + 1}` : str(s['id'], `${p}.id`, 40)!
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${p}.id may only contain letters, digits, "_" and "-"`)
    if (ids.has(id)) fail(`${p}.id "${id}" is used by another step`)
    ids.add(id)
    const when = (s['when'] ?? 'on_success') as When
    if (!['on_success', 'on_failure', 'always'].includes(when)) fail(`${p}.when must be one of: on_success, on_failure, always`)
    if (s['stage'] !== undefined && !STAGES.includes(s['stage'] as Stage)) fail(`${p}.stage must be one of: ${STAGES.join(', ')}`)
    const base: StepBase = {
      id,
      name: str(s['name'] ?? id, `${p}.name`, 120)!,
      when,
      timeoutSec: int(s['timeoutSec'], `${p}.timeoutSec`, 1, MAX_TIMEOUT_SEC),
      retries: int(s['retries'], `${p}.retries`, 0, MAX_RETRIES) ?? 0,
      if: s['if'] !== undefined ? parseIf(s['if'], p, i + 1, priorIds) : undefined,
      stage: s['stage'] as Stage | undefined,
    }
    if (!isObj(s['config'])) return fail(`${p}.config must be an object`)
    const c = s['config'] as Record<string, unknown>
    let step: Step
    switch (s['kind']) {
      case 'action': {
        const config = parseAction(c, `${p}.config`)
        if (config.type === 'factory' && config.operation === 'from-step') {
          const stepId = config.operationFrom!.split('.')[1]
          if (!stepId || !priorIds.includes(stepId)) {
            fail(`Step ${i + 1} operationFrom refers to step '${stepId ?? ''}', which does not run before it`)
          }
        }
        step = { ...base, kind: 'action', config }
        break
      }
      case 'agent':
        step = { ...base, kind: 'agent', config: parseAgent(c, `${p}.config`, priorSteps) }
        break
      case 'approval': {
        const minRole = (c['minRole'] ?? 'member') as ApprovalConfig['minRole']
        if (!['member', 'admin', 'owner'].includes(minRole as string)) fail(`${p}.config.minRole must be one of: member, admin, owner`)
        if (base.retries) fail(`${p}: approval steps cannot be retried`)
        step = { ...base, kind: 'approval', config: { message: str(c['message'], `${p}.config.message`, 2000)!, minRole } }
        break
      }
      default:
        return fail(`${p}.kind must be one of: action, agent, approval`)
    }
    priorIds.push(id)
    priorSteps.push(step)
    return step
  })
  return steps
}

/** Validates a full job body (create, or update with `partial` merging over `current`). */
export function parseJobSpec(raw: unknown, current?: JobSpec): JobSpec {
  if (!isObj(raw)) return fail('Body must be an object')
  const b = raw
  const name = b['name'] !== undefined ? str(b['name'], 'name', 120)!.trim() : current?.name ?? fail('name is required')
  const description =
    b['description'] !== undefined ? str(b['description'], 'description', 4000, { allowEmpty: true })! : current?.description ?? ''
  const trigger = b['trigger'] !== undefined ? parseTrigger(b['trigger']) : current?.trigger ?? { kind: 'manual' as const }
  const steps = b['steps'] !== undefined ? parseSteps(b['steps']) : current?.steps ?? fail('steps is required')
  let enabled = current?.enabled ?? true
  if (b['enabled'] !== undefined) {
    if (typeof b['enabled'] !== 'boolean') fail('enabled must be a boolean')
    enabled = b['enabled'] as boolean
  }
  return { name, description, trigger, steps, enabled }
}
