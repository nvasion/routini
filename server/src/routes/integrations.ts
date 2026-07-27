// ─────────────────────────────────────────────────────────────────────────────
// Integrations API router
//
// Defines the v1 catalog of token/API-key integrations (GitHub, Slack, Jira,
// Notion, Linear, monday.com, HubSpot) and exposes CRUD + live-test endpoints
// over them. Consumers are Routini tasks and coding-agent containers — this
// router only manages the server-side connection lifecycle (credentials,
// scoping, connection status), not runtime injection into a running task.
//
// Security properties:
//   – Secrets are NEVER returned by any endpoint. PUT accepts credential
//     field values in the request body and persists them (encrypted) via the
//     credential store; GET/PUT/DELETE/test responses carry status metadata
//     only (id, status, timestamps, scopes).
//   – Secrets are stored under the encrypted credential store's "system"
//     scope (userId = null) as `integration_<id>_<field>`, matching the PRD's
//     storage convention. Non-secret metadata (status/timestamps/scopes)
//     lives in sqlite via server/src/db/index.ts.
//   – All mutating routes (PUT, POST /test, DELETE) require both requireAuth
//     (enforced at the mount point in app.ts) and requireCsrf.
//   – PUT validates that only the integration's declared field keys are
//     accepted, values are non-empty bounded strings, and scoping values are
//     restricted to the known task-type/agent enums — arbitrary keys/values
//     are rejected with 400 rather than silently stored.
//   – The Jira test check accepts a user-supplied site URL, so it is run
//     through the same SSRF guard used by the HTTP daily-task service
//     (https-only, no embedded credentials, private/loopback IPs blocked,
//     post-DNS-resolution re-check). The other providers use fixed,
//     hardcoded API hostnames, not user input.
//   – Errors from provider test calls are wrapped with a generic message;
//     the raw error (which could echo back a URL or header detail) is logged
//     server-side only, and credential values are never logged.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express'
import { requireCsrf } from './auth.js'
import {
  saveCredential,
  getCredentialSecret,
  removeCredential,
} from '../services/credentials.js'
import {
  getIntegrationMetadata,
  upsertIntegrationMetadata,
  deleteIntegrationMetadata,
  type IntegrationMetadataRow,
} from '../db/index.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'

export const integrationsRouter = Router()

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface IntegrationField {
  /** Field name, e.g. "token". Used to build the credential-store key. */
  key: string
  /** Human-readable label shown in the connect modal. */
  label: string
  /** True when the field holds a secret (rendered as a password input). */
  secret: boolean
}

export interface IntegrationDef {
  id: string
  name: string
  description: string
  /** Provider page where the user generates the credential(s) below. */
  setupUrl: string
  fields: readonly IntegrationField[]
}

export const VALID_TASK_TYPES = ['daily', 'developmental', 'routine'] as const
export const VALID_AGENTS = ['claude', 'opencode', 'omnimancer'] as const

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Fine-grained personal access token for repository access.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    fields: [{ key: 'token', label: 'Personal Access Token', secret: true }],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Bot token for posting to and reading from Slack channels.',
    setupUrl: 'https://api.slack.com/apps',
    fields: [{ key: 'botToken', label: 'Bot Token', secret: true }],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'API token for Jira Cloud issue tracking.',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: [
      { key: 'siteUrl', label: 'Site URL', secret: false },
      { key: 'email', label: 'Account Email', secret: false },
      { key: 'apiToken', label: 'API Token', secret: true },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Internal integration token for Notion workspace access.',
    setupUrl: 'https://www.notion.so/my-integrations',
    fields: [{ key: 'token', label: 'Internal Integration Token', secret: true }],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'API key for Linear issue tracking.',
    setupUrl: 'https://linear.app/settings/api',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'API token for monday.com boards and items.',
    setupUrl: 'https://monday.com/developers/apps',
    fields: [{ key: 'apiToken', label: 'API Token', secret: true }],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Private-app access token for HubSpot CRM.',
    setupUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    fields: [{ key: 'token', label: 'Private App Token', secret: true }],
  },
] as const

const DEFAULT_SCOPES = {
  taskTypes: [...VALID_TASK_TYPES] as string[],
  agents: [...VALID_AGENTS] as string[],
}

const MAX_FIELD_VALUE_LEN = 4096

/** Looks up a catalog entry by id. Returns undefined for an unknown id. */
export function getIntegrationDef(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((def) => def.id === id)
}

/** Builds the credential-store key for a given integration field. */
function credentialFieldKey(integrationId: string, fieldKey: string): string {
  return `integration_${integrationId}_${fieldKey}`
}

