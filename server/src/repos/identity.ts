// ─────────────────────────────────────────────────────────────────────────────
// Users, orgs, memberships and revoked tokens (global tables, no RLS)
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']
const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

/** True when `role` is at least `min` (owner > admin > member > viewer). */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

export interface User {
  id: string
  email: string
  displayName: string
  createdAt: string
}

export interface UserWithHash extends User {
  passwordHash: string | null
}

export interface OrgLimits {
  maxConcurrentRuns: number
  /** Environments that may be running at once. */
  maxRunningEnvironments: number
  /** Minutes of agent-container time per UTC day; null = unlimited. */
  agentMinutesPerDay: number | null
  /** Model spend per UTC day in USD; null = no cap (bring-your-own keys). */
  dailyBudgetUsd: number | null
}

export interface Org {
  id: string
  slug: string
  name: string
  plan: string
  limits: OrgLimits
  createdAt: string
  /** TynHub org slug whose members join this org when they sign in with TynHub. */
  tynhubOrg: string | null
}

export interface OrgMembership {
  org: Org
  role: Role
}

/** Plan defaults. Per-org overrides in orgs.limits may only tighten these. */
export const PLAN_LIMITS: Record<string, OrgLimits> = {
  free: { maxConcurrentRuns: 2, maxRunningEnvironments: 1, agentMinutesPerDay: 120, dailyBudgetUsd: null },
  selfhost: { maxConcurrentRuns: 10, maxRunningEnvironments: 10, agentMinutesPerDay: null, dailyBudgetUsd: null },
}

interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string | null
  created_at: Date | string
}

interface OrgRow {
  id: string
  slug: string
  name: string
  plan: string
  limits: Partial<OrgLimits> | null
  created_at: Date | string
  tynhub_org: string | null
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

function toUser(r: UserRow): UserWithHash {
  return { id: r.id, email: r.email, displayName: r.display_name, passwordHash: r.password_hash, createdAt: iso(r.created_at) }
}

export function effectiveLimits(plan: string, overrides: Partial<OrgLimits> | null | undefined): OrgLimits {
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS['free']!
  const o = overrides ?? {}
  const tighten = (b: number | null, v: number | null | undefined): number | null => {
    if (v === undefined || v === null) return b
    return b === null ? v : Math.min(b, v)
  }
  return {
    maxConcurrentRuns: tighten(base.maxConcurrentRuns, o.maxConcurrentRuns) ?? base.maxConcurrentRuns,
    maxRunningEnvironments: tighten(base.maxRunningEnvironments, o.maxRunningEnvironments) ?? base.maxRunningEnvironments,
    agentMinutesPerDay: tighten(base.agentMinutesPerDay, o.agentMinutesPerDay),
    dailyBudgetUsd: tighten(base.dailyBudgetUsd, o.dailyBudgetUsd),
  }
}

function toOrg(r: OrgRow): Org {
  return { id: r.id, slug: r.slug, name: r.name, plan: r.plan, limits: effectiveLimits(r.plan, r.limits), createdAt: iso(r.created_at), tynhubOrg: r.tynhub_org }
}

const USER_COLS = 'id, email, display_name, password_hash, created_at'
const ORG_COLS = 'id, slug, name, plan, limits, created_at, tynhub_org'

// ── Users ────────────────────────────────────────────────────────────────────

export async function countUsers(q: Queryable): Promise<number> {
  const [row] = await q.query<{ n: string | number }>('SELECT count(*) AS n FROM users')
  return Number(row?.n ?? 0)
}

export async function createUser(
  q: Queryable,
  input: { email: string; passwordHash: string | null; displayName?: string },
): Promise<UserWithHash> {
  const [row] = await q.query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING ${USER_COLS}`,
    [input.email.trim(), input.passwordHash, input.displayName?.trim() ?? ''],
  )
  return toUser(row!)
}

export async function findUserByEmail(q: Queryable, email: string): Promise<UserWithHash | null> {
  const [row] = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE lower(email) = lower($1)`, [email.trim()])
  return row ? toUser(row) : null
}

export async function findUserById(q: Queryable, id: string): Promise<UserWithHash | null> {
  const [row] = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])
  return row ? toUser(row) : null
}

export async function setPasswordHash(q: Queryable, userId: string, hash: string): Promise<void> {
  await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash])
}

export async function addIdentity(q: Queryable, userId: string, provider: string, subject: string): Promise<void> {
  await q.query(
    'INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [provider, subject, userId],
  )
}

export function publicUser(u: UserWithHash): User {
  return { id: u.id, email: u.email, displayName: u.displayName, createdAt: u.createdAt }
}

// ── Orgs ─────────────────────────────────────────────────────────────────────

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || 'org'
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)
}

/** Creates an org with a unique slug derived from `slugBase` (suffixing -2, -3… on collision). */
export async function createOrg(
  q: Queryable,
  input: { name: string; slugBase: string; plan: string },
): Promise<Org> {
  const base = slugify(input.slugBase)
  for (let i = 1; i <= 50; i++) {
    const suffix = i === 1 ? '' : `-${i}`
    const slug = base.slice(0, 40 - suffix.length).replace(/-+$/g, '') + suffix
    const [row] = await q.query<OrgRow>(
      `INSERT INTO orgs (slug, name, plan) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING RETURNING ${ORG_COLS}`,
      [slug, input.name.trim(), input.plan],
    )
    if (row) return toOrg(row)
  }
  throw new Error('Could not allocate a unique org slug')
}

