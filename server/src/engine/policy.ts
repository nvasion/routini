// ─────────────────────────────────────────────────────────────────────────────
// Org policy: ordered rules that decide whether a step may run as-is, needs a
// person's approval first, or is refused. First matching rule wins; no match
// means allow. Evaluated by the engine right before each step runs, against
// facts about the step (its kind, action, target host, agent output…).
// Pure functions; persistence is in repos/policy.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Role } from '../repos/identity.js'
import type { Step } from './spec.js'
import type { Queryable } from '../db/index.js'
import { getHost } from '../repos/hosts.js'
import { getEnvironment } from '../repos/environments.js'

export type PolicyEffect = 'allow' | 'require_approval' | 'deny'
export type ActionType = 'http' | 'ssh' | 'imap' | 'factory' | 'azure-boards' | 'teams'

export interface PolicyMatch {
  kinds?: Array<'action' | 'agent'>
  actionTypes?: ActionType[]
  /** SSH steps, and agent steps that run on a fleet host: the target host has any of these tags. */
  hostTags?: string[]
  /** SSH steps, and agent steps that run on a fleet host: the target host is in any of these groups. */
  hostGroups?: string[]
  /** Agent steps: the result mode. */
  agentOutputs?: Array<'pr' | 'branch' | 'none'>
  /** Agent steps: where the agent runs — Routini's sandbox or a fleet host. */
  agentPlacements?: Array<'sandbox' | 'fleet'>
  /** Agent steps: running inside a persistent environment (true) or a fresh container (false). */
  inEnvironment?: boolean
  /** Agent steps: repository hostname is one of these. */
  repoHosts?: string[]
}

export interface PolicyRule {
  id: string
  name: string
  match: PolicyMatch
  effect: PolicyEffect
  /** For require_approval: who may approve. Default member. */
  minRole?: Exclude<Role, 'viewer'>
  /** For deny: shown to the job author. */
  reason?: string
}

/** What the engine knows about a step when policy is evaluated. */
export interface StepFacts {
  kind: Step['kind']
  actionType?: ActionType
  host?: { tags: string[]; group: string }
  agentOutput?: 'pr' | 'branch' | 'none'
  /** Agent steps: 'fleet' when the step runs on a fleet host, 'sandbox' otherwise. */
  agentPlacement?: 'sandbox' | 'fleet'
  inEnvironment?: boolean
  repoHost?: string
}

export interface Decision {
  effect: PolicyEffect
  rule: PolicyRule | null
}

const anyOf = <T>(want: T[] | undefined, have: T | undefined): boolean => !want || want.length === 0 || (have !== undefined && want.includes(have))

export function ruleMatches(rule: PolicyRule, f: StepFacts): boolean {
  const m = rule.match
  if (f.kind === 'approval') return false // approvals are themselves the gate
  if (m.kinds?.length && !m.kinds.includes(f.kind as 'action' | 'agent')) return false
  if (!anyOf(m.actionTypes, f.actionType)) return false
  if (m.hostTags?.length && !(f.host && f.host.tags.some((t) => m.hostTags!.includes(t)))) return false
  if (m.hostGroups?.length && !(f.host && m.hostGroups.includes(f.host.group))) return false
  if (!anyOf(m.agentOutputs, f.agentOutput)) return false
  if (!anyOf(m.agentPlacements, f.agentPlacement)) return false
  if (m.inEnvironment !== undefined && m.inEnvironment !== Boolean(f.inEnvironment)) return false
  if (!anyOf(m.repoHosts, f.repoHost)) return false
  return true
}

export function evaluatePolicy(rules: PolicyRule[], f: StepFacts): Decision {
  for (const rule of rules) if (ruleMatches(rule, f)) return { effect: rule.effect, rule }
  return { effect: 'allow', rule: null }
}

/** Starting policy for new orgs. Hosted orgs get a conservative default for production hosts. */
export function defaultRules(mode: 'selfhost' | 'hosted'): PolicyRule[] {
  if (mode === 'selfhost') return []
  return [
    {
      id: 'prod-ssh',
      name: 'Commands on production hosts need approval',
      match: { kinds: ['action'], actionTypes: ['ssh'], hostTags: ['prod'] },
      effect: 'require_approval',
      minRole: 'admin',
    },
  ]
}

export class PolicyError extends Error {}