// ── Response shaping ──────────────────────────────────────────────────────────

export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

interface IntegrationResponse {
  id: string
  name: string
  description: string
  setupUrl: string
  fields: IntegrationField[]
  status: IntegrationStatus
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: { taskTypes: string[]; agents: string[] }
}

/** Parses a scopes JSON column value, falling back to the default on corruption. */
function parseScopeList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed
    }
  } catch {
    // fall through to default below
  }
  return []
}

function buildStatus(def: IntegrationDef): IntegrationResponse {
  const meta = getIntegrationMetadata(def.id)
  const connected = Boolean(meta?.connected_at)

  const scopes = meta
    ? {
        taskTypes: parseScopeList(meta.scope_task_types),
        agents: parseScopeList(meta.scope_agents),
      }
    : { taskTypes: [...DEFAULT_SCOPES.taskTypes], agents: [...DEFAULT_SCOPES.agents] }

  let status: IntegrationStatus = 'not_connected'
  if (connected) {
    status = meta?.last_test_ok === 0 ? 'error' : 'connected'
  }

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    setupUrl: def.setupUrl,
    fields: def.fields.map((f) => ({ ...f })),
    status,
    connectedAt: meta?.connected_at ?? null,
    lastTestAt: meta?.last_test_at ?? null,
    lastTestOk:
      meta?.last_test_ok === null || meta?.last_test_ok === undefined
        ? null
        : Boolean(meta.last_test_ok),
    scopes,
  }
}

// ── Validation helpers ────────────────────────────────────────────────────────

interface ValidatedScopes {
  taskTypes: string[]
  agents: string[]
}

/** Validates an optional `scopes` payload. Returns null when the shape is invalid. */
function validateScopes(input: unknown): ValidatedScopes | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const obj = input as Record<string, unknown>

  const taskTypesRaw = obj['taskTypes'] ?? [...VALID_TASK_TYPES]
  const agentsRaw = obj['agents'] ?? [...VALID_AGENTS]

  if (
    !Array.isArray(taskTypesRaw) ||
    !taskTypesRaw.every(
      (t) => typeof t === 'string' && (VALID_TASK_TYPES as readonly string[]).includes(t),
    )
  ) {
    return null
  }
  if (
    !Array.isArray(agentsRaw) ||
    !agentsRaw.every((a) => typeof a === 'string' && (VALID_AGENTS as readonly string[]).includes(a))
  ) {
    return null
  }

  return {
    taskTypes: [...new Set(taskTypesRaw as string[])],
    agents: [...new Set(agentsRaw as string[])],
  }
}

// ── GET /api/integrations ─────────────────────────────────────────────────────
//
// Returns the full catalog plus per-integration status/connectedAt/lastTest/
// scopes. Never returns secrets — only field *names* are included so the
// client knows what inputs to render.

integrationsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ integrations: INTEGRATIONS.map(buildStatus) })
})

// ── PUT /api/integrations/:id ─────────────────────────────────────────────────
//
// Stores write-only credential fields and/or scoping for one integration.
// All declared fields must be present (non-empty) on first connect; on a
// later PUT (already connected) fields are optional so a caller can update
// only the scoping without resupplying credentials.

