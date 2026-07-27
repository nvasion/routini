// ─────────────────────────────────────────────────────────────────────────────
// Integrations catalog
//
// Static definitions for the seven v1 integrations (see PRD "Routini
// Integrations"): GitHub, Slack, Jira, Notion, Linear, monday.com, and
// HubSpot. This module is pure metadata — it defines *what* an integration
// looks like (its credential fields, where to obtain them, and its default
// scoping) but holds no runtime state and performs no I/O. The HTTP handlers
// that expose this catalog (GET/PUT/POST/DELETE /api/integrations/:id) and
// the connection/status store that tracks per-integration state are added by
// later tasks and will import from here rather than duplicate this data.
//
// Security properties:
//   – This module never holds credential *values* — only field specs
//     (key/label/type/required/placeholder/helpText) describing what a
//     credential form should collect. There is nothing here for a GET
//     response, log line, or error message to leak.
//   – `credentialKey()` is the single place that defines the storage-key
//     convention (`integration_<id>_<field>`) used by the encrypted
//     credential store (see server/src/services/credentials.ts). Centralizing
//     it here means every future route/service that needs the key derives it
//     the same way instead of re-implementing the naming scheme.
//   – Field keys and integration ids are restricted to a safe charset
//     ([a-z0-9] plus camelCase letters) at catalog-definition time and
//     asserted by tests, so they are safe to embed directly in credential
//     store keys without further escaping.
// ─────────────────────────────────────────────────────────────────────────────

import type { AIProvider, TaskType } from '../types.js'

// ── Types ────────────────────────────────────────────────────────────────────

/** Stable identifiers for the seven v1 integrations. */
export const INTEGRATION_IDS = [
  'github',
  'slack',
  'jira',
  'notion',
  'linear',
  'monday',
  'hubspot',
] as const

export type IntegrationId = (typeof INTEGRATION_IDS)[number]

/**
 * Input type hint for rendering a credential field in the connect modal.
 * `password`-typed fields hold secret material (tokens/keys) and must never
 * be echoed back by any API response.
 */
export type CredentialFieldType = 'text' | 'password' | 'url' | 'email'

/** Describes one credential input the connect modal must collect. */
export interface CredentialFieldSpec {
  /** Logical field name, e.g. "apiToken". Combined with the integration id to
   *  form the credential-store key — see `credentialKey()`. Must be a
   *  non-empty camelCase identifier ([a-zA-Z0-9] only, starting with a
   *  lowercase letter) so it is safe to embed in storage keys and DOM ids. */
  key: string
  /** Human-readable label shown above the input. */
  label: string
  /** Input type hint for the modal (controls masking, keyboard, validation). */
  type: CredentialFieldType
  /** Whether this field must be non-empty for the integration to be saved. */
  required: boolean
  /** Optional example value shown as input placeholder text. */
  placeholder?: string
  /** Optional short help text shown under the input. */
  helpText?: string
}

/** Default scoping applied to a newly connected integration ("default all"). */
export interface IntegrationScopes {
  /** Task types allowed to use this integration. */
  taskTypes: TaskType[]
  /** Coding agents allowed to use this integration. */
  agents: AIProvider[]
}

/** Full catalog entry for one integration. */
export interface IntegrationDefinition {
  id: IntegrationId
  /** Display name shown on the catalog card, e.g. "GitHub". */
  name: string
  /** One-line description shown on the catalog card. */
  description: string
  /** Credential fields the connect modal must collect, in display order. */
  credentialFields: CredentialFieldSpec[]
  /** Provider page where the user generates the credential(s). */
  setupUrl: string
  /** Short inline instructions shown above the credential fields in the modal. */
  setupInstructions: string
  /** Scoping applied when the integration is first connected. */
  defaultScopes: IntegrationScopes
}

// ── Default scopes ──────────────────────────────────────────────────────────

/**
 * "Default all" scoping per the PRD UX summary: a newly connected
 * integration is available to every task type and every agent until the user
 * narrows it. Returns a fresh object each call so callers can safely mutate
 * their own copy without affecting the catalog or other callers.
 */