/** Validates a rules payload; throws PolicyError with a path-specific message. */
export function parseRules(raw: unknown): PolicyRule[] {
  const fail = (m: string): never => {
    throw new PolicyError(m)
  }
  if (!Array.isArray(raw)) return fail('rules must be an array')
  if (raw.length > 100) fail('at most 100 rules')
  const ids = new Set<string>()
  const strList = (v: unknown, path: string, allowed?: readonly string[]): string[] | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100)) fail(`${path} must be a list of strings`)
    if (allowed && !(v as string[]).every((x) => allowed.includes(x))) fail(`${path} values must be among: ${allowed.join(', ')}`)
    return [...new Set(v as string[])]
  }
  return raw.map((r, i): PolicyRule => {
    const p = `rules[${i}]`
    if (!r || typeof r !== 'object' || Array.isArray(r)) return fail(`${p} must be an object`)
    const o = r as Record<string, unknown>
    const id = typeof o['id'] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(o['id']) ? o['id'] : fail(`${p}.id must be 1–40 letters, digits, "_" or "-"`)
    if (ids.has(id)) fail(`${p}.id "${id}" is used twice`)
    ids.add(id)
    const name = typeof o['name'] === 'string' && o['name'].trim() && o['name'].length <= 120 ? o['name'].trim() : fail(`${p}.name is required (≤120 chars)`)
    const effect = ['allow', 'require_approval', 'deny'].includes(o['effect'] as string) ? (o['effect'] as PolicyEffect) : fail(`${p}.effect must be allow, require_approval or deny`)
    const m = (o['match'] ?? {}) as Record<string, unknown>
    if (typeof m !== 'object' || Array.isArray(m)) fail(`${p}.match must be an object`)
    const match: PolicyMatch = {
      kinds: strList(m['kinds'], `${p}.match.kinds`, ['action', 'agent']) as PolicyMatch['kinds'],
      actionTypes: strList(m['actionTypes'], `${p}.match.actionTypes`, ['http', 'ssh', 'imap', 'factory', 'azure-boards', 'teams']) as PolicyMatch['actionTypes'],
      hostTags: strList(m['hostTags'], `${p}.match.hostTags`),
      hostGroups: strList(m['hostGroups'], `${p}.match.hostGroups`),
      agentOutputs: strList(m['agentOutputs'], `${p}.match.agentOutputs`, ['pr', 'branch', 'none']) as PolicyMatch['agentOutputs'],
      agentPlacements: strList(m['agentPlacements'], `${p}.match.agentPlacements`, ['sandbox', 'fleet']) as PolicyMatch['agentPlacements'],
      repoHosts: strList(m['repoHosts'], `${p}.match.repoHosts`),
    }
    if (m['inEnvironment'] !== undefined) {
      if (typeof m['inEnvironment'] !== 'boolean') fail(`${p}.match.inEnvironment must be true or false`)
      match.inEnvironment = m['inEnvironment'] as boolean
    }
    for (const k of Object.keys(match) as Array<keyof PolicyMatch>) if (match[k] === undefined) delete match[k]
    const rule: PolicyRule = { id, name, match, effect }
    if (effect === 'require_approval') {
      const minRole = (o['minRole'] ?? 'member') as PolicyRule['minRole']
      if (!['member', 'admin', 'owner'].includes(minRole as string)) fail(`${p}.minRole must be member, admin or owner`)
      rule.minRole = minRole
    }
    if (effect === 'deny') {
      rule.reason = typeof o['reason'] === 'string' && o['reason'].trim() ? o['reason'].trim().slice(0, 500) : 'Blocked by org policy'
    }
    return rule
  })
}

/** The target host's tags and group, when the step names a host that still exists. */
async function hostFacts(q: Queryable, orgId: string, hostId: string): Promise<StepFacts['host']> {
  const host = await getHost(q, orgId, hostId)
  return host ? { tags: host.tags, group: host.group } : undefined
}

/** Gathers what policy needs to know about a step (its target host, repository, output, placement). */
export async function stepFacts(q: Queryable, orgId: string, step: Step): Promise<StepFacts> {
  if (step.kind === 'approval') return { kind: 'approval' }
  if (step.kind === 'action') {
    const facts: StepFacts = { kind: 'action', actionType: step.config.type as ActionType }
    if (step.config.type === 'ssh' && step.config.hostId) facts.host = await hostFacts(q, orgId, step.config.hostId)
    return facts
  }
  const cfg = step.config
  const env = cfg.environmentId ? await getEnvironment(q, orgId, cfg.environmentId) : null
  const repoUrl = cfg.repo?.url ?? env?.repo?.url
  let repoHost: string | undefined
  try {
    repoHost = repoUrl ? new URL(repoUrl).hostname : undefined
  } catch {
    repoHost = undefined
  }
  const facts: StepFacts = {
    kind: 'agent',
    agentOutput: repoUrl ? (cfg.output ?? 'pr') : 'none',
    // A step runs on a fleet host directly (runOn), or indirectly through an environment
    // pinned to one (env.hostId) — either way it is the org's own server time, not the sandbox's.
    agentPlacement: cfg.runOn || env?.hostId ? 'fleet' : 'sandbox',
    inEnvironment: Boolean(cfg.environmentId),
    repoHost,
  }
  // After prepare, runOn is always { hostId }; a draft may still carry { host: 'alert' }, whose host is unknown here,
  // or { pool }, whose group/tags stand in for a host until prepare picks one.
  if (cfg.runOn && 'hostId' in cfg.runOn) facts.host = await hostFacts(q, orgId, cfg.runOn.hostId)
  else if (cfg.runOn && 'pool' in cfg.runOn) facts.host = { tags: cfg.runOn.pool.tags ?? [], group: cfg.runOn.pool.group ?? '' }
  else if (env?.hostId) facts.host = await hostFacts(q, orgId, env.hostId)
  return facts
}
