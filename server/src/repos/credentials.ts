// ─────────────────────────────────────────────────────────────────────────────
// Org credential store (tenant table)
//
// Secrets are sealed with the SecretBox, bound to "<orgId>:<key>" so a row
// moved to another org or key cannot be opened. Only metadata ever leaves this
// module through list(); plaintext comes back from getSecret() for server-side
// consumers (step executors, integration checks) and is never serialised.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'

export interface CredentialMeta {
  key: string
  createdAt: string
  updatedAt: string
}

export const MAX_SECRET_LEN = 64 * 1024
export const CREDENTIAL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** Key prefixes owned by other features; the generic credentials API may not write them. */
export const RESERVED_PREFIXES = ['integration.', 'ai.', 'webhook.'] as const

const aad = (orgId: string, key: string) => `${orgId}:${key}`
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

export function validateCredentialKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !CREDENTIAL_KEY_RE.test(key)) {
    throw new Error('Credential key must be 1–128 chars of letters, digits, ".", "_", ":" or "-", starting with a letter or digit')
  }
}

export function validateSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Credential value must be a non-empty string')
  if (value.length > MAX_SECRET_LEN) throw new Error(`Credential value must be at most ${MAX_SECRET_LEN} characters`)
}

export async function putSecret(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  key: string,
  value: string,
  userId: string | null,
): Promise<void> {
  validateCredentialKey(key)
  validateSecretValue(value)
  const sealed = box.seal(value, aad(orgId, key))
  await q.query(
    `INSERT INTO credentials (org_id, key, ciphertext, iv, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, key) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = now()`,
    [orgId, key, sealed.ciphertext, sealed.iv, userId],
  )
}

export async function getSecret(q: Queryable, box: SecretBox, orgId: string, key: string): Promise<string | null> {
  const [row] = await q.query<{ ciphertext: string; iv: string }>(
    'SELECT ciphertext, iv FROM credentials WHERE org_id = $1 AND key = $2',
    [orgId, key],
  )
  if (!row) return null
  return box.open(row, aad(orgId, key))
}

export async function hasSecret(q: Queryable, orgId: string, key: string): Promise<boolean> {
  const rows = await q.query('SELECT 1 FROM credentials WHERE org_id = $1 AND key = $2', [orgId, key])
  return rows.length > 0
}

export async function listSecrets(q: Queryable, orgId: string, prefix = ''): Promise<CredentialMeta[]> {
  const rows = await q.query<{ key: string; created_at: Date; updated_at: Date }>(
    `SELECT key, created_at, updated_at FROM credentials
     WHERE org_id = $1 AND starts_with(key, $2) ORDER BY key`,
    [orgId, prefix],
  )
  return rows.map((r) => ({ key: r.key, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }))
}

export async function deleteSecret(q: Queryable, orgId: string, key: string): Promise<boolean> {
  const rows = await q.query('DELETE FROM credentials WHERE org_id = $1 AND key = $2 RETURNING key', [orgId, key])
  return rows.length > 0
}

export async function deleteSecretsWithPrefix(q: Queryable, orgId: string, prefix: string): Promise<number> {
  const rows = await q.query(
    'DELETE FROM credentials WHERE org_id = $1 AND starts_with(key, $2) RETURNING key',
    [orgId, prefix],
  )
  return rows.length
}
