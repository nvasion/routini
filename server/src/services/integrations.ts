// ─────────────────────────────────────────────────────────────────────────────
// Integrations catalog + status service
//
// Defines the v1 integration catalog (GitHub, Slack, Jira, Notion, Linear,
// monday.com, HubSpot) and computes the client-safe "summary" for each one —
// its status, when it was connected, its last connection-test result, and
// its scoping — for the GET /api/integrations endpoint.
//
// Storage model (per the Routini Integrations PRD):
//   – Secrets live in the existing encrypted credential store
//     (server/src/services/credentials.ts) under the "system" scope, keyed
//     as `integration_<id>_<field>` (e.g. `integration_github_token`).
//   – Non-secret metadata (last test result/time, scoping) lives in the
//     `integration_metadata` SQLite table (server/src/db/index.ts). A missing
//     row means "never tested, default scopes" — not an error.
//
// Security properties:
//   – This module never decrypts or returns credential material. Presence of
//     a required field is checked via the DB layer's `getCredential`, which
//     returns row metadata (including ciphertext) without decrypting it —
//     the plaintext secret is never touched for a status computation.
//   – `connectedAt` is derived from the credential rows' own `created_at`
//     (the earliest among an integration's required fields) rather than a
//     second, independently-updated timestamp, so there is a single source
//     of truth and no risk of the two drifting apart.
//   – Stored scope JSON is parsed defensively: malformed or unknown values
//     fall back to the catalog default rather than throwing, so a corrupt
//     row can never break the catalog listing.
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskType } from '../types.js'
import { getCredential, getIntegrationMetadata } from '../db/index.js'

// ── Types ────────────────────────────────────────────────────────────────────

/** AI coding agents that can be scoped to use an integration. Mirrors devTask.ts VALID_AGENTS. */
export type IntegrationAgentId = 'claude' | 'opencode' | 'omnimancer'

export type IntegrationFieldType = 'text' | 'password' | 'url' | 'email'

/** A single credential field an integration needs (e.g. a token or site URL). */
export interface IntegrationFieldSpec {
  /** Field name, used to build the credential-store key `integration_<id>_<key>`. */
  key: string
  /** Human-readable label shown in the connect modal. */
  label: string
  type: IntegrationFieldType
  required: boolean
  placeholder?: string
}

/** Which task types and agents may use a connected integration. */
export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: IntegrationAgentId[]
}

/** Static catalog entry for one integration — never contains secrets. */
export interface IntegrationDefinition {
  id: string
  name: string
  description: string
  /** Link to the provider's page for generating the credential. */
  setupUrl: string
  fields: IntegrationFieldSpec[]
  defaultScopes: IntegrationScopes
}

export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

/** Client-safe view of an integration: catalog fields plus live status. Never contains secrets. */
export interface IntegrationSummary {
  id: string
  name: string
  description: string
  setupUrl: string
  fields: IntegrationFieldSpec[]
  status: IntegrationStatus
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}

// ── Constants ────────────────────────────────────────────────────────────────

export const ALL_TASK_TYPES: readonly TaskType[] = ['daily', 'developmental', 'routine']
export const ALL_AGENT_IDS: readonly IntegrationAgentId[] = ['claude', 'opencode', 'omnimancer']

/** Prefix for the credential-store keys backing integration secrets (system scope). */
const CREDENTIAL_KEY_PREFIX = 'integration'

/** Returns a fresh (never shared/mutated) "all task types, all agents" scope object. */
function defaultScopes(): IntegrationScopes {
  return { taskTypes: [...ALL_TASK_TYPES], agents: [...ALL_AGENT_IDS] }
}

/**
 * Build the credential-store key for one integration field, e.g.
 * `integration_github_token`. Shared by every route (GET/PUT/POST/DELETE) so
 * the naming scheme lives in exactly one place.
 */
export function credentialFieldKey(integrationId: string, fieldKey: string): string {
  return `${CREDENTIAL_KEY_PREFIX}_${integrationId}_${fieldKey}`
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export const INTEGRATIONS_CATALOG: readonly IntegrationDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Let tasks and coding agents read and write repositories, issues, and pull requests.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    fields: [
      {
        key: 'token',
        label: 'Fine-grained personal access token',
        type: 'password',
        required: true,
        placeholder: 'github_pat_…',
      },
    ],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Let tasks and agents post updates and read channel activity.',
    setupUrl: 'https://api.slack.com/apps',
    fields: [
      { key: 'token', label: 'Bot token', type: 'password', required: true, placeholder: 'xoxb-…' },
    ],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Let tasks and agents read and update Jira issues.',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: [
      {
        key: 'siteUrl',
        label: 'Site URL',
        type: 'url',
        required: true,
        placeholder: 'https://your-domain.atlassian.net',
      },
      { key: 'email', label: 'Account email', type: 'email', required: true },
      { key: 'token', label: 'API token', type: 'password', required: true },
    ],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Let tasks and agents read and update Notion pages and databases.',
    setupUrl: 'https://www.notion.so/my-integrations',
    fields: [
      {
        key: 'token',
        label: 'Internal integration token',
        type: 'password',
        required: true,
        placeholder: 'secret_…',
      },
    ],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Let tasks and agents read and update Linear issues.',
    setupUrl: 'https://linear.app/settings/api',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        placeholder: 'lin_api_…',
      },
    ],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Let tasks and agents read and update monday.com boards and items.',
    setupUrl: 'https://monday.com/developers/apps',
    fields: [{ key: 'token', label: 'API token', type: 'password', required: true }],
    defaultScopes: defaultScopes(),
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Let tasks and agents read and update HubSpot CRM records.',
    setupUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    fields: [
      {
        key: 'token',
        label: 'Private app access token',
        type: 'password',
        required: true,
        placeholder: 'pat-…',
      },
    ],
    defaultScopes: defaultScopes(),
  },
]

