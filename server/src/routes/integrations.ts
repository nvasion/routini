/**
 * Integrations API
 *
 * Exposes the v1 integration catalog (GitHub, Slack, Jira, Notion, Linear,
 * monday.com, HubSpot) and the CRUD + live-test endpoints described in the
 * "Routini Integrations" PRD:
 *
 *   GET    /api/integrations           – catalog + per-integration status
 *   PUT    /api/integrations/:id       – store credentials + scoping
 *   POST   /api/integrations/:id/test  – live provider health check
 *   DELETE /api/integrations/:id       – disconnect
 *
 * Storage:
 *   – Secrets: the encrypted credential store (server/src/services/credentials.ts,
 *     AES-256-GCM at rest) under the key `integration_<id>_<field>`, system
 *     scope (userId = null) since integrations are a single shared,
 *     server-wide configuration (mirroring how the AI API key is stored in
 *     server/src/routes/settings.ts).
 *   – Non-secret metadata (connectedAt/lastTestAt/lastTestOk/scopes) lives in
 *     an in-memory map, matching the current persistence tier of the other
 *     skeleton routers in this codebase (settings, notifications, tasks).
 *     Durable sqlite persistence for this metadata is tracked as a separate
 *     PRD task.
 *
 * SECURITY:
 *   – Secrets are never serialized into any response — GET/PUT/DELETE below
 *     only ever return the catalog/status shape, never raw field values.
 *   – All mutating routes require requireAuth + requireCsrf.
 *   – POST /:id/test only ever runs against the fixed provider APIs (or, for
 *     Jira, a user-supplied site URL that is SSRF-validated — see
 *     server/src/services/integrationProviders.ts).
 */

import { Router, Request, Response } from 'express'
import { requireAuth, requireCsrf } from './auth.js'
import {
  getCredentialSecret,
  removeCredential,
  saveCredential,
} from '../services/credentials.js'
import { hasProviderTest, runProviderTest } from '../services/integrationProviders.js'
import { VALID_AGENTS } from '../services/devTask.js'
import type { TaskType } from '../types.js'

export const integrationsRouter = Router()

// ── Catalog ───────────────────────────────────────────────────────────────────

export interface IntegrationField {
  /** Field name; combined with the integration id to form the credential key. */
  key: string
  label: string
  required: boolean
  /** True for values that are always secret (all v1 fields are write-only). */
  secret: true
}

export interface IntegrationDefinition {
  id: string
  name: string
  description: string
  /** Link to the provider's token/credential setup page, shown in the connect modal. */
  setupUrl: string
  fields: IntegrationField[]
}

function field(key: string, label: string, required = true): IntegrationField {
  return { key, label, required, secret: true }
}

/** The seven v1 token/API-key integrations, in catalog display order. */
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Fine-grained personal access token for repo and issue access.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    fields: [field('token', 'Fine-grained personal access token')],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Bot token for posting and reading messages via a Slack app.',
    setupUrl: 'https://api.slack.com/apps',
    fields: [field('botToken', 'Bot token (xoxb-…)')],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'API token, account email, and site URL for Jira Cloud.',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: [
      field('apiToken', 'API token'),
      field('siteUrl', 'Site URL (e.g. https://yourcompany.atlassian.net)'),
      field('email', 'Account email'),
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Internal integration token for reading and writing pages/databases.',
    setupUrl: 'https://www.notion.so/my-integrations',
    fields: [field('token', 'Internal integration token')],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Personal API key for reading and writing issues.',
    setupUrl: 'https://linear.app/settings/api',
    fields: [field('apiKey', 'API key')],
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'API token for reading and writing boards and items.',
    setupUrl: 'https://developer.monday.com/api-reference/docs/authentication',
    fields: [field('apiToken', 'API token')],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Private app token for reading and writing CRM objects.',
    setupUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    fields: [field('token', 'Private app token')],
  },
]

const INTEGRATIONS_BY_ID = new Map(INTEGRATIONS.map((i) => [i.id, i]))

/** Task types that may be scoped to use an integration. Mirrors types.ts TaskType. */
const VALID_TASK_TYPES: readonly TaskType[] = ['daily', 'developmental', 'routine']

// ── Metadata store (non-secret) ──────────────────────────────────────────────

export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: string[]
}

interface IntegrationMetadata {
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}

function defaultScopes(): IntegrationScopes {
  // "default all" per the PRD scoping panel.
  return { taskTypes: [...VALID_TASK_TYPES], agents: [...VALID_AGENTS] }
}

function defaultMetadata(): IntegrationMetadata {
  return { connectedAt: null, lastTestAt: null, lastTestOk: null, scopes: defaultScopes() }
}

/** In-memory metadata keyed by integration id. Exported for tests. */
export const integrationMeta = new Map<string, IntegrationMetadata>(
  INTEGRATIONS.map((i) => [i.id, defaultMetadata()]),
)

