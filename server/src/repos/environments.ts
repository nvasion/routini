// ─────────────────────────────────────────────────────────────────────────────
// Environments and their audit trail (tenant tables)
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'

export type EnvStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'deleting'

export interface Environment {
  id: string
  orgId: string
  name: string
  image: string
  repo: { url: string; branch: string; dir: string } | null
  /** The fleet host (routini-runner) this environment's container runs on; null runs on Routini's own Docker host. */
  hostId: string | null
  status: EnvStatus
  statusDetail: string | null
  containerId: string | null
  volume: string
  cpus: number
  memoryMb: number
  idleMinutes: number
  lastActiveAt: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  /** Egress session token while running under the credential broker (never sent to clients). */
  egressToken: string | null
}

interface Row {
  id: string
  org_id: string
  name: string
  image: string
  repo: Environment['repo']
  host_id: string | null
  status: EnvStatus
  status_detail: string | null
  container_id: string | null
  volume: string
  cpus: string | number
  memory_mb: number
  idle_minutes: number
  last_active_at: Date
  created_by: string | null
  created_at: Date
  updated_at: Date
  egress_token: string | null
}

const COLS =
  'id, org_id, name, image, repo, host_id, status, status_detail, container_id, volume, cpus, memory_mb, idle_minutes, last_active_at, created_by, created_at, updated_at, egress_token'
const iso = (v: Date) => new Date(v).toISOString()
const toEnv = (r: Row): Environment => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  image: r.image,
  repo: r.repo,
  hostId: r.host_id,
  status: r.status,
  statusDetail: r.status_detail,
  containerId: r.container_id,
  volume: r.volume,
  cpus: Number(r.cpus),
  memoryMb: r.memory_mb,
  idleMinutes: r.idle_minutes,
  lastActiveAt: iso(r.last_active_at),
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  egressToken: r.egress_token,
})

export async function insertEnvironment(
  q: Queryable,
  e: {
    orgId: string
    name: string
    image: string
    repo: Environment['repo']
    hostId: string | null
    volume: string
    cpus: number
    memoryMb: number
    idleMinutes: number
    createdBy: string | null
  },
): Promise<Environment> {
  const [row] = await q.query<Row>(
    `INSERT INTO environments (org_id, name, image, repo, host_id, status, volume, cpus, memory_mb, idle_minutes, created_by)
     VALUES ($1, $2, $3, $4, $5, 'starting', $6, $7, $8, $9, $10) RETURNING ${COLS}`,
    [e.orgId, e.name, e.image, e.repo ? JSON.stringify(e.repo) : null, e.hostId, e.volume, e.cpus, e.memoryMb, e.idleMinutes, e.createdBy],
  )
  return toEnv(row!)
}

/** Environment names that reference a host, for the delete guard in routes/hosts.ts. */
export async function listEnvironmentNamesForHost(q: Queryable, orgId: string, hostId: string): Promise<string[]> {
  const rows = await q.query<{ name: string }>('SELECT name FROM environments WHERE org_id = $1 AND host_id = $2 ORDER BY name', [orgId, hostId])
  return rows.map((r) => r.name)
}

export async function getEnvironment(q: Queryable, orgId: string, id: string): Promise<Environment | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM environments WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toEnv(row) : null
}

export async function listEnvironments(q: Queryable, orgId: string): Promise<Environment[]> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM environments WHERE org_id = $1 AND status <> 'deleting' ORDER BY name`, [orgId])
  return rows.map(toEnv)
}

/** System context: environments the sweeper must look at. */
export async function listActiveEnvironmentsSystem(q: Queryable): Promise<Environment[]> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM environments WHERE status IN ('starting', 'running', 'stopping')`)
  return rows.map(toEnv)
}

export async function setEnvironmentState(
  q: Queryable,
  orgId: string,
  id: string,
  patch: { status: EnvStatus; detail?: string | null; containerId?: string | null },
): Promise<void> {
  await q.query(
    `UPDATE environments SET status = $3,
       status_detail = $4,
       container_id = CASE WHEN $5::boolean THEN $6 ELSE container_id END,
       updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, patch.status, patch.detail ?? null, patch.containerId !== undefined, patch.containerId ?? null],
  )
}

export async function updateEnvironmentSettings(q: Queryable, orgId: string, id: string, patch: { name?: string; idleMinutes?: number }): Promise<Environment | null> {
  const [row] = await q.query<Row>(
    `UPDATE environments SET name = coalesce($3, name), idle_minutes = coalesce($4, idle_minutes), updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
    [orgId, id, patch.name ?? null, patch.idleMinutes ?? null],
  )
  return row ? toEnv(row) : null
}

export async function touchEnvironment(q: Queryable, orgId: string, id: string): Promise<void> {
  await q.query('UPDATE environments SET last_active_at = now() WHERE org_id = $1 AND id = $2', [orgId, id])
}

export async function deleteEnvironmentRow(q: Queryable, orgId: string, id: string): Promise<void> {
  await q.query('DELETE FROM environments WHERE org_id = $1 AND id = $2', [orgId, id])
}

export async function countRunningEnvironments(q: Queryable, orgId: string, excludeId?: string): Promise<number> {
  const [row] = await q.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM environments WHERE org_id = $1 AND status IN ('starting', 'running') AND ($2::uuid IS NULL OR id <> $2)`,
    [orgId, excludeId ?? null],
  )
  return Number(row?.n ?? 0)
}

export interface EnvEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  data: Record<string, unknown>
}

export async function addEnvironmentEvent(
  q: Queryable,
  orgId: string,
  envId: string,
  type: string,
  userId: string | null = null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    'INSERT INTO environment_events (org_id, environment_id, type, user_id, data) VALUES ($1, $2, $3, $4, $5)',
    [orgId, envId, type, userId, JSON.stringify(data)],
  )
}

export async function listEnvironmentEvents(q: Queryable, orgId: string, envId: string, limit = 50): Promise<EnvEvent[]> {
  const rows = await q.query<{ id: string | number; ts: Date; type: string; user_id: string | null; data: Record<string, unknown> }>(
    `SELECT id, ts, type, user_id, data FROM environment_events WHERE org_id = $1 AND environment_id = $2 ORDER BY id DESC LIMIT $3`,
    [orgId, envId, limit],
  )
  return rows.map((r) => ({ id: Number(r.id), ts: iso(r.ts), type: r.type, userId: r.user_id, data: r.data }))
}

export async function setEnvironmentEgressToken(q: Queryable, orgId: string, id: string, token: string | null): Promise<void> {
  await q.query('UPDATE environments SET egress_token = $3 WHERE org_id = $1 AND id = $2', [orgId, id, token])
}
