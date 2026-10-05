// ─────────────────────────────────────────────────────────────────────────────
// Org integration connections (tenant table) and agent env injection
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import {
  DEFAULT_SCOPES,
  INTEGRATIONS,
  fieldCredentialKey,
  type AgentId,
  type IntegrationScopes,
} from '../integrations/catalog.js'
import { PLACEHOLDER, type CredentialBinding } from '../egress/types.js'
import { deleteSecretsWithPrefix, getSecret, putSecret } from './credentials.js'

export interface IntegrationState {
  integrationId: string
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestMessage: string | null
  scopes: IntegrationScopes
}

interface Row {
  integration_id: string
  connected_at: Date | null
  last_test_at: Date | null
  last_test_ok: boolean | null
  last_test_message: string | null
  scopes: Partial<IntegrationScopes> | null
}

const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null)

function toState(r: Row): IntegrationState {
  return {
    integrationId: r.integration_id,
    connectedAt: iso(r.connected_at),
    lastTestAt: iso(r.last_test_at),
    lastTestOk: r.last_test_ok,
    lastTestMessage: r.last_test_message,
    scopes: { agents: r.scopes?.agents ?? [...DEFAULT_SCOPES.agents] },
  }
}

const COLS = 'integration_id, connected_at, last_test_at, last_test_ok, last_test_message, scopes'

export async function listIntegrationStates(q: Queryable, orgId: string): Promise<Map<string, IntegrationState>> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM integrations WHERE org_id = $1`, [orgId])
  return new Map(rows.map((r) => [r.integration_id, toState(r)]))
}

export async function getIntegrationState(q: Queryable, orgId: string, id: string): Promise<IntegrationState | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM integrations WHERE org_id = $1 AND integration_id = $2`, [orgId, id])
  return row ? toState(row) : null
}

/** Stores credential fields and/or scopes. Marks the integration connected on first credential write. */
export async function saveIntegration(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  userId: string,
  id: string,
  input: { credentials?: Record<string, string>; scopes?: IntegrationScopes },
): Promise<IntegrationState> {
  for (const [field, value] of Object.entries(input.credentials ?? {})) {
    await putSecret(q, box, orgId, fieldCredentialKey(id, field), value, userId)
  }
  const wroteCreds = Object.keys(input.credentials ?? {}).length > 0
  const [row] = await q.query<Row>(
    `INSERT INTO integrations (org_id, integration_id, connected_at, scopes)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END, coalesce($4::jsonb, $5::jsonb))
     ON CONFLICT (org_id, integration_id) DO UPDATE SET
       connected_at = coalesce(integrations.connected_at, excluded.connected_at),
       scopes = coalesce($4::jsonb, integrations.scopes),
       updated_at = now()
     RETURNING ${COLS}`,
    [orgId, id, wroteCreds, input.scopes ? JSON.stringify(input.scopes) : null, JSON.stringify(DEFAULT_SCOPES)],
  )
  return toState(row!)
}

export async function recordIntegrationTest(
  q: Queryable,
  orgId: string,
  id: string,
  ok: boolean,
  message: string,
): Promise<IntegrationState | null> {
  const [row] = await q.query<Row>(
    `UPDATE integrations SET last_test_at = now(), last_test_ok = $3, last_test_message = $4, updated_at = now()
     WHERE org_id = $1 AND integration_id = $2 RETURNING ${COLS}`,
    [orgId, id, ok, message],
  )
  return row ? toState(row) : null
}

export async function disconnectIntegration(q: Queryable, orgId: string, id: string): Promise<boolean> {
  await deleteSecretsWithPrefix(q, orgId, `integration.${id}.`)
  const rows = await q.query('DELETE FROM integrations WHERE org_id = $1 AND integration_id = $2 RETURNING integration_id', [orgId, id])
  return rows.length > 0
}

/** Decrypted credential fields for one integration (server-side use only). */
export async function getIntegrationCredentials(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  id: string,
): Promise<Record<string, string>> {
  const def = INTEGRATIONS.find((d) => d.id === id)
  if (!def) return {}
  const out: Record<string, string> = {}
  for (const f of def.fields) {
    const v = await getSecret(q, box, orgId, fieldCredentialKey(id, f.key))
    if (v !== null) out[f.key] = v
  }
  return out
}

/**
 * Env vars for an agent container: every connected integration whose scope
 * includes `agentId`, each field under its catalog env name. Integrations with
 * a missing field are skipped entirely rather than injected half-configured.
 */
export async function getScopedIntegrationEnv(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  agentId: AgentId,
): Promise<Record<string, string>> {
  const states = await listIntegrationStates(q, orgId)
  const env: Record<string, string> = {}
  for (const def of INTEGRATIONS) {
    const state = states.get(def.id)
    if (def.serverOnly || !state?.connectedAt || !state.scopes.agents.includes(agentId)) continue
    const creds = await getIntegrationCredentials(q, box, orgId, def.id)
    if (!def.fields.every((f) => creds[f.key] !== undefined)) continue
    for (const f of def.fields) env[f.env] = creds[f.key]!
  }
  return env
}

export interface BrokeredAccess {
  /** Env for the container: non-secret fields as-is, secret fields as the placeholder. */
  env: Record<string, string>
  bindings: CredentialBinding[]
  /** Hosts the bindings need (added to the session's allow-list). */
  hosts: string[]
  /** Real secret values, for redaction. */
  secrets: string[]
}

/**
 * The broker's view of an agent's integrations: same scoping as
 * getScopedIntegrationEnv, but secrets become placeholders in the env and
 * credential bindings for the proxy. Integrations without broker rules get
 * no secret at all under the broker (they are not reachable safely).
 */
export async function getBrokeredIntegrationAccess(q: Queryable, box: SecretBox, orgId: string, agentId: AgentId): Promise<BrokeredAccess> {
  const states = await listIntegrationStates(q, orgId)
  const out: BrokeredAccess = { env: {}, bindings: [], hosts: [], secrets: [] }
  for (const def of INTEGRATIONS) {
    const state = states.get(def.id)
    if (def.serverOnly || !state?.connectedAt || !state.scopes.agents.includes(agentId)) continue
    const creds = await getIntegrationCredentials(q, box, orgId, def.id)
    if (!def.fields.every((f) => creds[f.key] !== undefined)) continue
    for (const f of def.fields) out.env[f.env] = f.secret ? PLACEHOLDER : creds[f.key]!
    for (const rule of def.broker ?? []) {
      let host = rule.host
      if (!host && rule.hostFromField) {
        try {
          host = new URL(creds[rule.hostFromField]!).hostname
        } catch {
          continue
        }
      }
      if (!host) continue
      out.bindings.push({ host, header: rule.header, format: rule.format, secret: creds[rule.field]!, ...(rule.userField ? { user: creds[rule.userField] } : {}) })
      out.hosts.push(host)
      out.secrets.push(creds[rule.field]!)
    }
  }
  return out
}