export async function getOrgBySlug(q: Queryable, slug: string): Promise<Org | null> {
  const [row] = await q.query<OrgRow>(`SELECT ${ORG_COLS} FROM orgs WHERE slug = $1`, [slug])
  return row ? toOrg(row) : null
}

export async function getOrgById(q: Queryable, id: string): Promise<Org | null> {
  const [row] = await q.query<OrgRow>(`SELECT ${ORG_COLS} FROM orgs WHERE id = $1`, [id])
  return row ? toOrg(row) : null
}

export async function updateOrg(
  q: Queryable,
  id: string,
  patch: { name?: string; limits?: Partial<OrgLimits> },
): Promise<Org | null> {
  const [row] = await q.query<OrgRow>(
    `UPDATE orgs SET name = coalesce($2, name), limits = coalesce($3::jsonb, limits)
     WHERE id = $1 RETURNING ${ORG_COLS}`,
    [id, patch.name?.trim() ?? null, patch.limits ? JSON.stringify(patch.limits) : null],
  )
  return row ? toOrg(row) : null
}

// ── Memberships ──────────────────────────────────────────────────────────────

export async function addMembership(q: Queryable, orgId: string, userId: string, role: Role): Promise<void> {
  await q.query(
    `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`,
    [orgId, userId, role],
  )
}

export async function removeMembership(q: Queryable, orgId: string, userId: string): Promise<boolean> {
  const rows = await q.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2 RETURNING user_id', [orgId, userId])
  return rows.length > 0
}

export async function getMembershipRole(q: Queryable, orgId: string, userId: string): Promise<Role | null> {
  const [row] = await q.query<{ role: Role }>('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId])
  return row?.role ?? null
}

export async function countOwners(q: Queryable, orgId: string): Promise<number> {
  const [row] = await q.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  )
  return Number(row?.n ?? 0)
}

export async function listOrgsForUser(q: Queryable, userId: string): Promise<OrgMembership[]> {
  const rows = await q.query<OrgRow & { role: Role }>(
    `SELECT o.id, o.slug, o.name, o.plan, o.limits, o.created_at, m.role
     FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = $1 ORDER BY o.created_at`,
    [userId],
  )
  return rows.map((r) => ({ org: toOrg(r), role: r.role }))
}

export async function listMembers(q: Queryable, orgId: string): Promise<Array<User & { role: Role }>> {
  const rows = await q.query<UserRow & { role: Role }>(
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, m.role
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 ORDER BY m.created_at`,
    [orgId],
  )
  return rows.map((r) => ({ ...publicUser(toUser(r)), role: r.role }))
}

// ── Revoked tokens ───────────────────────────────────────────────────────────

export async function revokeToken(q: Queryable, jti: string, expiresAt: Date): Promise<void> {
  await q.query('INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [jti, expiresAt])
}

export async function isTokenRevoked(q: Queryable, jti: string): Promise<boolean> {
  const rows = await q.query('SELECT 1 FROM revoked_tokens WHERE jti = $1', [jti])
  return rows.length > 0
}

export async function pruneRevokedTokens(q: Queryable): Promise<number> {
  const rows = await q.query('DELETE FROM revoked_tokens WHERE expires_at < now() RETURNING jti')
  return rows.length
}

// ── External identities (OIDC) and TynHub org links ──────────────────────────

export async function findUserByIdentity(q: Queryable, provider: string, subject: string): Promise<UserWithHash | null> {
  const [row] = await q.query<UserRow>(
    `SELECT u.${USER_COLS.split(', ').join(', u.')} FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2`,
    [provider, subject],
  )
  return row ? toUser(row) : null
}

export async function listIdentities(q: Queryable, userId: string): Promise<Array<{ provider: string; subject: string; createdAt: string }>> {
  const rows = await q.query<{ provider: string; subject: string; created_at: Date }>('SELECT provider, subject, created_at FROM identities WHERE user_id = $1 ORDER BY created_at', [userId])
  return rows.map((r) => ({ provider: r.provider, subject: r.subject, createdAt: iso(r.created_at) }))
}

/** Orgs linked to any of these TynHub org slugs. */
export async function orgsLinkedToTynhub(q: Queryable, slugs: string[]): Promise<Org[]> {
  if (!slugs.length) return []
  const rows = await q.query<OrgRow>(`SELECT ${ORG_COLS} FROM orgs WHERE tynhub_org = ANY($1)`, [slugs])
  return rows.map(toOrg)
}

export async function setTynhubOrg(q: Queryable, orgId: string, slug: string | null): Promise<Org | null> {
  const [row] = await q.query<OrgRow>(`UPDATE orgs SET tynhub_org = $2 WHERE id = $1 RETURNING ${ORG_COLS}`, [orgId, slug])
  return row ? toOrg(row) : null
}