/** Resets all integration metadata to its initial state. Test-only helper. */
export function resetIntegrationsState(): void {
  for (const def of INTEGRATIONS) {
    integrationMeta.set(def.id, defaultMetadata())
  }
}

// ── Credential-store helpers ──────────────────────────────────────────────────

/** Builds the credential-store key for one field of one integration. */
function credentialKey(integrationId: string, fieldKey: string): string {
  return `integration_${integrationId}_${fieldKey}`
}

/** Returns true when every required field for the integration has a stored value. */
function isFullyConnected(def: IntegrationDefinition): boolean {
  return def.fields
    .filter((f) => f.required)
    .every((f) => getCredentialSecret(null, credentialKey(def.id, f.key)) !== undefined)
}

/** Reads all stored field values for an integration, decrypted. Server-side only. */
function readStoredFields(def: IntegrationDefinition): Record<string, string> {
  const values: Record<string, string> = {}
  for (const f of def.fields) {
    const value = getCredentialSecret(null, credentialKey(def.id, f.key))
    if (value !== undefined) values[f.key] = value
  }
  return values
}

// ── Response shaping ──────────────────────────────────────────────────────────

type IntegrationStatus = 'not_connected' | 'connected' | 'error'

function computeStatus(connected: boolean, meta: IntegrationMetadata): IntegrationStatus {
  if (!connected) return 'not_connected'
  return meta.lastTestOk === false ? 'error' : 'connected'
}

/** Client-safe projection of an integration: catalog fields + status. Never includes secrets. */
function toResponseIntegration(def: IntegrationDefinition, meta: IntegrationMetadata) {
  const connected = isFullyConnected(def)
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    setupUrl: def.setupUrl,
    fields: def.fields.map((f) => ({ key: f.key, label: f.label, required: f.required })),
    status: computeStatus(connected, meta),
    connectedAt: meta.connectedAt,
    lastTestAt: meta.lastTestAt,
    lastTestOk: meta.lastTestOk,
    scopes: meta.scopes,
  }
}

// ── Validation errors ─────────────────────────────────────────────────────────

class ValidationError extends Error {}

function requireIntegration(id: string): IntegrationDefinition {
  const def = INTEGRATIONS_BY_ID.get(id)
  if (!def) {
    throw new ValidationError(`Unknown integration "${id}"`)
  }
  return def
}

/** Validates and normalizes an optional scopes payload from a PUT body. */
function parseScopes(raw: unknown, fallback: IntegrationScopes): IntegrationScopes {
  if (raw === undefined) return fallback
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('scopes must be an object')
  }
  const { taskTypes, agents } = raw as Record<string, unknown>

  let parsedTaskTypes = fallback.taskTypes
  if (taskTypes !== undefined) {
    if (!Array.isArray(taskTypes) || !taskTypes.every((t) => typeof t === 'string')) {
      throw new ValidationError('scopes.taskTypes must be an array of strings')
    }
    const invalid = taskTypes.find((t) => !VALID_TASK_TYPES.includes(t as TaskType))
    if (invalid !== undefined) {
      throw new ValidationError(
        `scopes.taskTypes contains an invalid value "${invalid}". Must be one of: ${VALID_TASK_TYPES.join(', ')}`,
      )
    }
    parsedTaskTypes = taskTypes as TaskType[]
  }

  let parsedAgents = fallback.agents
  if (agents !== undefined) {
    if (!Array.isArray(agents) || !agents.every((a) => typeof a === 'string')) {
      throw new ValidationError('scopes.agents must be an array of strings')
    }
    const invalid = agents.find((a) => !VALID_AGENTS.has(a))
    if (invalid !== undefined) {
      throw new ValidationError(
        `scopes.agents contains an invalid value "${invalid}". Must be one of: ${[...VALID_AGENTS].join(', ')}`,
      )
    }
    parsedAgents = agents as string[]
  }

  return { taskTypes: parsedTaskTypes, agents: parsedAgents }
}

// ── GET /api/integrations ─────────────────────────────────────────────────────
//
// Returns the full catalog with live status/scoping metadata. Never includes
// secret material — only field names/labels from the catalog definition.

integrationsRouter.get('/', requireAuth, (_req: Request, res: Response) => {
  const list = INTEGRATIONS.map((def) => {
    const meta = integrationMeta.get(def.id) ?? defaultMetadata()
    return toResponseIntegration(def, meta)
  })
  res.json({ integrations: list })
})

// ── PUT /api/integrations/:id ─────────────────────────────────────────────────
//
// Stores write-only credential fields and/or scoping for one integration.
// Required fields must all be present together to (re)establish a connection;
// a scopes-only update is allowed against an already-connected integration.

