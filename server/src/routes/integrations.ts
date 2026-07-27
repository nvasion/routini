// ─────────────────────────────────────────────────────────────────────────────
// Integrations API router
//
// v1 catalog of token/API-key integrations (GitHub, Slack, Jira, Notion,
// Linear, monday.com, HubSpot) that Routini tasks and coding-agent containers
// can use. This module owns:
//
//   – The static catalog (id, display name, per-integration credential field
//     specs, provider setup-URL, default scoping).
//   – DELETE /api/integrations/:id — disconnect: removes every stored
//     credential field for the integration and resets its persisted metadata
//     back to the default "not connected" state.
//
// GET (catalog + status), PUT (write-only credential + scope save), and
// POST /:id/test (live provider health check) are implemented by companion
// tasks against this same catalog; this file intentionally only implements
// what disconnect needs so those can land independently.
//
// Storage model:
//   – Secrets: encrypted credential store (server/src/services/credentials.ts),
//     one entry per field at key `integration_<id>_<field>`, system scope
//     (userId = null) since integrations are a single shared, server-side
//     configuration rather than per-user. Never returned by any endpoint.
//   – Non-secret metadata (status/connectedAt/lastTest*/scopes): the
//     `integration_metadata` SQLite table (server/src/db/index.ts). A missing
//     row means "never connected" — disconnect deletes the row rather than
//     writing a fresh "not_connected" row, so absence is the canonical
//     default state read by GET.
//
// Security properties:
//   – requireAuth on every route; requireCsrf on the state-changing DELETE.
//   – The :id path param is only ever used to build credential-store keys
//     after being matched against the fixed catalog list, so it can never be
//     used to reach an arbitrary credential key (no injection surface).
//   – Errors are wrapped with context and logged server-side only; no secret
//     material or raw crypto/storage error detail is ever sent to the client.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express'
import { requireAuth, requireCsrf } from './auth.js'
import { removeCredential } from '../services/credentials.js'
import { deleteIntegrationMetadata } from '../db/index.js'
import type { AIProvider, TaskType } from '../types.js'

export const integrationsRouter = Router()

// ── Catalog ──────────────────────────────────────────────────────────────────

/** A single write-only credential field required to connect an integration. */
export interface IntegrationCredentialField {
  /** Field key; combined with the integration id to form the credential-store key. */
  key: string
  /** Human-readable label shown in the connect modal. */
  label: string
}

/** Scoping: which task types and coding agents may use a connected integration. */
export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: AIProvider[]
}

export interface IntegrationDefinition {
  id: string
  name: string
  /** Link to the provider's token/credential creation page, shown in the connect modal. */
  setupUrl: string
  credentialFields: IntegrationCredentialField[]
}

const ALL_TASK_TYPES: readonly TaskType[] = ['daily', 'developmental', 'routine']
const ALL_AGENTS: readonly AIProvider[] = ['claude', 'opencode', 'omnimancer']

/** Default scoping applied to every integration: allowed everywhere until narrowed. */
export function defaultScopes(): IntegrationScopes {
  return { taskTypes: [...ALL_TASK_TYPES], agents: [...ALL_AGENTS] }
}

/** The seven v1 integrations, per the Routini Integrations PRD. */
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    credentialFields: [{ key: 'token', label: 'Fine-grained personal access token' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    setupUrl: 'https://api.slack.com/apps',
    credentialFields: [{ key: 'botToken', label: 'Bot token' }],
  },
  {
    id: 'jira',
    name: 'Jira',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    credentialFields: [
      { key: 'apiToken', label: 'API token' },
      { key: 'siteUrl', label: 'Site URL' },
      { key: 'email', label: 'Email' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    setupUrl: 'https://www.notion.so/my-integrations',
    credentialFields: [{ key: 'token', label: 'Internal integration token' }],
  },
  {
    id: 'linear',
    name: 'Linear',
    setupUrl: 'https://linear.app/settings/api',
    credentialFields: [{ key: 'apiKey', label: 'API key' }],
  },
  {
    id: 'monday',
    name: 'monday.com',
    setupUrl: 'https://monday.com/developers/apps',
    credentialFields: [{ key: 'apiToken', label: 'API token' }],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    setupUrl: 'https://app.hubspot.com/private-apps',
    credentialFields: [{ key: 'token', label: 'Private app token' }],
  },
]

/** Look up a catalog entry by id. Returns undefined for an unknown/invalid id. */
export function findIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.id === id)
}

/**
 * Build the credential-store key for a given integration field, e.g.
 * `integration_jira_apiToken`. Only called with a `field.key` sourced from
 * the static catalog above, and an `id` that has already been validated
 * against the catalog — never with raw, unvalidated user input.
 */
export function integrationCredentialKey(integrationId: string, fieldKey: string): string {
  return `integration_${integrationId}_${fieldKey}`
}

// ── Middleware ───────────────────────────────────────────────────────────────

// Every endpoint requires an authenticated user, mirroring the credentials router.
integrationsRouter.use(requireAuth)

// ── DELETE /api/integrations/:id ──────────────────────────────────────────────
//
// Disconnects an integration: removes every stored credential field and
// resets its persisted metadata back to the default "not connected" state.
// Idempotent — disconnecting an integration that was never connected (or is
// already disconnected) still returns 200 with the default (reset) view.

integrationsRouter.delete('/:id', requireCsrf, (req: Request, res: Response) => {
  const { id } = req.params

  const integration = findIntegration(id)
  if (!integration) {
    res.status(404).json({ error: 'Unknown integration' })
    return
  }

  try {
    for (const field of integration.credentialFields) {
      removeCredential(null, integrationCredentialKey(id, field.key))
    }
    deleteIntegrationMetadata(id)
  } catch (err) {
    // Never leak raw crypto/storage error detail (or any credential value) to
    // the client; log server-side only, with no secret material included.
    console.error(`[integrations] Failed to disconnect integration "${id}":`, (err as Error).message)
    res.status(500).json({ error: 'Failed to disconnect integration' })
    return
  }

  res.json({
    id,
    status: 'not_connected',
    connectedAt: null,
    lastTestAt: null,
    lastTestOk: null,
    scopes: defaultScopes(),
  })
})
