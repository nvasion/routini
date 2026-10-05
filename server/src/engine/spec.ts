// ─────────────────────────────────────────────────────────────────────────────
// Job specification: triggers and steps, and their validation.
//
// A job is a trigger plus an ordered list of steps. Each step is one of:
//   action    – a deterministic operation (http / ssh / imap)
//   agent     – a coding agent in a container (executor arrives in M3)
//   approval  – pause the run until a person approves or denies
// `when` decides whether a step runs, relative to the outcome of the last step
// that actually ran: on_success (default), on_failure, or always.
// ─────────────────────────────────────────────────────────────────────────────

import { CronExpressionParser } from 'cron-parser'
import { AGENT_IDS, type AgentId } from '../integrations/catalog.js'
import type { Role } from '../repos/identity.js'
import { validateRepoUrl } from '../utils/repoUrl.js'

export type Trigger =
  | { kind: 'manual' }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook' }
  | { kind: 'alert'; match: AlertMatch }

/** Which alerts start an alert-triggered job. Every given condition must hold. */
export interface AlertMatch {
  /** Alert names (exact, or a prefix ending in "*"). */
  alertnames?: string[]
  severities?: string[]
  /** Label values (exact, or a prefix ending in "*"). */
  labels?: Record<string, string>
}

export type When = 'on_success' | 'on_failure' | 'always'

export type ActionConfig =
  | { type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string; expectStatus?: number; timeoutMs?: number }
  /** A command on a host, over SSH or routini-runner. `host: 'alert'` targets the incident's host. */
  | { type: 'ssh'; hostId?: string; host?: 'alert'; command: string; /** Set by templating at run time, never by job authors. */ env?: Record<string, string> }
  | { type: 'imap'; host: string; port?: number; username: string; credentialKey: string; mailbox?: string; search?: string; tls?: boolean }
  | {
      type: 'factory'
      operation: 'orchestrate' | 'prd'
      projectId?: string
      prdId?: string
      request?: string
      runtime?: 'claude-code' | 'omnimancer'
      provider?: string
      model?: string
      createPr?: boolean
    }

export interface AgentConfig {
  agent: AgentId
  prompt: string
  repo?: { url: string; baseBranch: string }
  output?: 'pr' | 'branch' | 'none'
  check?: { command: string }
  model?: string
  /** Run inside this persistent environment (and its repository) instead of a fresh container. */
  environmentId?: string
  resources?: { cpus?: number; memoryMb?: number }
}

export interface ApprovalConfig {
  message: string
  minRole?: Exclude<Role, 'viewer'>
}

interface StepBase {
  id: string
  name: string
  when: When
  timeoutSec?: number
  retries: number
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
      return { kind: 'cron', expr, tz }
    }
    default:
      return fail('trigger.kind must be one of: manual, cron, webhook, alert')
  }
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
      const operation = (c['operation'] ?? 'orchestrate') as 'orchestrate' | 'prd'
      if (operation !== 'orchestrate' && operation !== 'prd') fail(`${p}.operation must be orchestrate or prd`)
      const id = (k: string) => {
        const v = str(c[k], `${p}.${k}`, 64)!
        if (!/^[A-Za-z0-9_-]+$/.test(v)) fail(`${p}.${k} is not a valid id`)
        return v
      }
      const runtime = c['runtime']
      if (runtime !== undefined && runtime !== 'claude-code' && runtime !== 'omnimancer') fail(`${p}.runtime must be claude-code or omnimancer`)
      if (operation === 'orchestrate') {
        return {
          type: 'factory',
          operation,
          projectId: id('projectId'),
          request: str(c['request'], `${p}.request`, 20_000)!,
          runtime: runtime as 'claude-code' | 'omnimancer' | undefined,
          provider: str(c['provider'], `${p}.provider`, 40, { optional: true }),
          model: str(c['model'], `${p}.model`, 200, { optional: true }),
          createPr: c['createPr'] === undefined ? undefined : c['createPr'] === true,
        }
      }
      return { type: 'factory', operation, prdId: id('prdId') }
    }
    default:
      return fail(`${p}.type must be one of: http, ssh, imap, factory`)
  }
}

