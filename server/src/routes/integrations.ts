// ─────────────────────────────────────────────────────────────────────────────
// Integrations API router
//
// Backs the "Integrations" tab: a catalog of external tools (GitHub, Slack,
// Jira, Notion, Linear, monday.com, HubSpot) that Routini tasks and coding
// agent containers can be granted access to. See PRD "Routini Integrations v1".
//
// This module owns:
//   – The v1 integration catalog (id, display metadata, credential field
//     specs, setup-URL) — the single source of truth other integration
//     endpoints (GET status, POST test, DELETE disconnect) should import
//     rather than re-declaring.
//   – PUT /api/integrations/:id — write-only credential + scoping persistence.
//
// Security properties:
//   – Credentials are write-only over the API: PUT accepts field values in the
//     request body and persists them through the encrypted credential store
//     (server/src/services/credentials.ts, AES-256-GCM at rest). They are
//     never echoed back in the response, logged, or otherwise serialized.
//   – Each credential field is stored under the deterministic key
//     `integration_<id>_<field>` in the "system" credential scope (userId =
//     null), per the PRD storage design — integrations are a single
//     server-wide configuration, mirroring how the AI API key is stored in
//     server/src/routes/settings.ts.
//   – Required fields are validated per-integration before anything is
//     persisted, so a bad request never results in a partially-configured
//     integration.
//   – The `siteUrl` field (Jira) is validated as an https URL that does not
//     resolve to a private/loopback hostname, guarding the provider
//     health-check endpoint (POST /:id/test, implemented separately) against
//     SSRF via a malicious site URL.
//   – Scoping (allowed task types + allowed agents) is persisted alongside
//     connection status so it can be enforced server-side at agent-container
//     spawn time — not just hidden in the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express'
import { requireAuth, requireCsrf } from './auth.js'
import { saveCredential, removeCredential } from '../services/credentials.js'
import { isSsrfSafeHostname } from '../utils/network.js'
import type { TaskType, AIProvider } from '../types.js'

export const integrationsRouter = Router()

// ── Catalog types ─────────────────────────────────────────────────────────────

/** The seven v1 integrations. Keep in sync with the PRD "Integration catalog". */
export type IntegrationId =
  | 'github'
  | 'slack'
  | 'jira'
  | 'notion'
  | 'linear'
  | 'monday'
  | 'hubspot'

/** A single credential field an integration requires (e.g. an API token). */
export interface IntegrationFieldSpec {
  /** Field name, used verbatim in the credential store key and request body. */
  key: string
  /** Human-readable label for the connect-modal form. */
  label: string
  /** Whether PUT rejects the request when this field is missing/empty. */
  required: boolean
  /** Whether the field holds a secret (password-style input) vs. plain text. */
  secret: boolean
}

/** Catalog entry describing one integration's identity, fields, and setup link. */
export interface IntegrationDefinition {
  id: IntegrationId
  name: string
  description: string
  /** Link to the provider's token/credential creation page. */
  setupUrl: string
  fields: IntegrationFieldSpec[]
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export const INTEGRATIONS: Record<IntegrationId, IntegrationDefinition> = {
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Fine-grained personal access token for repository operations.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    fields: [
      { key: 'token', label: 'Fine-grained personal access token', required: true, secret: true },
    ],
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    description: 'Bot token for posting and reading messages via a Slack app.',
    setupUrl: 'https://api.slack.com/apps',
    fields: [
      { key: 'botToken', label: 'Bot User OAuth Token', required: true, secret: true },
    ],
  },
  jira: {
    id: 'jira',
    name: 'Jira',
    description: 'API token + site URL + account email for Jira Cloud.',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: [
      { key: 'siteUrl', label: 'Site URL (e.g. https://acme.atlassian.net)', required: true, secret: false },
      { key: 'email', label: 'Account email', required: true, secret: false },
      { key: 'apiToken', label: 'API token', required: true, secret: true },
    ],
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    description: 'Internal integration token for a Notion workspace.',
    setupUrl: 'https://www.notion.so/my-integrations',
    fields: [
      { key: 'token', label: 'Internal integration token', required: true, secret: true },
    ],
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    description: 'Personal API key for reading and writing Linear issues.',
    setupUrl: 'https://linear.app/settings/api',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, secret: true },
    ],
  },
  monday: {
    id: 'monday',
    name: 'monday.com',
    description: 'API token for monday.com boards and items.',
    setupUrl: 'https://monday.com/developers/apps/manage/api',
    fields: [
      { key: 'apiToken', label: 'API token', required: true, secret: true },
    ],
  },
  hubspot: {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Private-app access token for HubSpot CRM objects.',
    setupUrl: 'https://app.hubspot.com/private-apps',
    fields: [
      { key: 'token', label: 'Private-app access token', required: true, secret: true },
    ],
  },
}

