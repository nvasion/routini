/**
 * Integration credential scoping and container-env injection.
 *
 * Routini's v1 integrations (GitHub, Slack, Jira, Notion, Linear,
 * monday.com, HubSpot, Factory Nexus) are single-token, credentials-first
 * connections: a
 * user stores a token via the encrypted credential store and Routini
 * injects it into agent container spawns as an environment variable so the
 * task's coding agent (or scripted action) can call the provider's API.
 *
 * Security model (server-enforced, not just hidden in the UI):
 *   – Secrets live only in the encrypted credential store
 *     (server/src/services/credentials.ts) under the system scope
 *     (userId = null), keyed as `integration_<id>_token`.  This module never
 *     persists or logs the raw token value.
 *   – Each integration has a *scope*: the set of task types and agent ids
 *     permitted to receive its token.  Scope is likewise stored via the
 *     credential store (as non-secret JSON) under `integration_<id>_scope`,
 *     which keeps a single source of truth for "system-scope, per-key"
 *     storage rather than introducing a parallel table.
 *   – `getScopedIntegrationEnv` is the single choke point every container
 *     spawn path must call.  A credential is only ever included when BOTH
 *     the integration is connected (a token is stored) AND the caller's
 *     (taskType, agentId) pair is within the integration's current scope.
 *     Out-of-scope or disconnected integrations are silently omitted from
 *     the returned env map — never included with an empty/placeholder
 *     value, which could be mistaken for "connected but empty" by a caller.
 *   – Scope data that fails to parse (corruption or tampering) fails
 *     *closed*: the integration is treated as having no allowed task types
 *     or agents until explicitly reconfigured, rather than falling back to
 *     "allow all".
 */

import { getCredentialSecret, saveCredential } from './credentials.js'
import type { TaskType } from '../types.js'

// ── Catalog ──────────────────────────────────────────────────────────────────

/** The eight v1 token/API-key integrations. */
export type IntegrationId =
  | 'github'
  | 'slack'
  | 'jira'
  | 'notion'
  | 'linear'
  | 'monday'
  | 'hubspot'
  | 'factoryNexus'

/**
 * All task types and agent ids that can ever appear in scope.  Mirrors
 * `TaskType` (server/src/types.ts) and the agent ids validated by
 * `VALID_AGENTS` in server/src/services/devTask.ts.  Duplicated here (as a
 * small readonly literal list, not re-derived from devTask.ts) to avoid a
 * circular import — devTask.ts is a consumer of this module.
 */
export const ALL_TASK_TYPES: readonly TaskType[] = ['daily', 'developmental', 'routine']
export const ALL_AGENT_IDS: readonly string[] = ['claude', 'opencode', 'omnimancer']

/** Which task types and agents may receive an integration's credential. */
export interface IntegrationScope {
  taskTypes: TaskType[]
  agents: string[]
}

export interface IntegrationDefinition {
  id: IntegrationId
  /** Display name for the catalog UI. */
  name: string
  /** Env var name injected into an in-scope container spawn. */
  envVar: string
}

/** Returns a fresh "allow everything" scope object (the documented default). */
function defaultScope(): IntegrationScope {
  return { taskTypes: [...ALL_TASK_TYPES], agents: [...ALL_AGENT_IDS] }
}

/** The eight v1 integrations and the env var each one's token is injected as. */
export const INTEGRATIONS: Readonly<Record<IntegrationId, IntegrationDefinition>> = {
  github: { id: 'github', name: 'GitHub', envVar: 'GITHUB_TOKEN' },
  slack: { id: 'slack', name: 'Slack', envVar: 'SLACK_BOT_TOKEN' },
  jira: { id: 'jira', name: 'Jira', envVar: 'JIRA_API_TOKEN' },
  notion: { id: 'notion', name: 'Notion', envVar: 'NOTION_TOKEN' },
  linear: { id: 'linear', name: 'Linear', envVar: 'LINEAR_API_KEY' },
  monday: { id: 'monday', name: 'monday.com', envVar: 'MONDAY_TOKEN' },
  hubspot: { id: 'hubspot', name: 'HubSpot', envVar: 'HUBSPOT_TOKEN' },
  factoryNexus: { id: 'factoryNexus', name: 'Factory Nexus', envVar: 'FACTORY_NEXUS_API_KEY' },
}

/** Type guard for the fixed integration-id union. */
export function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTEGRATIONS, value)
}

// ── Credential store key helpers ────────────────────────────────────────────

const CREDENTIAL_FIELD_TOKEN = 'token'
const CREDENTIAL_FIELD_SCOPE = 'scope'

/** Builds the `integration_<id>_<field>` storage key used for every field. */
function integrationCredentialKey(id: IntegrationId, field: string): string {
  return `integration_${id}_${field}`
}

function tokenKey(id: IntegrationId): string {
  return integrationCredentialKey(id, CREDENTIAL_FIELD_TOKEN)
}