integrationsRouter.put('/:id', requireCsrf, (req: Request, res: Response) => {
  const def = getIntegrationDef(req.params.id)
  if (!def) {
    res.status(404).json({ error: `Unknown integration "${req.params.id}"` })
    return
  }

  const body = req.body as Record<string, unknown>
  const credentialsInput = body['credentials']
  const scopesInput = body['scopes']

  if (
    credentialsInput !== undefined &&
    (typeof credentialsInput !== 'object' || credentialsInput === null || Array.isArray(credentialsInput))
  ) {
    res.status(400).json({ error: 'credentials must be an object of field values' })
    return
  }

  const providedCreds = (credentialsInput ?? {}) as Record<string, unknown>
  const allowedKeys = new Set(def.fields.map((f) => f.key))

  for (const key of Object.keys(providedCreds)) {
    if (!allowedKeys.has(key)) {
      res.status(400).json({ error: `Unknown credential field "${key}" for integration "${def.id}"` })
      return
    }
  }

  const existing = getIntegrationMetadata(def.id)
  const isFirstConnect = !existing?.connected_at

  const validatedCreds: Record<string, string> = {}
  for (const field of def.fields) {
    const value = providedCreds[field.key]
    if (value === undefined) {
      if (isFirstConnect) {
        res.status(400).json({ error: `Missing required field "${field.key}" for integration "${def.id}"` })
        return
      }
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      res.status(400).json({ error: `Field "${field.key}" must be a non-empty string` })
      return
    }
    if (value.length > MAX_FIELD_VALUE_LEN) {
      res.status(400).json({ error: `Field "${field.key}" exceeds the maximum length of ${MAX_FIELD_VALUE_LEN} characters` })
      return
    }
    validatedCreds[field.key] = value
  }

  let validatedScopes: ValidatedScopes | null = null
  if (scopesInput !== undefined) {
    validatedScopes = validateScopes(scopesInput)
    if (!validatedScopes) {
      res.status(400).json({
        error: `scopes.taskTypes must be a subset of [${VALID_TASK_TYPES.join(', ')}] and scopes.agents a subset of [${VALID_AGENTS.join(', ')}]`,
      })
      return
    }
  }

  try {
    for (const [key, value] of Object.entries(validatedCreds)) {
      saveCredential(null, credentialFieldKey(def.id, key), value)
    }
  } catch (err) {
    // Never leak crypto/storage detail or the credential value to the client.
    console.error(`[integrations] failed to store credentials for "${def.id}":`, (err as Error).message)
    res.status(500).json({ error: 'Failed to store integration credentials' })
    return
  }

  const credsChanged = Object.keys(validatedCreds).length > 0
  const now = new Date().toISOString()
  const nextScopes: ValidatedScopes =
    validatedScopes ??
    (existing
      ? { taskTypes: parseScopeList(existing.scope_task_types), agents: parseScopeList(existing.scope_agents) }
      : { taskTypes: [...DEFAULT_SCOPES.taskTypes], agents: [...DEFAULT_SCOPES.agents] })

  const row: IntegrationMetadataRow = {
    id: def.id,
    connected_at: existing?.connected_at ?? now,
    last_test_at: credsChanged ? null : existing?.last_test_at ?? null,
    last_test_ok: credsChanged ? null : existing?.last_test_ok ?? null,
    scope_task_types: JSON.stringify(nextScopes.taskTypes),
    scope_agents: JSON.stringify(nextScopes.agents),
    updated_at: now,
  }
  upsertIntegrationMetadata(row)

  res.status(200).json(buildStatus(def))
})

// ── POST /api/integrations/:id/test ───────────────────────────────────────────
//
// Runs a server-side live check against the provider using the stored
// credentials and persists the result. Never accepts credentials in the
// request body — it only reads what is already stored.

integrationsRouter.post('/:id/test', requireCsrf, async (req: Request, res: Response) => {
  const def = getIntegrationDef(req.params.id)
  if (!def) {
    res.status(404).json({ error: `Unknown integration "${req.params.id}"` })
    return
  }

  const meta = getIntegrationMetadata(def.id)
  if (!meta?.connected_at) {
    res.status(400).json({ error: `Integration "${def.id}" is not connected` })
    return
  }

  const creds: Record<string, string> = {}
  for (const field of def.fields) {
    const value = getCredentialSecret(null, credentialFieldKey(def.id, field.key))
    if (value === undefined) {
      res.status(500).json({ error: 'Stored credentials are incomplete; reconnect the integration' })
      return
    }
    creds[field.key] = value
  }

  let result: { ok: boolean; message: string }
  try {
    result = await testIntegrationConnection(def.id, creds)
  } catch (err) {
    console.error(`[integrations] connection test failed for "${def.id}":`, (err as Error).message)
    result = { ok: false, message: 'Connection test failed' }
  }

  const now = new Date().toISOString()
  upsertIntegrationMetadata({
    id: def.id,
    connected_at: meta.connected_at,
    last_test_at: now,
    last_test_ok: result.ok ? 1 : 0,
    scope_task_types: meta.scope_task_types,
    scope_agents: meta.scope_agents,
    updated_at: now,
  })

  res.json({ ...buildStatus(def), lastTestMessage: result.message })
})

// ── DELETE /api/integrations/:id ──────────────────────────────────────────────
//
// Disconnects an integration: removes its stored credentials and resets its
// metadata (status reverts to "not_connected", scopes revert to default).

integrationsRouter.delete('/:id', requireCsrf, (req: Request, res: Response) => {
  const def = getIntegrationDef(req.params.id)
  if (!def) {
    res.status(404).json({ error: `Unknown integration "${req.params.id}"` })
    return
  }

  for (const field of def.fields) {
    removeCredential(null, credentialFieldKey(def.id, field.key))
  }
  deleteIntegrationMetadata(def.id)

  res.json(buildStatus(def))
})

// ── Provider live-check implementations ───────────────────────────────────────