const INTEGRATION_IDS = Object.keys(INTEGRATIONS) as IntegrationId[]

/** Type guard for the fixed integration-id union. */
export function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === 'string' && (INTEGRATION_IDS as string[]).includes(value)
}

/**
 * Build the credential-store key for a given integration field, per the PRD
 * storage design: `integration_<id>_<field>`. Exported so the (separately
 * implemented) test and disconnect endpoints derive the same key rather than
 * duplicating the naming scheme.
 */
export function integrationCredentialKey(id: IntegrationId, fieldKey: string): string {
  return `integration_${id}_${fieldKey}`
}

// ── Scoping ───────────────────────────────────────────────────────────────────

const ALL_TASK_TYPES: readonly TaskType[] = ['daily', 'developmental', 'routine']
const ALL_AGENTS: readonly AIProvider[] = ['claude', 'opencode', 'omnimancer']

export interface IntegrationScopes {
  /** Task types allowed to use this integration's credentials. Default: all. */
  taskTypes: TaskType[]
  /** Coding agents allowed to use this integration's credentials. Default: all. */
  agents: AIProvider[]
}

function defaultScopes(): IntegrationScopes {
  return { taskTypes: [...ALL_TASK_TYPES], agents: [...ALL_AGENTS] }
}

// ── Metadata (non-secret) ─────────────────────────────────────────────────────
//
// Connection status/timestamps/scopes are non-secret metadata. They currently
// live in memory, mirroring the pattern used by server/src/routes/settings.ts
// (`currentSettings`) and server/src/routes/tasks.ts (`tasks`); durable sqlite
// persistence for this metadata is a follow-up implementation task per the
// PRD ("DELETE ... plus sqlite persistence for integration metadata surviving
// restart"). Secrets themselves are already durable today via the encrypted
// credential store regardless of this.

export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

export interface IntegrationMetadata {
  status: IntegrationStatus
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}

function defaultMetadata(): IntegrationMetadata {
  return {
    status: 'not_connected',
    connectedAt: null,
    lastTestAt: null,
    lastTestOk: null,
    scopes: defaultScopes(),
  }
}

/**
 * In-memory metadata store, keyed by integration id. Exported (like
 * `tasks`/`currentSettings` elsewhere in this codebase) so tests can inspect
 * and reset state between cases.
 */
export const integrationMetadata = new Map<IntegrationId, IntegrationMetadata>()

function getMetadata(id: IntegrationId): IntegrationMetadata {
  const existing = integrationMetadata.get(id)
  if (existing) return existing
  const fresh = defaultMetadata()
  integrationMetadata.set(id, fresh)
  return fresh
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Bound on a single credential field's length (tokens/URLs are short). */
const MAX_FIELD_VALUE_LEN = 4096

/**
 * Small validation-error class so handlers can distinguish expected client
 * errors (400) from unexpected service failures (500) without sniffing
 * message strings — mirrors the pattern in routes/credentials.ts.
 */
class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * Validate the Jira `siteUrl` field. Must be an https URL that does not
 * resolve (by literal hostname) to a private/loopback address, so a stored
 * site URL cannot later be used to make the server-side test/health-check
 * request (POST /api/integrations/:id/test) target internal infrastructure.
 */
function validateSiteUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ValidationError('Field "siteUrl" must be a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError('Field "siteUrl" must use https')
  }
  if (!isSsrfSafeHostname(parsed.hostname)) {
    throw new ValidationError('Field "siteUrl" must not point to a private or loopback address')
  }
}

/**
 * Validate the `credentials` object in the request body against an
 * integration's field specs. Returns the map of field key → trimmed value for
 * every field that was provided (required fields are guaranteed present).
 *
 * Throws ValidationError for: a non-object payload, an unrecognised field
 * key, a non-string value, a missing/blank required field, an over-length
 * value, or (for `siteUrl`) a URL that fails the SSRF guard.
 */