export function defaultAllScopes(): IntegrationScopes {
  return {
    taskTypes: ['daily', 'developmental', 'routine'],
    agents: ['claude', 'opencode', 'omnimancer'],
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

const CATALOG: Readonly<Record<IntegrationId, IntegrationDefinition>> = {
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Read and write repositories, issues, and pull requests.',
    credentialFields: [
      {
        key: 'token',
        label: 'Fine-grained personal access token',
        type: 'password',
        required: true,
        placeholder: 'github_pat_…',
        helpText: 'Grant only the repository permissions your tasks need.',
      },
    ],
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    setupInstructions:
      'Create a fine-grained personal access token scoped to the repositories you want Routini to access.',
    defaultScopes: defaultAllScopes(),
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    description: 'Post messages and read channel activity via a bot user.',
    credentialFields: [
      {
        key: 'botToken',
        label: 'Bot User OAuth Token',
        type: 'password',
        required: true,
        placeholder: 'xoxb-…',
        helpText: 'Found on the "OAuth & Permissions" page of your Slack app.',
      },
    ],
    setupUrl: 'https://api.slack.com/apps',
    setupInstructions:
      'Create (or open) a Slack app, install it to your workspace, and copy the Bot User OAuth Token.',
    defaultScopes: defaultAllScopes(),
  },
  jira: {
    id: 'jira',
    name: 'Jira',
    description: 'Create and update issues in your Jira Cloud site.',
    credentialFields: [
      {
        key: 'siteUrl',
        label: 'Site URL',
        type: 'url',
        required: true,
        placeholder: 'https://your-domain.atlassian.net',
      },
      {
        key: 'email',
        label: 'Account email',
        type: 'email',
        required: true,
        placeholder: 'you@example.com',
      },
      {
        key: 'apiToken',
        label: 'API token',
        type: 'password',
        required: true,
        helpText: 'Generated from your Atlassian account security settings.',
      },
    ],
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    setupInstructions:
      'Generate an API token for your Atlassian account, then enter it with your account email and Jira site URL.',
    defaultScopes: defaultAllScopes(),
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write pages and databases shared with the integration.',
    credentialFields: [
      {
        key: 'token',
        label: 'Internal integration token',
        type: 'password',
        required: true,
        placeholder: 'secret_…',
        helpText: 'Remember to share the relevant pages/databases with the integration in Notion.',
      },
    ],
    setupUrl: 'https://www.notion.so/my-integrations',
    setupInstructions:
      'Create an internal integration in Notion and copy its secret token.',
    defaultScopes: defaultAllScopes(),
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    description: 'Create and update issues in your Linear workspace.',
    credentialFields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        placeholder: 'lin_api_…',
      },
    ],
    setupUrl: 'https://linear.app/settings/api',
    setupInstructions: 'Create a personal API key from your Linear workspace settings.',
    defaultScopes: defaultAllScopes(),
  },
  monday: {
    id: 'monday',
    name: 'monday.com',
    description: 'Read and update items and boards on monday.com.',
    credentialFields: [
      {
        key: 'apiToken',
        label: 'API token',
        type: 'password',
        required: true,
      },
    ],
    setupUrl: 'https://monday.com/developers/v2#authentication-section',
    setupInstructions: 'Copy your personal API token from the monday.com Developers page.',
    defaultScopes: defaultAllScopes(),
  },
  hubspot: {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Read and update CRM records via a private app.',
    credentialFields: [
      {
        key: 'accessToken',
        label: 'Private app access token',
        type: 'password',
        required: true,
        placeholder: 'pat-…',
      },
    ],
    setupUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    setupInstructions:
      'Create a private app in your HubSpot account and copy its access token.',
    defaultScopes: defaultAllScopes(),
  },
}

/** Ordered catalog list — the order the catalog grid should render cards in. */
export const INTEGRATIONS: readonly IntegrationDefinition[] = INTEGRATION_IDS.map(
  (id) => CATALOG[id],
)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Type guard for the fixed integration-id union. */
export function isIntegrationId(value: unknown): value is IntegrationId {
  return (
    typeof value === 'string' &&
    (INTEGRATION_IDS as readonly string[]).includes(value)
  )
}

/** Look up a catalog entry by id. Returns undefined for an unknown id. */
export function getIntegrationDefinition(
  id: string,
): IntegrationDefinition | undefined {
  return isIntegrationId(id) ? CATALOG[id] : undefined
}

/**
 * Build the credential-store key for one field of one integration, e.g.
 * `integration_github_token`. This is the single source of truth for the
 * naming convention described in the PRD ("Storage: credential store entries
 * `integration_<id>_<field>`") so route handlers and services never
 * hand-construct the key themselves.
 *
 * Throws when `id` is not a known integration or `field` is not one of that
 * integration's declared credential fields — callers should treat this as a
 * programming error (never triggered by unvalidated user input reaching this
 * function directly).
 */
export function credentialKey(id: IntegrationId, field: string): string {
  const def = CATALOG[id]
  if (!def) {
    throw new Error(`Unknown integration id: ${id}`)
  }
  const known = def.credentialFields.some((f) => f.key === field)
  if (!known) {
    throw new Error(`Unknown credential field "${field}" for integration "${id}"`)
  }
  return `integration_${id}_${field}`
}

/** The `key`s of every credential field declared for an integration. */
export function requiredCredentialFieldKeys(id: IntegrationId): string[] {
  return CATALOG[id].credentialFields.filter((f) => f.required).map((f) => f.key)
}
