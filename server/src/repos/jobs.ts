// ─────────────────────────────────────────────────────────────────────────────
// Jobs (tenant table)
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { nextCronTime, type JobSpec, type Step, type Trigger } from '../engine/spec.js'

export interface Job extends JobSpec {
  id: string
  orgId: string
  nextRunAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

interface Row {
  id: string
  org_id: string
  name: string
  description: string
  trigger: Trigger
  steps: Step[]
  enabled: boolean
  next_run_at: Date | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null)
const COLS = 'id, org_id, name, description, trigger, steps, enabled, next_run_at, created_by, created_at, updated_at, archived_at'

function toJob(r: Row): Job {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    trigger: r.trigger,
    steps: r.steps,
    enabled: r.enabled,
    nextRunAt: iso(r.next_run_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.archived_at),
  }
}

/** When a cron job should next fire; null for other triggers or disabled jobs. */
export function computeNextRunAt(spec: Pick<JobSpec, 'trigger' | 'enabled'>, now: Date): Date | null {
  if (!spec.enabled || spec.trigger.kind !== 'cron') return null
  return nextCronTime(spec.trigger.expr, spec.trigger.tz, now)
}

export async function createJob(q: Queryable, orgId: string, userId: string | null, spec: JobSpec, now = new Date()): Promise<Job> {
  const [row] = await q.query<Row>(
    `INSERT INTO jobs (org_id, name, description, trigger, steps, enabled, next_run_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [orgId, spec.name, spec.description, JSON.stringify(spec.trigger), JSON.stringify(spec.steps), spec.enabled, computeNextRunAt(spec, now), userId],
  )
  return toJob(row!)
}

export async function updateJob(q: Queryable, orgId: string, id: string, spec: JobSpec, now = new Date()): Promise<Job | null> {
  const [row] = await q.query<Row>(
    `UPDATE jobs SET name = $3, description = $4, trigger = $5, steps = $6, enabled = $7, next_run_at = $8, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND archived_at IS NULL RETURNING ${COLS}`,
    [orgId, id, spec.name, spec.description, JSON.stringify(spec.trigger), JSON.stringify(spec.steps), spec.enabled, computeNextRunAt(spec, now)],
  )
  return row ? toJob(row) : null
}

export async function getJob(q: Queryable, orgId: string, id: string): Promise<Job | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM jobs WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toJob(row) : null
}

export async function listJobs(q: Queryable, orgId: string): Promise<Job[]> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM jobs WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId])
  return rows.map(toJob)
}

export async function archiveJob(q: Queryable, orgId: string, id: string): Promise<boolean> {
  const rows = await q.query(
    `UPDATE jobs SET archived_at = now(), enabled = false, next_run_at = NULL, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`,
    [orgId, id],
  )
  return rows.length > 0
}

/** Upcoming cron fires for the inbox. */
export async function listUpcoming(q: Queryable, orgId: string, limit = 10): Promise<Array<{ jobId: string; name: string; nextRunAt: string }>> {
  const rows = await q.query<{ id: string; name: string; next_run_at: Date }>(
    `SELECT id, name, next_run_at FROM jobs
     WHERE org_id = $1 AND enabled AND archived_at IS NULL AND next_run_at IS NOT NULL
     ORDER BY next_run_at LIMIT $2`,
    [orgId, limit],
  )
  return rows.map((r) => ({ jobId: r.id, name: r.name, nextRunAt: iso(r.next_run_at)! }))
}