function parseAgent(c: Record<string, unknown>, p: string): AgentConfig {
  if (!AGENT_IDS.includes(c['agent'] as AgentId)) fail(`${p}.agent must be one of: ${AGENT_IDS.join(', ')}`)
  const cfg: AgentConfig = { agent: c['agent'] as AgentId, prompt: str(c['prompt'], `${p}.prompt`, 50_000)! }
  if (c['repo'] !== undefined) {
    if (!isObj(c['repo'])) fail(`${p}.repo must be an object`)
    const r = c['repo'] as Record<string, unknown>
    const branch = str(r['baseBranch'] ?? 'main', `${p}.repo.baseBranch`, 200)!
    if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes('..')) fail(`${p}.repo.baseBranch is not a valid branch name`)
    const url = str(r['url'], `${p}.repo.url`, 500)!
    const check = validateRepoUrl(url)
    if (!check.valid) fail(`${p}.repo.url: ${check.error}`)
    cfg.repo = { url, baseBranch: branch }
  }
  if (c['environmentId'] !== undefined) {
    const envId = str(c['environmentId'], `${p}.environmentId`, 36)!
    if (!UUID_RE.test(envId)) fail(`${p}.environmentId must be an environment id`)
    if (cfg.repo) fail(`${p}: use either environmentId (its repository) or repo, not both`)
    cfg.environmentId = envId
  }
  if (c['output'] !== undefined) {
    if (!['pr', 'branch', 'none'].includes(c['output'] as string)) fail(`${p}.output must be one of: pr, branch, none`)
    if (c['output'] !== 'none' && !cfg.repo && !cfg.environmentId) fail(`${p}.output "${String(c['output'])}" needs ${p}.repo or ${p}.environmentId`)
    cfg.output = c['output'] as AgentConfig['output']
  } else if (cfg.repo) {
    cfg.output = 'pr'
  }
  if (c['check'] !== undefined) {
    if (!isObj(c['check'])) fail(`${p}.check must be an object`)
    cfg.check = { command: str((c['check'] as Record<string, unknown>)['command'], `${p}.check.command`, 4000)! }
  }
  if (c['model'] !== undefined) cfg.model = str(c['model'], `${p}.model`, 200)
  if (c['resources'] !== undefined) {
    if (!isObj(c['resources'])) fail(`${p}.resources must be an object`)
    const r = c['resources'] as Record<string, unknown>
    cfg.resources = { cpus: int(r['cpus'], `${p}.resources.cpus`, 1, 8), memoryMb: int(r['memoryMb'], `${p}.resources.memoryMb`, 512, 16_384) }
  }
  return cfg
}

export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail('steps must be a non-empty array')
  if (raw.length > MAX_STEPS) fail(`a job can have at most ${MAX_STEPS} steps`)
  const ids = new Set<string>()
  return raw.map((s, i): Step => {
    const p = `steps[${i}]`
    if (!isObj(s)) return fail(`${p} must be an object`)
    const id = s['id'] === undefined ? `step-${i + 1}` : str(s['id'], `${p}.id`, 40)!
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${p}.id may only contain letters, digits, "_" and "-"`)
    if (ids.has(id)) fail(`${p}.id "${id}" is used by another step`)
    ids.add(id)
    const when = (s['when'] ?? 'on_success') as When
    if (!['on_success', 'on_failure', 'always'].includes(when)) fail(`${p}.when must be one of: on_success, on_failure, always`)
    const base: StepBase = {
      id,
      name: str(s['name'] ?? id, `${p}.name`, 120)!,
      when,
      timeoutSec: int(s['timeoutSec'], `${p}.timeoutSec`, 1, MAX_TIMEOUT_SEC),
      retries: int(s['retries'], `${p}.retries`, 0, MAX_RETRIES) ?? 0,
    }
    if (!isObj(s['config'])) return fail(`${p}.config must be an object`)
    const c = s['config'] as Record<string, unknown>
    switch (s['kind']) {
      case 'action':
        return { ...base, kind: 'action', config: parseAction(c, `${p}.config`) }
      case 'agent':
        return { ...base, kind: 'agent', config: parseAgent(c, `${p}.config`) }
      case 'approval': {
        const minRole = (c['minRole'] ?? 'member') as ApprovalConfig['minRole']
        if (!['member', 'admin', 'owner'].includes(minRole as string)) fail(`${p}.config.minRole must be one of: member, admin, owner`)
        if (base.retries) fail(`${p}: approval steps cannot be retried`)
        return { ...base, kind: 'approval', config: { message: str(c['message'], `${p}.config.message`, 2000)!, minRole } }
      }
      default:
        return fail(`${p}.kind must be one of: action, agent, approval`)
    }
  })
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
