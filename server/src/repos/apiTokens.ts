// ─────────────────────────────────────────────────────────────────────────────
// API tokens (`rtk_…`): personal, org-scoped Bearer tokens for MCP clients and
// scripts. A token's effective role is the lower of its own role and its
// owner's current membership role, so removing a member disables their
// tokens. Run-scoped tokens are minted for agent steps and revoked after.
// Only the sha256 of a token is stored.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { newSecret, sha256 } from './runners.js'
import type { Role } from './identity.js'

export const API_TOKEN_PREFIX = 'rtk_'
export type TokenRole = Exclude<Role, 'owner'>

export interface ApiToken {
  id: string
  orgId: string
  userId: string
  userEmail?: string
  name: string
  role: TokenRole
  runId: string | null
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface Row {
  id: string
  org_id: string
  user_id: string
  user_email?: string
  name: string
  role: TokenRole
  run_id: string | null
  expires_at: Date | null
  last_used_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

const COLS = 't.id, t.org_id, t.user_id, t.name, t.role, t.run_id, t.expires_at, t.last_used_at, t.revoked_at, t.created_at'
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
const toToken = (r: Row): ApiToken => ({
  id: r.id,
  orgId: r.org_id,
  userId: r.user_id,
  ...(r.user_email ? { userEmail: r.user_email } : {}),
  name: r.name,
  role: r.role,
  runId: r.run_id,
  expiresAt: iso(r.expires_at),
  lastUsedAt: iso(r.last_used_at),
  revokedAt: iso(r.revoked_at),
  createdAt: iso(r.created_at)!,
})

export async function createApiToken(
  q: Queryable,
  orgId: string,
  userId: string,
  opts: { name: string; role: TokenRole; expiresAt?: Date | null; runId?: string | null },
): Promise<{ token: string; apiToken: ApiToken }> {
  const token = newSecret(API_TOKEN_PREFIX)
  const [row] = await q.query<Row>(
    `INSERT INTO api_tokens AS t (org_id, user_id, name, token_hash, role, run_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    [orgId, userId, opts.name, sha256(token), opts.role, opts.runId ?? null, opts.expiresAt ?? null],
  )
  return { token, apiToken: toToken(row!) }
}

/** System context: the live token for a secret (not revoked, not expired), or null. */
export async function resolveApiToken(q: Queryable, token: string): Promise<ApiToken | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null
  const [row] = await q.query<Row>(
    `SELECT ${COLS} FROM api_tokens t WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [sha256(token)],
  )
  if (!row) return null
  // Record use at most once a minute.
  await q.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [row.id])
  return toToken(row)
}

/** Personal tokens (not run-scoped). `all` = every member's (admins). */
export async function listApiTokens(q: Queryable, orgId: string, opts: { userId?: string } = {}): Promise<ApiToken[]> {
  const rows = await q.query<Row>(
    `SELECT ${COLS}, u.email AS user_email FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.org_id = $1 AND t.run_id IS NULL AND t.revoked_at IS NULL AND ($2::uuid IS NULL OR t.user_id = $2)
     ORDER BY t.created_at DESC`,
    [orgId, opts.userId ?? null],
  )
  return rows.map(toToken)
}

export async function getApiToken(q: Queryable, orgId: string, id: string): Promise<ApiToken | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM api_tokens t WHERE t.org_id = $1 AND t.id = $2`, [orgId, id])
  return row ? toToken(row) : null
}

export async function revokeApiToken(q: Queryable, orgId: string, id: string): Promise<boolean> {
  return (await q.query(`UPDATE api_tokens SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`, [orgId, id])).length > 0
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
/** The lower of two roles. */
export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * Who an agent's Routini tools act as: the person who started the run, else
 * the job's author, else an org owner. Must still be a member.
 */
export async function runActor(q: Queryable, orgId: string, run: { jobId: string; trigger: { kind: string; userId?: string } }): Promise<string | null> {
  const candidates: string[] = []
  if (run.trigger.kind === 'manual' && run.trigger.userId) candidates.push(run.trigger.userId)
  if (run.trigger.kind === 'mcp' && run.trigger.userId) candidates.push(run.trigger.userId)
  const [job] = await q.query<{ created_by: string | null }>('SELECT created_by FROM jobs WHERE org_id = $1 AND id = $2', [orgId, run.jobId])
  if (job?.created_by) candidates.push(job.created_by)
  for (const id of candidates) {
    const [m] = await q.query<{ role: Role }>('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, id])
    if (m && m.role !== 'viewer') return id
  }
  const [owner] = await q.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1`, [orgId])
  return owner?.user_id ?? null
}