function validateCredentialFields(
  def: IntegrationDefinition,
  input: unknown,
): Record<string, string> {
  const raw = input ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('credentials must be an object of field name to value')
  }
  const record = raw as Record<string, unknown>

  const allowedKeys = new Set(def.fields.map((f) => f.key))
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError(`Unknown credential field "${key}" for integration "${def.id}"`)
    }
  }

  const result: Record<string, string> = {}
  const missing: string[] = []

  for (const field of def.fields) {
    const value = record[field.key]
    if (value === undefined) {
      if (field.required) missing.push(field.key)
      continue
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`Field "${field.key}" must be a string`)
    }
    const trimmed = value.trim()
    if (trimmed === '') {
      if (field.required) missing.push(field.key)
      continue
    }
    if (trimmed.length > MAX_FIELD_VALUE_LEN) {
      throw new ValidationError(
        `Field "${field.key}" must be at most ${MAX_FIELD_VALUE_LEN} characters`,
      )
    }
    if (field.key === 'siteUrl') {
      validateSiteUrl(trimmed)
    }
    result[field.key] = trimmed
  }

  if (missing.length > 0) {
    throw new ValidationError(`Missing required field(s): ${missing.join(', ')}`)
  }

  return result
}

/** Validate a single scope list (taskTypes or agents) against its allowed set. */
function validateScopeList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T[] {
  if (value === undefined) return [...allowed]
  if (!Array.isArray(value)) {
    throw new ValidationError(`scopes.${fieldName} must be an array`)
  }
  const result = new Set<T>()
  for (const item of value) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      throw new ValidationError(`scopes.${fieldName} contains an invalid value: ${String(item)}`)
    }
    result.add(item as T)
  }
  return Array.from(result)
}

/**
 * Validate the `scopes` object in the request body. Missing/omitted lists
 * default to "all" (matching the PRD's "default all" behaviour); an
 * explicitly empty array is honoured as "none" (a valid, if unusual, choice).
 */
function validateScopes(input: unknown): IntegrationScopes {
  if (input === undefined || input === null) {
    return defaultScopes()
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('scopes must be an object')
  }
  const record = input as Record<string, unknown>
  return {
    taskTypes: validateScopeList(record['taskTypes'], ALL_TASK_TYPES, 'taskTypes'),
    agents: validateScopeList(record['agents'], ALL_AGENTS, 'agents'),
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

// Every endpoint requires a valid authenticated user. requireAuth populates
// req.user with a safe user object (id, email, createdAt).
integrationsRouter.use(requireAuth)

// ── PUT /api/integrations/:id ─────────────────────────────────────────────────
//
// Create or replace an integration's connection: persists write-only
// credential fields (encrypted, per-field) and the scoping configuration.
// Never returns credential values.

integrationsRouter.put('/:id', requireCsrf, (req: Request, res: Response) => {
  const { id } = req.params

  if (!isIntegrationId(id)) {
    res.status(404).json({ error: `Unknown integration: ${id}` })
    return
  }

  const definition = INTEGRATIONS[id]
  const body = (req.body ?? {}) as Record<string, unknown>

  let fieldValues: Record<string, string>
  let scopes: IntegrationScopes
  try {
    fieldValues = validateCredentialFields(definition, body['credentials'])
    scopes = validateScopes(body['scopes'])
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }

  // Persist each provided field to the encrypted credential store under the
  // system scope. Validation above already guarantees every required field is
  // present, so only a real store failure (not a bad value) reaches here.
  //
  // System-scoped rows (user_id IS NULL) never match SQLite's
  // ON CONFLICT(user_id, key) target — NULL is never equal to NULL in a
  // UNIQUE index — so a bare saveCredential() on an existing key would insert
  // a second row and collide on the primary key instead of updating in
  // place. Removing first guarantees a clean insert, matching the same
  // workaround used for the system-scoped AI API key in routes/settings.ts.
  try {
    for (const field of definition.fields) {
      const value = fieldValues[field.key]
      if (value === undefined) continue // optional field, not supplied
      const key = integrationCredentialKey(id, field.key)
      removeCredential(null, key)
      saveCredential(null, key, value)
    }
  } catch (err) {
    // Never leak credential values or raw crypto/storage detail.
    console.error(
      `[integrations] failed to store credentials for "${id}":`,
      (err as Error).message,
    )
    res.status(500).json({ error: 'Failed to store integration credentials' })
    return
  }

  const existing = getMetadata(id)
  const now = new Date().toISOString()
  const updated: IntegrationMetadata = {
    status: 'connected',
    // Preserve the original connection timestamp across reconnects/updates;
    // only set it the first time this integration becomes connected.
    connectedAt: existing.connectedAt ?? now,
    // Credentials just changed — any previously persisted test result is
    // stale, so clear it rather than surface a misleading status.
    lastTestAt: null,
    lastTestOk: null,
    scopes,
  }
  integrationMetadata.set(id, updated)

  res.json({ id, ...updated })
})