/**
 * Injectable fetch signature, matching services/http.ts's FetchFn convention.
 * Uses `globalThis.Response` (the Fetch API response) rather than the bare
 * `Response` identifier, which in this file refers to express's Response
 * type imported above for the route handlers.
 */
export type IntegrationFetchFn = (url: string, init: RequestInit) => Promise<globalThis.Response>

interface UrlCheckResult {
  valid: boolean
  parsed?: URL
  error?: string
}

/** Validates a user-supplied provider site URL (Jira) against SSRF-relevant rules. */
function validateProviderUrl(rawUrl: string | undefined): UrlCheckResult {
  if (!rawUrl || rawUrl.trim() === '') {
    return { valid: false, error: 'siteUrl is required' }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { valid: false, error: `siteUrl "${rawUrl}" is not a valid URL` }
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'siteUrl must use https' }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'siteUrl must not contain embedded credentials' }
  }
  if (!isSsrfSafeHostname(parsed.hostname)) {
    return { valid: false, error: `siteUrl hostname "${parsed.hostname}" is not allowed` }
  }
  return { valid: true, parsed }
}

/**
 * Performs the provider-specific live connection check. Exported (with
 * injectable fetch/SSRF-check) so it is unit-testable without real network
 * access; the router calls it with the default implementations.
 */
export async function testIntegrationConnection(
  id: string,
  creds: Record<string, string>,
  options: { fetchImpl?: IntegrationFetchFn; ssrfCheck?: (hostname: string) => Promise<boolean> } = {},
): Promise<{ ok: boolean; message: string }> {
  const fetchImpl = options.fetchImpl ?? (fetch as IntegrationFetchFn)
  const ssrfCheck = options.ssrfCheck ?? resolvedIpIsSsrfSafe

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)

  try {
    switch (id) {
      case 'github': {
        const res = await fetchImpl('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${creds.token}`, 'User-Agent': 'Routini-Integrations/1.0' },
          signal: controller.signal,
        })
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `GitHub responded with ${res.status}` }
      }
      case 'slack': {
        const res = await fetchImpl('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.botToken}` },
          signal: controller.signal,
        })
        const body = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean; error?: string }
        return body.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: body.error ? `Slack error: ${body.error}` : 'Slack auth.test failed' }
      }
      case 'jira': {
        const urlCheck = validateProviderUrl(creds.siteUrl)
        if (!urlCheck.valid || !urlCheck.parsed) {
          return { ok: false, message: urlCheck.error ?? 'Invalid siteUrl' }
        }
        const safe = await ssrfCheck(urlCheck.parsed.hostname)
        if (!safe) {
          return { ok: false, message: 'siteUrl resolved to a private or disallowed address' }
        }
        const authHeader = 'Basic ' + Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')
        const res = await fetchImpl(`${urlCheck.parsed.origin}/rest/api/3/myself`, {
          headers: { Authorization: authHeader },
          signal: controller.signal,
        })
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `Jira responded with ${res.status}` }
      }
      case 'notion': {
        const res = await fetchImpl('https://api.notion.com/v1/users/me', {
          headers: { Authorization: `Bearer ${creds.token}`, 'Notion-Version': '2022-06-28' },
          signal: controller.signal,
        })
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `Notion responded with ${res.status}` }
      }
      case 'linear': {
        const res = await fetchImpl('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { Authorization: creds.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ viewer { id } }' }),
          signal: controller.signal,
        })
        if (!res.ok) return { ok: false, message: `Linear responded with ${res.status}` }
        const body = (await res.json().catch(() => null)) as { data?: { viewer?: { id?: string } } } | null
        return body?.data?.viewer?.id
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: 'Linear viewer query failed' }
      }
      case 'monday': {
        const res = await fetchImpl('https://api.monday.com/v2', {
          method: 'POST',
          headers: { Authorization: creds.apiToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query { me { id } }' }),
          signal: controller.signal,
        })
        if (!res.ok) return { ok: false, message: `monday.com responded with ${res.status}` }
        const body = (await res.json().catch(() => null)) as { data?: { me?: { id?: string } } } | null
        return body?.data?.me?.id
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: 'monday.com me query failed' }
      }
      case 'hubspot': {
        const res = await fetchImpl('https://api.hubapi.com/account-info/v3/details', {
          headers: { Authorization: `Bearer ${creds.token}` },
          signal: controller.signal,
        })
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HubSpot responded with ${res.status}` }
      }
      default:
        return { ok: false, message: `Unsupported integration "${id}"` }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'Connection test timed out' }
    }
    return { ok: false, message: 'Connection test failed' }
  } finally {
    clearTimeout(timer)
  }
}
