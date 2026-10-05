// ─────────────────────────────────────────────────────────────────────────────
// Runners (routini-runner on customers' servers), their one-time enrollment
// tokens, and the task queue between workers and the runner gateway.
//
// Tokens and credentials are random 32-byte values; only their sha256 is
// stored. Lookups by credential happen before the org is known, so they run in
// the system context.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '../db/index.js'
import { createRunnerHost } from './hosts.js'

export const ENROLL_PREFIX = 'rre_'
export const CREDENTIAL_PREFIX = 'rrc_'
export const ENROLL_TTL_MS = 60 * 60 * 1000

/** NOTIFY channels: dispatch to the gateway, and results back to workers. */
export const RUNNER_CHANNEL = 'routini_runner'
export const RUNNER_OUT_CHANNEL = 'routini_runner_out'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const newSecret = (prefix: string) => prefix + randomBytes(32).toString('base64url')

export interface Runner {
  id: string
  orgId: string
  hostId: string | null
  name: string
  version: string | null
  hostname: string | null
  os: string | null
  arch: string | null
  capabilities: string[]
  facts: Record<string, unknown> | null
  instance: string | null
  connectedAt: string | null
  lastSeenAt: string | null
  disconnectedAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface RunnerRow {
  id: string
  org_id: string
  host_id: string | null
  name: string
  version: string | null
  hostname: string | null
  os: string | null
  arch: string | null
  capabilities: string[]
  facts: Record<string, unknown> | null
  instance: string | null
  connected_at: Date | null
  last_seen_at: Date | null
  disconnected_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

const COLS = 'id, org_id, host_id, name, version, hostname, os, arch, capabilities, facts, instance, connected_at, last_seen_at, disconnected_at, revoked_at, created_at'
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
const toRunner = (r: RunnerRow): Runner => ({
  id: r.id,
  orgId: r.org_id,
  hostId: r.host_id,
  name: r.name,
  version: r.version,
  hostname: r.hostname,
  os: r.os,
  arch: r.arch,
  capabilities: r.capabilities,
  facts: r.facts,
  instance: r.instance,
  connectedAt: iso(r.connected_at),
  lastSeenAt: iso(r.last_seen_at),
  disconnectedAt: iso(r.disconnected_at),
  revokedAt: iso(r.revoked_at),
  createdAt: iso(r.created_at)!,
})

// ── Enrollment ────────────────────────────────────────────────────────────────

export interface Enrollment {
  token: string
  expiresAt: string
}

export async function createEnrollment(
  q: Queryable,
  orgId: string,
  userId: string,
  opts: { name?: string; group?: string; tags?: string[] },
): Promise<Enrollment> {
  const token = newSecret(ENROLL_PREFIX)
  const expiresAt = new Date(Date.now() + ENROLL_TTL_MS)
  await q.query(
    `INSERT INTO runner_enrollments (org_id, token_hash, name, host_group, tags, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, sha256(token), opts.name ?? null, opts.group ?? '', opts.tags ?? [], expiresAt, userId],
  )
  return { token, expiresAt: expiresAt.toISOString() }
}

export interface EnrollRequest {
  token: string
  name?: string
  hostname: string
  os: string
  arch: string
  version: string
}

export interface EnrollResult {
  runnerId: string
  credential: string
  hostId: string
  name: string
  orgId: string
}

/**
 * System context. Consumes the token (single use, unexpired) and creates the
 * runner and its host in the caller's transaction. Null for a bad token.
 */
export async function enrollRunner(q: Queryable, req: EnrollRequest): Promise<EnrollResult | null> {
  const [e] = await q.query<{ id: string; org_id: string; name: string | null; host_group: string; tags: string[]; created_by: string | null }>(
    `UPDATE runner_enrollments SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, org_id, name, host_group, tags, created_by`,
    [sha256(req.token)],
  )
  if (!e) return null
  const name = sanitizeName(req.name || e.name || req.hostname.split('.')[0] || 'server')
  const credential = newSecret(CREDENTIAL_PREFIX)
  const [r] = await q.query<{ id: string }>(
    `INSERT INTO runners (org_id, name, credential_hash, version, hostname, os, arch, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [e.org_id, name, sha256(credential), req.version, req.hostname, req.os, req.arch, e.created_by],
  )
  const hostId = await createRunnerHost(q, e.org_id, { name, group: e.host_group, address: req.hostname, tags: e.tags, runnerId: r!.id })
  const [h] = await q.query<{ name: string }>('SELECT name FROM hosts WHERE id = $1', [hostId])
  await q.query('UPDATE runners SET host_id = $2, name = $3 WHERE id = $1', [r!.id, hostId, h!.name])
  await q.query('UPDATE runner_enrollments SET runner_id = $2 WHERE id = $1', [e.id, r!.id])
  return { runnerId: r!.id, credential, hostId, name: h!.name, orgId: e.org_id }
}

/** Host names: letters, digits, ".", "_" and "-"; must start alphanumeric. */
export function sanitizeName(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 58)
  return s || 'server'
}

// ── Runners ───────────────────────────────────────────────────────────────────

/** System context: the runner a credential belongs to (revoked ones included). */
export async function getRunnerByCredential(q: Queryable, credential: string): Promise<Runner | null> {
  if (!credential.startsWith(CREDENTIAL_PREFIX)) return null
  const [row] = await q.query<RunnerRow>(`SELECT ${COLS} FROM runners WHERE credential_hash = $1`, [sha256(credential)])
  return row ? toRunner(row) : null
}

export async function getRunner(q: Queryable, orgId: string, id: string): Promise<Runner | null> {
  const [row] = await q.query<RunnerRow>(`SELECT ${COLS} FROM runners WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toRunner(row) : null
}

export async function listRunners(q: Queryable, orgId: string): Promise<Runner[]> {
  const rows = await q.query<RunnerRow>(`SELECT ${COLS} FROM runners WHERE org_id = $1 AND revoked_at IS NULL ORDER BY name`, [orgId])
  return rows.map(toRunner)
}

export async function markRunnerConnected(
  q: Queryable,
  orgId: string,
  id: string,
  hello: { version: string; hostname: string; os: string; arch: string; capabilities: string[]; facts: Record<string, unknown> | null },
  instance: string,
): Promise<void> {
  await q.query(
    `UPDATE runners SET version = $3, hostname = $4, os = $5, arch = $6, capabilities = $7, facts = COALESCE($8, facts),
       instance = $9, connected_at = now(), last_seen_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, hello.version, hello.hostname, hello.os, hello.arch, hello.capabilities, hello.facts ? JSON.stringify(hello.facts) : null, instance],
  )
}

export async function recordRunnerFacts(q: Queryable, orgId: string, id: string, facts: Record<string, unknown>): Promise<void> {
  await q.query('UPDATE runners SET facts = $3, last_seen_at = now() WHERE org_id = $1 AND id = $2', [orgId, id, JSON.stringify(facts)])
}

export async function touchRunner(q: Queryable, orgId: string, id: string): Promise<void> {
  await q.query('UPDATE runners SET last_seen_at = now() WHERE org_id = $1 AND id = $2', [orgId, id])
}

/** Marks a disconnect, unless a newer connection (other instance) has taken over. */
export async function markRunnerDisconnected(q: Queryable, orgId: string, id: string, instance: string): Promise<boolean> {
  const rows = await q.query('UPDATE runners SET disconnected_at = now() WHERE org_id = $1 AND id = $2 AND instance = $3 RETURNING id', [orgId, id, instance])
  return rows.length > 0
}

export async function revokeRunner(q: Queryable, orgId: string, id: string): Promise<Runner | null> {
  const [row] = await q.query<RunnerRow>(`UPDATE runners SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING ${COLS}`, [orgId, id])
  return row ? toRunner(row) : null
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export type RunnerTaskStatus = 'queued' | 'sent' | 'done' | 'failed' | 'canceled'

export interface ExecPayload {
  type: 'exec'
  command: string
  env?: Record<string, string>
  cwd?: string | null
  timeoutSec: number
}

export interface ExecResultData {
  exitCode: number | null
  timedOut: boolean
  canceled: boolean
  error: string | null
}

export interface RunnerTask {
  id: string
  orgId: string
  runnerId: string
  runId: string | null
  stepIdx: number | null
  payload: ExecPayload
  status: RunnerTaskStatus
  cancelRequested: boolean
  result: ExecResultData | null
  claimedBy: string | null
}

interface TaskRow {
  id: string
  org_id: string
  runner_id: string
  run_id: string | null
  step_idx: number | null
  payload: ExecPayload
  status: RunnerTaskStatus
  cancel_requested: boolean
  result: ExecResultData | null
  claimed_by: string | null
}
const TASK_COLS = 'id, org_id, runner_id, run_id, step_idx, payload, status, cancel_requested, result, claimed_by'
const toTask = (r: TaskRow): RunnerTask => ({
  id: r.id,
  orgId: r.org_id,
  runnerId: r.runner_id,
  runId: r.run_id,
  stepIdx: r.step_idx,
  payload: r.payload,
  status: r.status,
  cancelRequested: r.cancel_requested,
  result: r.result,
  claimedBy: r.claimed_by,
})

export async function createRunnerTask(
  q: Queryable,
  orgId: string,
  runnerId: string,
  payload: ExecPayload,
  link: { runId?: string; stepIdx?: number } = {},
): Promise<RunnerTask> {
  const [row] = await q.query<TaskRow>(
    `INSERT INTO runner_tasks (org_id, runner_id, run_id, step_idx, payload) VALUES ($1, $2, $3, $4, $5) RETURNING ${TASK_COLS}`,
    [orgId, runnerId, link.runId ?? null, link.stepIdx ?? null, JSON.stringify(payload)],
  )
  const task = toTask(row!)
  await q.query('SELECT pg_notify($1, $2)', [RUNNER_CHANNEL, JSON.stringify({ op: 'start', taskId: task.id, runnerId })])
  return task
}

export async function getRunnerTask(q: Queryable, orgId: string, id: string): Promise<RunnerTask | null> {
  const [row] = await q.query<TaskRow>(`SELECT ${TASK_COLS} FROM runner_tasks WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toTask(row) : null
}

/** The gateway claims a queued task for a runner it holds. */
export async function claimRunnerTask(q: Queryable, orgId: string, id: string, instance: string): Promise<RunnerTask | null> {
  const [row] = await q.query<TaskRow>(
    `UPDATE runner_tasks SET status = 'sent', claimed_by = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'queued' RETURNING ${TASK_COLS}`,
    [orgId, id, instance],
  )
  return row ? toTask(row) : null
}

/** Queued tasks for a runner (the gateway catches up when a runner connects). */
export async function queuedTasksFor(q: Queryable, orgId: string, runnerId: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(`SELECT id FROM runner_tasks WHERE org_id = $1 AND runner_id = $2 AND status = 'queued' ORDER BY created_at`, [orgId, runnerId])
  return rows.map((r) => r.id)
}

export async function finishRunnerTask(q: Queryable, orgId: string, id: string, status: 'done' | 'failed' | 'canceled', result: ExecResultData): Promise<boolean> {
  const rows = await q.query(
    `UPDATE runner_tasks SET status = $3, result = $4, updated_at = now() WHERE org_id = $1 AND id = $2 AND status IN ('queued', 'sent') RETURNING id`,
    [orgId, id, status, JSON.stringify(result)],
  )
  if (rows.length) await q.query('SELECT pg_notify($1, $2)', [RUNNER_OUT_CHANNEL, JSON.stringify({ taskId: id, done: true })])
  return rows.length > 0
}

export async function requestTaskCancel(q: Queryable, orgId: string, id: string, runnerId: string): Promise<void> {
  await q.query(`UPDATE runner_tasks SET cancel_requested = true, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, id])
  await q.query('SELECT pg_notify($1, $2)', [RUNNER_CHANNEL, JSON.stringify({ op: 'cancel', taskId: id, runnerId })])
}

/** In-flight tasks this instance sent to a runner (failed when the runner drops). */
export async function sentTasksFor(q: Queryable, orgId: string, runnerId: string, instance: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM runner_tasks WHERE org_id = $1 AND runner_id = $2 AND status = 'sent' AND claimed_by = $3`,
    [orgId, runnerId, instance],
  )
  return rows.map((r) => r.id)
}

/** A step was lost with its worker: cancel whatever it had queued or running on runners. */
export async function cancelStepRunnerTasks(q: Queryable, orgId: string, runId: string, stepIdx: number): Promise<number> {
  const rows = await q.query<{ id: string; runner_id: string; status: RunnerTaskStatus }>(
    `SELECT id, runner_id, status FROM runner_tasks WHERE org_id = $1 AND run_id = $2 AND step_idx = $3 AND status IN ('queued', 'sent')`,
    [orgId, runId, stepIdx],
  )
  for (const t of rows) {
    if (t.status === 'queued') await finishRunnerTask(q, orgId, t.id, 'canceled', { exitCode: null, timedOut: false, canceled: true, error: null })
    else await requestTaskCancel(q, orgId, t.id, t.runner_id)
  }
  return rows.length
}
