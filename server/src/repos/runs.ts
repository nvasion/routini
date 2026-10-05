// ─────────────────────────────────────────────────────────────────────────────
// Runs, run steps, run events, approvals, and the run queue (tenant tables)
//
// Every state change appends a run_event and NOTIFYs `routini_events` in the
// same transaction, so listeners (SSE, other processes) see it exactly when
// it commits. Queue inserts NOTIFY `routini_queue` to wake idle workers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { Job } from './jobs.js'
import type { Step } from '../engine/spec.js'
import type { Role } from './identity.js'
import type { NormalizedAlert } from '../engine/alerts.js'

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled'
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'canceled'
export const TERMINAL_RUN: readonly RunStatus[] = ['succeeded', 'failed', 'canceled']

export type RunTrigger =
  | { kind: 'manual'; userId: string }
  | { kind: 'cron'; scheduledFor: string }
  | { kind: 'webhook'; payload?: unknown }
  | { kind: 'retry'; previousRunId: string }
  | { kind: 'alert'; incidentId: string; incidentNumber: number; alert: NormalizedAlert; hostId: string | null }

export interface Run {
  id: string
  orgId: string
  jobId: string
  number: number
  status: RunStatus
  trigger: RunTrigger
  jobSnapshot: { name: string; steps: Step[] }
  costUsd: number
  agentSeconds: number
  error: string | null
  cancelRequested: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface RunStep {
  idx: number
  stepId: string
  name: string
  kind: Step['kind']
  status: StepStatus
  attempt: number
  output: unknown
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  /** A policy approval for this step was granted; run it without re-gating. */
  policyCleared: boolean
}

export interface RunEvent {
  id: number
  runId: string
  stepIdx: number | null
  ts: string
  type: string
  data: Record<string, unknown>
}

export interface Approval {
  id: string
  runId: string
  stepIdx: number
  status: 'pending' | 'approved' | 'denied' | 'canceled'
  message: string
  minRole: Role
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  comment: string | null
  /** "step": an approval step; "policy": a policy rule gating another step. */
  source: "step" | "policy"
  rule: string | null
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null)

interface RunRow {
  id: string
  org_id: string
  job_id: string
  number: number
  status: RunStatus
  trigger: RunTrigger
  job_snapshot: Run['jobSnapshot']
  cost_usd: string | number
  agent_seconds: number
  error: string | null
  cancel_requested: boolean
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
  updated_at: Date
}
const RUN_COLS =
  'id, org_id, job_id, number, status, trigger, job_snapshot, cost_usd, agent_seconds, error, cancel_requested, created_at, started_at, finished_at, updated_at'

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    orgId: r.org_id,
    jobId: r.job_id,
    number: r.number,
    status: r.status,
    trigger: r.trigger,
    jobSnapshot: r.job_snapshot,
    costUsd: Number(r.cost_usd),
    agentSeconds: r.agent_seconds,
    error: r.error,
    cancelRequested: r.cancel_requested,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: iso(r.updated_at)!,
  }
}

interface StepRow {
  idx: number
  step_id: string
  name: string
  kind: Step['kind']
  status: StepStatus
  attempt: number
  output: unknown
  error: string | null
  started_at: Date | null
  finished_at: Date | null
  policy_cleared: boolean
}
const STEP_COLS = 'idx, step_id, name, kind, status, attempt, output, error, started_at, finished_at, policy_cleared'
const toStep = (r: StepRow): RunStep => ({
  idx: r.idx,
  stepId: r.step_id,
  name: r.name,
  kind: r.kind,
  status: r.status,
  attempt: r.attempt,
  output: r.output,
  error: r.error,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  policyCleared: r.policy_cleared,
})

interface ApprovalRow {
  id: string
  run_id: string
  step_idx: number
  status: Approval['status']
  message: string
  min_role: Role
  requested_at: Date
  decided_by: string | null
  decided_at: Date | null
  comment: string | null
  source: "step" | "policy"
  rule: string | null
}
const APPROVAL_COLS = 'id, run_id, step_idx, status, message, min_role, requested_at, decided_by, decided_at, comment, source, rule'
const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  runId: r.run_id,
  stepIdx: r.step_idx,
  status: r.status,
  message: r.message,
  minRole: r.min_role,
  requestedAt: iso(r.requested_at)!,
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  comment: r.comment,
  source: r.source,
  rule: r.rule,
})

// ── Events ───────────────────────────────────────────────────────────────────