function scopeKey(id: IntegrationId): string {
  return integrationCredentialKey(id, CREDENTIAL_FIELD_SCOPE)
}

// ── Scope validation ─────────────────────────────────────────────────────────

/** Narrow, defensive shape check — untrusted JSON in, typed scope out. */
function parseScope(raw: string): IntegrationScope | null {
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof candidate !== 'object' || candidate === null) return null
  const { taskTypes, agents } = candidate as Record<string, unknown>
  if (!Array.isArray(taskTypes) || !Array.isArray(agents)) return null
  if (!taskTypes.every((t): t is TaskType => ALL_TASK_TYPES.includes(t as TaskType))) return null
  if (!agents.every((a) => typeof a === 'string' && ALL_AGENT_IDS.includes(a))) return null
  return { taskTypes: taskTypes as TaskType[], agents: agents as string[] }
}

/**
 * Validates a scope object before it is persisted.  Throws a descriptive
 * error for the caller (e.g. the future PUT /api/integrations/:id route) to
 * surface as a 400; never silently drops invalid entries.
 */
export function validateScope(scope: IntegrationScope): IntegrationScope {
  if (!scope || typeof scope !== 'object') {
    throw new Error('scope must be an object')
  }
  const { taskTypes, agents } = scope
  if (!Array.isArray(taskTypes) || taskTypes.length === 0) {
    throw new Error('scope.taskTypes must be a non-empty array')
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('scope.agents must be a non-empty array')
  }
  for (const t of taskTypes) {
    if (!ALL_TASK_TYPES.includes(t)) {
      throw new Error(`scope.taskTypes contains an invalid task type: "${String(t)}"`)
    }
  }
  for (const a of agents) {
    if (typeof a !== 'string' || !ALL_AGENT_IDS.includes(a)) {
      throw new Error(`scope.agents contains an invalid agent id: "${String(a)}"`)
    }
  }
  // De-duplicate defensively so repeated PUTs don't grow the stored array.
  return { taskTypes: [...new Set(taskTypes)], agents: [...new Set(agents)] }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the current scope for an integration.
 *
 *   – No scope has ever been saved  → the documented default ("all task
 *     types, all agents").
 *   – Saved scope fails to parse    → fail closed (empty scope) rather than
 *     risk granting broader access than intended.
 */
export function getIntegrationScope(id: IntegrationId): IntegrationScope {
  const raw = getCredentialSecret(null, scopeKey(id))
  if (raw === undefined) return defaultScope()

  const parsed = parseScope(raw)
  if (!parsed) {
    // Never include the raw stored value in the log — it is not secret, but
    // logging arbitrary stored content on a parse failure is bad practice.
    console.error(
      `[integrations] Stored scope for "${id}" is invalid/corrupt; denying all access until reconfigured`,
    )
    return { taskTypes: [], agents: [] }
  }
  return parsed
}

/** Persists a validated scope for an integration (system-wide, non-secret). */
export function setIntegrationScope(id: IntegrationId, scope: IntegrationScope): void {
  if (!isIntegrationId(id)) {
    throw new Error(`Unknown integration id: "${String(id)}"`)
  }
  const validated = validateScope(scope)
  saveCredential(null, scopeKey(id), JSON.stringify(validated))
}

/** Returns `true` when a token has been stored for the integration. */
export function isIntegrationConnected(id: IntegrationId): boolean {
  return getCredentialSecret(null, tokenKey(id)) !== undefined
}

/**
 * Stores the token credential for an integration.  Thin wrapper over the
 * credential store using this module's key convention; kept here so callers
 * (routes, tests) never need to know the `integration_<id>_token` shape.
 */
export function setIntegrationToken(id: IntegrationId, token: string): void {
  if (!isIntegrationId(id)) {
    throw new Error(`Unknown integration id: "${String(id)}"`)
  }
  saveCredential(null, tokenKey(id), token)
}

/**
 * Builds the environment variables to inject into a container spawn for a
 * task of the given type run by the given agent.
 *
 * This is the single enforcement point for integration scoping: a
 * credential is included if and only if it is connected (a token is
 * stored) AND the (taskType, agentId) pair is within the integration's
 * current scope. Everything else — out-of-scope integrations,
 * not-yet-connected integrations — is silently omitted from the result, so
 * callers can always spread the return value straight into the container's
 * env map without further filtering.
 *
 * Never throws on a per-integration basis: a corrupt scope for one
 * integration fails closed for that integration only (see
 * `getIntegrationScope`) and does not block the others from being injected.
 */
export function getScopedIntegrationEnv(
  taskType: TaskType,
  agentId: string,
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const integration of Object.values(INTEGRATIONS)) {
    const token = getCredentialSecret(null, tokenKey(integration.id))
    if (token === undefined) continue // not connected — nothing to inject

    const scope = getIntegrationScope(integration.id)
    if (!scope.taskTypes.includes(taskType)) continue
    if (!scope.agents.includes(agentId)) continue

    env[integration.envVar] = token
  }

  return env
}