/** Look up a single catalog definition by id, or undefined when unknown. */
export function getIntegrationDefinition(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS_CATALOG.find((def) => def.id === id)
}

// ── Status derivation ────────────────────────────────────────────────────────

/**
 * Determine whether every required field for an integration has a stored
 * credential, and (when so) the earliest `created_at` among them — used as
 * `connectedAt`. Only touches credential-row *metadata* (via the DB layer's
 * `getCredential`); the encrypted secret is never decrypted here.
 */
function computeConnection(def: IntegrationDefinition): { connected: boolean; connectedAt: string | null } {
  const requiredFields = def.fields.filter((f) => f.required)
  if (requiredFields.length === 0) {
    return { connected: false, connectedAt: null }
  }

  const rows = requiredFields.map((f) => getCredential(null, credentialFieldKey(def.id, f.key)))
  if (rows.some((row) => row === undefined)) {
    return { connected: false, connectedAt: null }
  }

  const createdTimestamps = rows.map((row) => row!.created_at)
  const connectedAt = createdTimestamps.reduce((earliest, ts) => (ts < earliest ? ts : earliest))
  return { connected: true, connectedAt }
}

/** Type guard: is `value` one of the known TaskType strings? */
function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (ALL_TASK_TYPES as readonly string[]).includes(value)
}

/** Type guard: is `value` one of the known IntegrationAgentId strings? */
function isAgentId(value: unknown): value is IntegrationAgentId {
  return typeof value === 'string' && (ALL_AGENT_IDS as readonly string[]).includes(value)
}

/**
 * Parse a JSON-encoded array of scope values, keeping only recognised
 * entries. Returns null (never throws) when the stored value is missing,
 * malformed, or ends up empty after filtering, so callers can fall back to
 * the catalog default rather than surfacing corrupt data or crashing GET.
 */
function parseScopeArray<T>(raw: string | null, guard: (value: unknown) => value is T): T[] | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const filtered = parsed.filter(guard)
  return filtered.length > 0 ? filtered : null
}

/** Resolve the effective scopes for an integration: stored metadata, or the catalog default. */
function resolveScopes(
  def: IntegrationDefinition,
  metadata: ReturnType<typeof getIntegrationMetadata>,
): IntegrationScopes {
  if (!metadata) return { ...defaultScopes() }

  const taskTypes = parseScopeArray(metadata.scope_task_types, isTaskType) ?? def.defaultScopes.taskTypes
  const agents = parseScopeArray(metadata.scope_agents, isAgentId) ?? def.defaultScopes.agents
  return { taskTypes, agents }
}

/**
 * Build the client-safe summary for one integration: catalog fields plus
 * live status/connectedAt/lastTest/scopes. Never includes credential
 * material — only presence/timestamps derived from row metadata.
 */
export function getIntegrationSummary(id: string): IntegrationSummary | undefined {
  const def = getIntegrationDefinition(id)
  if (!def) return undefined

  const { connected, connectedAt } = computeConnection(def)
  const metadata = getIntegrationMetadata(def.id)

  const lastTestAt = metadata?.last_test_at ?? null
  const lastTestOk =
    metadata?.last_test_ok === null || metadata?.last_test_ok === undefined
      ? null
      : metadata.last_test_ok === 1

  // A connected integration whose most recent test failed is surfaced as
  // "error" so the UI can flag it distinctly from "never tested yet".
  const status: IntegrationStatus = !connected ? 'not_connected' : lastTestOk === false ? 'error' : 'connected'

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    setupUrl: def.setupUrl,
    fields: def.fields,
    status,
    connectedAt,
    lastTestAt,
    lastTestOk,
    scopes: resolveScopes(def, metadata),
  }
}

/** Build client-safe summaries for every integration in the catalog. */
export function getIntegrationSummaries(): IntegrationSummary[] {
  return INTEGRATIONS_CATALOG.map((def) => getIntegrationSummary(def.id)!)
}