integrationsRouter.put(
  '/:id',
  requireAuth,
  requireCsrf,
  (req: Request, res: Response) => {
    const { id } = req.params
    let def: IntegrationDefinition
    try {
      def = requireIntegration(id)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
      return
    }

    const body = req.body as Record<string, unknown>
    const meta = integrationMeta.get(def.id) ?? defaultMetadata()

    const providedFieldKeys = def.fields.filter((f) => body[f.key] !== undefined)
    const isCredentialUpdate = providedFieldKeys.length > 0

    if (isCredentialUpdate) {
      // Establishing/replacing credentials: every required field must be present
      // and non-empty in this request (partial required-field updates would
      // leave the integration in an inconsistent, silently-broken state).
      const missing = def.fields.filter((f) => f.required && body[f.key] === undefined)
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing required field(s): ${missing.map((f) => f.key).join(', ')}`,
        })
        return
      }
      for (const f of def.fields) {
        const value = body[f.key]
        if (value === undefined) continue
        if (typeof value !== 'string' || value.trim() === '') {
          res.status(400).json({ error: `${f.key} must be a non-empty string` })
          return
        }
      }
    }

    let scopes: IntegrationScopes
    try {
      scopes = parseScopes(body['scopes'], meta.scopes)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
      return
    }

    if (isCredentialUpdate) {
      try {
        for (const f of def.fields) {
          const value = body[f.key]
          if (typeof value === 'string') {
            // Remove any existing row for this (system-scoped) key before
            // inserting. SQLite's UNIQUE(user_id, key) constraint never
            // matches two NULL user_ids as equal, so ON CONFLICT cannot
            // catch a duplicate system-scoped key on its own — the same
            // gotcha documented and worked around in routes/settings.ts for
            // the AI API key.
            removeCredential(null, credentialKey(def.id, f.key))
            saveCredential(null, credentialKey(def.id, f.key), value)
          }
        }
      } catch (err) {
        console.error(`[integrations] Failed to store credentials for "${def.id}":`, (err as Error).message)
        res.status(500).json({ error: 'Failed to store integration credentials' })
        return
      }
    }

    const now = new Date().toISOString()
    const nowConnected = isFullyConnected(def)
    const updated: IntegrationMetadata = {
      connectedAt: nowConnected ? (meta.connectedAt ?? now) : meta.connectedAt,
      // A credential change invalidates any previous test result.
      lastTestAt: isCredentialUpdate ? null : meta.lastTestAt,
      lastTestOk: isCredentialUpdate ? null : meta.lastTestOk,
      scopes,
    }
    integrationMeta.set(def.id, updated)

    res.json(toResponseIntegration(def, updated))
  },
)

// ── POST /api/integrations/:id/test ───────────────────────────────────────────
//
// Runs a live, read-only health check against the provider using the stored
// credentials, then persists the result (lastTestAt/lastTestOk). Requires the
// integration to already have all required credentials stored.

integrationsRouter.post(
  '/:id/test',
  requireAuth,
  requireCsrf,
  async (req: Request, res: Response) => {
    const { id } = req.params
    let def: IntegrationDefinition
    try {
      def = requireIntegration(id)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
      return
    }

    if (!hasProviderTest(def.id)) {
      // Defensive guard: every current catalog entry has a provider test, but
      // this keeps the endpoint safe if the catalog grows ahead of the test
      // implementations.
      res.status(501).json({ error: `No live test is implemented for "${def.id}"` })
      return
    }

    if (!isFullyConnected(def)) {
      res.status(400).json({ error: 'Integration is not connected — store credentials before testing' })
      return
    }

    const creds = readStoredFields(def)
    const now = new Date().toISOString()
    const meta = integrationMeta.get(def.id) ?? defaultMetadata()

    let result: { ok: boolean; message: string }
    try {
      result = await runProviderTest(def.id, creds)
    } catch (err) {
      // Never leak provider/internal error detail; log server-side only. This
      // branch covers unexpected bugs, not ordinary network failures (which
      // integrationProviders.ts already converts into a safe { ok: false } result).
      console.error(`[integrations] Unexpected error testing "${def.id}":`, (err as Error).message)
      result = { ok: false, message: 'Unexpected error while testing the integration' }
    }

    const updated: IntegrationMetadata = {
      ...meta,
      lastTestAt: now,
      lastTestOk: result.ok,
    }
    integrationMeta.set(def.id, updated)

    res.json({
      id: def.id,
      ok: result.ok,
      message: result.message,
      lastTestAt: updated.lastTestAt,
      lastTestOk: updated.lastTestOk,
      status: computeStatus(true, updated),
    })
  },
)

// ── DELETE /api/integrations/:id ───────────────────────────────────────────────
//
// Disconnects an integration: removes all stored credential fields and resets
// metadata to its initial (never-connected) state.

integrationsRouter.delete(
  '/:id',
  requireAuth,
  requireCsrf,
  (req: Request, res: Response) => {
    const { id } = req.params
    let def: IntegrationDefinition
    try {
      def = requireIntegration(id)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
      return
    }

    for (const f of def.fields) {
      removeCredential(null, credentialKey(def.id, f.key))
    }
    integrationMeta.set(def.id, defaultMetadata())

    res.json(toResponseIntegration(def, defaultMetadata()))
  },
)
