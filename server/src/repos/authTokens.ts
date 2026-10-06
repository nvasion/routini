// ─────────────────────────────────────────────────────────────────────────────
// One-time account tokens: password reset and email verification (global
// table, no RLS). The raw token only ever travels in an emailed link; the
// database keeps its SHA-256, so a leaked table can't be replayed.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '../db/index.js'

export type AuthTokenPurpose = 'reset' | 'verify'

/** Minutes a token stays valid. */
export const AUTH_TOKEN_TTL_MIN: Record<AuthTokenPurpose, number> = { reset: 30, verify: 24 * 60 }

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export async function issueAuthToken(q: Queryable, userId: string, purpose: AuthTokenPurpose): Promise<string> {
  const raw = randomBytes(32).toString('base64url')
  await q.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))`,
    [userId, purpose, hashToken(raw), AUTH_TOKEN_TTL_MIN[purpose]],
  )
  return raw
}

/** Spends a token. Returns its user, or null when it is unknown, used, expired or for another purpose. */
export async function consumeAuthToken(q: Queryable, raw: string, purpose: AuthTokenPurpose): Promise<string | null> {
  const [row] = await q.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(raw), purpose],
  )
  return row?.user_id ?? null
}

/** Spends every outstanding token of one purpose (after a reset, older links stop working). */
export async function invalidateAuthTokens(q: Queryable, userId: string, purpose: AuthTokenPurpose): Promise<void> {
  await q.query('UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose])
}

/** Tokens issued in the last `minutes`: the per-account rate limit on emails. */
export async function countRecentAuthTokens(q: Queryable, userId: string, purpose: AuthTokenPurpose, minutes: number): Promise<number> {
  const [row] = await q.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM auth_tokens
     WHERE user_id = $1 AND purpose = $2 AND created_at > now() - make_interval(mins => $3::int)`,
    [userId, purpose, minutes],
  )
  return Number(row?.n ?? 0)
}