export const EVENTS_CHANNEL = 'routini_events'
export const QUEUE_CHANNEL = 'routini_queue'

/** Payload of a routini_events notification (kept small; listeners fetch details). */
export interface EventNotice {
  o: string // org id
  r: string // run id
  e: number // event id
  t: string // event type
}

export async function appendEvent(
  q: Queryable,
  orgId: string,
  runId: string,
  type: string,
  data: Record<string, unknown> = {},
  stepIdx: number | null = null,
): Promise<number> {
  const [row] = await q.query<{ id: string | number }>(
    `INSERT INTO run_events (org_id, run_id, step_idx, type, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, runId, stepIdx, type, JSON.stringify(data)],
  )
  const id = Number(row!.id)
  const notice: EventNotice = { o: orgId, r: runId, e: id, t: type }
  await q.query(`SELECT pg_notify($1, $2)`, [EVENTS_CHANNEL, JSON.stringify(notice)])
  return id
}

export async function listEvents(q: Queryable, orgId: string, runId: string, afterId = 0, limit = 500): Promise<RunEvent[]> {
  const rows = await q.query<{ id: string | number; run_id: string; step_idx: number | null; ts: Date; type: string; data: Record<string, unknown> }>(
    `SELECT id, run_id, step_idx, ts, type, data FROM run_events
     WHERE org_id = $1 AND run_id = $2 AND id > $3 ORDER BY id LIMIT $4`,
    [orgId, runId, afterId, limit],
  )
  return rows.map((r) => ({ id: Number(r.id), runId: r.run_id, stepIdx: r.step_idx, ts: iso(r.ts)!, type: r.type, data: r.data }))
}

// ── Queue ────────────────────────────────────────────────────────────────────

export async function enqueueRun(q: Queryable, orgId: string, runId: string, delayMs = 0): Promise<void> {
  await q.query(
    `INSERT INTO queue (org_id, run_id, available_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (run_id) DO UPDATE SET available_at = excluded.available_at, locked_by = NULL, locked_until = NULL, attempts = 0`,
    [orgId, runId, delayMs / 1000],
  )
  await q.query(`SELECT pg_notify($1, $2)`, [QUEUE_CHANNEL, runId])
}

export async function dequeueRun(q: Queryable, runId: string): Promise<void> {
  await q.query('DELETE FROM queue WHERE run_id = $1', [runId])
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Creates a queued run of `job` with one pending step per job step, and enqueues it. */
export async function createRun(q: Queryable, job: Job, trigger: RunTrigger): Promise<Run> {
  const [counter] = await q.query<{ value: number }>(
    `INSERT INTO run_counters (org_id, value) VALUES ($1, 1)
     ON CONFLICT (org_id) DO UPDATE SET value = run_counters.value + 1 RETURNING value`,
    [job.orgId],
  )
  const snapshot = { name: job.name, steps: job.steps }
  const [row] = await q.query<RunRow>(
    `INSERT INTO runs (org_id, job_id, number, status, trigger, job_snapshot) VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING ${RUN_COLS}`,
    [job.orgId, job.id, counter!.value, JSON.stringify(trigger), JSON.stringify(snapshot)],
  )
  const run = toRun(row!)
  for (const [idx, s] of job.steps.entries()) {
    await q.query(
      `INSERT INTO run_steps (run_id, org_id, idx, step_id, name, kind, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [run.id, run.orgId, idx, s.id, s.name, s.kind],
    )
  }
  await appendEvent(q, run.orgId, run.id, 'status', { status: 'queued', trigger: trigger.kind })
  await enqueueRun(q, run.orgId, run.id)
  return run
}

export async function getRun(q: Queryable, orgId: string, runId: string): Promise<Run | null> {
  const [row] = await q.query<RunRow>(`SELECT ${RUN_COLS} FROM runs WHERE org_id = $1 AND id = $2`, [orgId, runId])
  return row ? toRun(row) : null
}

export async function getRunByNumber(q: Queryable, orgId: string, number: number): Promise<Run | null> {
  const [row] = await q.query<RunRow>(`SELECT ${RUN_COLS} FROM runs WHERE org_id = $1 AND number = $2`, [orgId, number])
  return row ? toRun(row) : null
}

/** System context: locate a run's org (the worker only knows run ids). */
export async function getRunSystem(q: Queryable, runId: string): Promise<Run | null> {
  const [row] = await q.query<RunRow>(`SELECT ${RUN_COLS} FROM runs WHERE id = $1`, [runId])
  return row ? toRun(row) : null
}

export async function listRuns(
  q: Queryable,
  orgId: string,
  f: { jobId?: string; status?: RunStatus[]; beforeNumber?: number; limit?: number } = {},
): Promise<Run[]> {
  const rows = await q.query<RunRow>(
    `SELECT ${RUN_COLS} FROM runs
     WHERE org_id = $1
       AND ($2::uuid IS NULL OR job_id = $2)
       AND ($3::text[] IS NULL OR status = ANY($3))
       AND ($4::int IS NULL OR number < $4)
     ORDER BY number DESC LIMIT $5`,
    [orgId, f.jobId ?? null, f.status ?? null, f.beforeNumber ?? null, Math.min(f.limit ?? 50, 200)],
  )
  return rows.map(toRun)
}

export async function listRecentFailures(q: Queryable, orgId: string, sinceHours = 24): Promise<Run[]> {
  const rows = await q.query<RunRow>(
    `SELECT ${RUN_COLS} FROM runs WHERE org_id = $1 AND status = 'failed' AND finished_at > now() - make_interval(hours => $2)
     ORDER BY finished_at DESC LIMIT 50`,
    [orgId, sinceHours],
  )
  return rows.map(toRun)
}

export async function setRunStatus(
  q: Queryable,
  run: Pick<Run, 'id' | 'orgId'>,
  status: RunStatus,
  extra: { error?: string | null } = {},
): Promise<void> {
  await q.query(
    `UPDATE runs SET status = $3,
       error = CASE WHEN $4::boolean THEN $5 ELSE error END,
       started_at = CASE WHEN $3 = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
       finished_at = CASE WHEN $3 IN ('succeeded', 'failed', 'canceled') THEN now() ELSE finished_at END,
       updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [run.orgId, run.id, status, extra.error !== undefined, extra.error ?? null],
  )
  await appendEvent(q, run.orgId, run.id, 'status', { status, ...(extra.error ? { error: extra.error } : {}) })
}

export async function addRunUsage(q: Queryable, run: Pick<Run, 'id' | 'orgId'>, usage: { costUsd?: number; agentSeconds?: number }): Promise<void> {
  await q.query(
    `UPDATE runs SET cost_usd = cost_usd + $3, agent_seconds = agent_seconds + $4, updated_at = now() WHERE org_id = $1 AND id = $2`,
    [run.orgId, run.id, usage.costUsd ?? 0, Math.round(usage.agentSeconds ?? 0)],
  )
}

/** Today's (UTC) agent seconds and spend across the org, for limit checks. */
export async function usageToday(q: Queryable, orgId: string): Promise<{ agentSeconds: number; costUsd: number }> {
  const [row] = await q.query<{ s: string | number; c: string | number }>(
    `SELECT coalesce(sum(agent_seconds), 0) AS s, coalesce(sum(cost_usd), 0) AS c FROM runs
     WHERE org_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [orgId],
  )
  return { agentSeconds: Number(row?.s ?? 0), costUsd: Number(row?.c ?? 0) }
}

export async function requestCancel(q: Queryable, orgId: string, runId: string): Promise<void> {
  await q.query(`UPDATE runs SET cancel_requested = true, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, runId])
}

export async function isCancelRequested(q: Queryable, runId: string): Promise<boolean> {
  const [row] = await q.query<{ c: boolean }>('SELECT cancel_requested AS c FROM runs WHERE id = $1', [runId])
  return row?.c ?? false
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function listSteps(q: Queryable, orgId: string, runId: string): Promise<RunStep[]> {
  const rows = await q.query<StepRow>(`SELECT ${STEP_COLS} FROM run_steps WHERE org_id = $1 AND run_id = $2 ORDER BY idx`, [orgId, runId])
  return rows.map(toStep)
}

export async function updateStep(
  q: Queryable,
  run: Pick<Run, 'id' | 'orgId'>,
  idx: number,
  patch: { status: StepStatus; output?: unknown; error?: string | null; bumpAttempt?: boolean; policyCleared?: boolean },
): Promise<void> {
  await q.query(
    `UPDATE run_steps SET status = $4,
       policy_cleared = coalesce($10, policy_cleared),
       output = CASE WHEN $5::boolean THEN $6::jsonb ELSE output END,
       error = CASE WHEN $7::boolean THEN $8 ELSE error END,
       attempt = attempt + CASE WHEN $9 THEN 1 ELSE 0 END,
       started_at = CASE WHEN $4 = 'running' THEN now() ELSE started_at END,
       finished_at = CASE WHEN $4 IN ('succeeded', 'failed', 'skipped', 'canceled') THEN now()
                          WHEN $4 IN ('running', 'pending') THEN NULL ELSE finished_at END
     WHERE org_id = $1 AND run_id = $2 AND idx = $3`,
    [
      run.orgId,
      run.id,
      idx,
      patch.status,
      patch.output !== undefined,
      patch.output === undefined ? null : JSON.stringify(patch.output),
      patch.error !== undefined,
      patch.error ?? null,
      patch.bumpAttempt ?? false,
      patch.policyCleared ?? null,
    ],
  )
  await appendEvent(
    q,
    run.orgId,
    run.id,
    'step.status',
    { status: patch.status, ...(patch.error ? { error: patch.error } : {}) },
    idx,
  )
}

// ── Approvals ────────────────────────────────────────────────────────────────

export async function createApproval(
  q: Queryable,
  run: Pick<Run, 'id' | 'orgId'>,
  stepIdx: number,
  message: string,
  minRole: Role,
  opts: { source?: "step" | "policy"; rule?: string } = {},
): Promise<Approval> {
  const source = opts.source ?? "step"
  const [row] = await q.query<ApprovalRow>(
    `INSERT INTO approvals (org_id, run_id, step_idx, status, message, min_role, source, rule) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
     ON CONFLICT (run_id, step_idx) DO UPDATE SET status = 'pending', message = excluded.message, min_role = excluded.min_role,
       source = excluded.source, rule = excluded.rule, requested_at = now(), decided_by = NULL, decided_at = NULL, comment = NULL
     RETURNING ${APPROVAL_COLS}`,
    [run.orgId, run.id, stepIdx, message, minRole, source, opts.rule ?? null],
  )
  await appendEvent(q, run.orgId, run.id, 'approval.requested', { message, minRole, source, ...(opts.rule ? { rule: opts.rule } : {}) }, stepIdx)
  return toApproval(row!)
}

export async function getApproval(q: Queryable, orgId: string, runId: string, stepIdx: number): Promise<Approval | null> {
  const [row] = await q.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLS} FROM approvals WHERE org_id = $1 AND run_id = $2 AND step_idx = $3`,
    [orgId, runId, stepIdx],
  )
  return row ? toApproval(row) : null
}

export async function decideApproval(
  q: Queryable,
  orgId: string,
  approvalId: string,
  decision: 'approved' | 'denied' | 'canceled',
  userId: string | null,
  comment: string | null,
): Promise<Approval | null> {
  const [row] = await q.query<ApprovalRow>(
    `UPDATE approvals SET status = $3, decided_by = $4, decided_at = now(), comment = $5
     WHERE org_id = $1 AND id = $2 AND status = 'pending' RETURNING ${APPROVAL_COLS}`,
    [orgId, approvalId, decision, userId, comment],
  )
  return row ? toApproval(row) : null
}

export async function listPendingApprovals(
  q: Queryable,
  orgId: string,
): Promise<Array<Approval & { runNumber: number; jobName: string; stepName: string }>> {
  const rows = await q.query<ApprovalRow & { number: number; job_name: string; step_name: string }>(
    `SELECT a.id, a.run_id, a.step_idx, a.status, a.message, a.min_role, a.requested_at, a.decided_by, a.decided_at, a.comment,
            r.number, r.job_snapshot->>'name' AS job_name, s.name AS step_name
     FROM approvals a
     JOIN runs r ON r.id = a.run_id
     JOIN run_steps s ON s.run_id = a.run_id AND s.idx = a.step_idx
     WHERE a.org_id = $1 AND a.status = 'pending' ORDER BY a.requested_at`,
    [orgId],
  )
  return rows.map((r) => ({ ...toApproval(r), runNumber: r.number, jobName: r.job_name, stepName: r.step_name }))
}

/** Every approval of a run (approval steps and policy gates), in step order. */
export async function listApprovalsForRun(q: Queryable, orgId: string, runId: string): Promise<Approval[]> {
  const rows = await q.query<ApprovalRow>(`SELECT ${APPROVAL_COLS} FROM approvals WHERE org_id = $1 AND run_id = $2 ORDER BY step_idx`, [orgId, runId])
  return rows.map(toApproval)
}
