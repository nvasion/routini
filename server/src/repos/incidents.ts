// ─────────────────────────────────────────────────────────────────────────────
// Incidents (tenant tables): one open incident per alert fingerprint, its
// event timeline, the runs it started, and its postmortem.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { NormalizedAlert } from '../engine/alerts.js'
import { hostLabel } from '../engine/alerts.js'
import { findHostForLabel } from './hosts.js'

export interface Postmortem {
  markdown: string
  generatedAt: string | null
  editedAt: string | null
  editedBy: string | null
}

export interface Incident {
  id: string
  number: number
  fingerprint: string
  title: string
  severity: string
  status: 'open' | 'resolved'
  source: string
  labels: Record<string, string>
  annotations: Record<string, string>
  hostId: string | null
  hostName: string | null
  alertCount: number
  openedAt: string
  lastAlertAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  postmortem: Postmortem | null
}

export interface IncidentEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  userName: string | null
  data: Record<string, unknown>
}

interface Row {
  id: string
  number: number
  fingerprint: string
  title: string
  severity: string
  status: 'open' | 'resolved'
  source: string
  labels: Record<string, string>
  annotations: Record<string, string>
  host_id: string | null
  host_name: string | null
  alert_count: number
  opened_at: Date
  last_alert_at: Date
  resolved_at: Date | null
  resolved_by: string | null
  postmortem: Postmortem | null
}

const COLS =
  'i.id, i.number, i.fingerprint, i.title, i.severity, i.status, i.source, i.labels, i.annotations, i.host_id, h.name AS host_name, ' +
  'i.alert_count, i.opened_at, i.last_alert_at, i.resolved_at, i.resolved_by, i.postmortem'
const FROM = 'incidents i LEFT JOIN hosts h ON h.id = i.host_id'
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
const toIncident = (r: Row): Incident => ({
  id: r.id,
  number: r.number,
  fingerprint: r.fingerprint,
  title: r.title,
  severity: r.severity,
  status: r.status,
  source: r.source,
  labels: r.labels,
  annotations: r.annotations,
  hostId: r.host_id,
  hostName: r.host_name,
  alertCount: r.alert_count,
  openedAt: iso(r.opened_at)!,
  lastAlertAt: iso(r.last_alert_at)!,
  resolvedAt: iso(r.resolved_at),
  resolvedBy: r.resolved_by,
  postmortem: r.postmortem,
})

export async function addIncidentEvent(q: Queryable, orgId: string, incidentId: string, type: string, userId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await q.query('INSERT INTO incident_events (org_id, incident_id, type, user_id, data) VALUES ($1, $2, $3, $4, $5)', [orgId, incidentId, type, userId, JSON.stringify(data)])
}

export async function getIncident(q: Queryable, orgId: string, id: string): Promise<Incident | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id])
  return row ? toIncident(row) : null
}

export async function getIncidentByNumber(q: Queryable, orgId: string, number: number): Promise<Incident | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE i.org_id = $1 AND i.number = $2`, [orgId, number])
  return row ? toIncident(row) : null
}

export async function listIncidents(q: Queryable, orgId: string, opts: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<Incident[]> {
  const rows = await q.query<Row>(
    `SELECT ${COLS} FROM ${FROM} WHERE i.org_id = $1 AND ($2::text IS NULL OR i.status = $2) ORDER BY i.status = 'open' DESC, i.opened_at DESC LIMIT $3`,
    [orgId, opts.status ?? null, Math.min(opts.limit ?? 100, 500)],
  )
  return rows.map(toIncident)
}

export async function listIncidentEvents(q: Queryable, orgId: string, incidentId: string): Promise<IncidentEvent[]> {
  const rows = await q.query<{ id: string; ts: Date; type: string; user_id: string | null; user_name: string | null; data: Record<string, unknown> }>(
    `SELECT e.id, e.ts, e.type, e.user_id, COALESCE(NULLIF(u.display_name, ''), u.email) AS user_name, e.data
     FROM incident_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.org_id = $1 AND e.incident_id = $2 ORDER BY e.id`,
    [orgId, incidentId],
  )
  return rows.map((r) => ({ id: Number(r.id), ts: iso(r.ts)!, type: r.type, userId: r.user_id, userName: r.user_name, data: r.data }))
}

export interface IngestResult {
  incident: Incident
  /** True when this alert opened the incident (and jobs should start). */
  opened: boolean
  /** True when this alert resolved the incident. */
  resolved: boolean
}

/**
 * Records one alert. A firing alert opens an incident (or counts as a repeat
 * of the open one with the same fingerprint); a resolved alert resolves it.
 * Resolved alerts with no open incident are ignored (null).
 */
export async function ingestAlert(q: Queryable, orgId: string, alert: NormalizedAlert): Promise<IngestResult | null> {
  const alertData = { name: alert.name, severity: alert.severity, labels: alert.labels, annotations: alert.annotations, source: alert.source, startsAt: alert.startsAt, endsAt: alert.endsAt, generatorUrl: alert.generatorUrl }
  const [open] = await q.query<{ id: string }>(`SELECT id FROM incidents WHERE org_id = $1 AND fingerprint = $2 AND status = 'open' FOR UPDATE`, [orgId, alert.fingerprint])

  if (alert.status === 'resolved') {
    if (!open) return null
    await q.query(`UPDATE incidents SET status = 'resolved', resolved_at = now(), last_alert_at = now() WHERE id = $1`, [open.id])
    await addIncidentEvent(q, orgId, open.id, 'alert.resolved', null, alertData)
    return { incident: (await getIncident(q, orgId, open.id))!, opened: false, resolved: true }
  }

  if (open) {
    await q.query(`UPDATE incidents SET alert_count = alert_count + 1, last_alert_at = now() WHERE id = $1`, [open.id])
    await addIncidentEvent(q, orgId, open.id, 'alert.repeat', null, { severity: alert.severity })
    return { incident: (await getIncident(q, orgId, open.id))!, opened: false, resolved: false }
  }

  const label = hostLabel(alert)
  const hostId = label ? await findHostForLabel(q, orgId, label) : null
  const [counter] = await q.query<{ value: number }>(
    `INSERT INTO incident_counters (org_id, value) VALUES ($1, 1) ON CONFLICT (org_id) DO UPDATE SET value = incident_counters.value + 1 RETURNING value`,
    [orgId],
  )
  const summary = alert.annotations['summary'] ?? alert.annotations['description']
  const title = `${alert.name}${label ? ` on ${label}` : ''}${summary ? `: ${summary}` : ''}`.slice(0, 300)
  const [row] = await q.query<{ id: string }>(
    `INSERT INTO incidents (org_id, number, fingerprint, title, severity, source, labels, annotations, host_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, fingerprint) WHERE status = 'open' DO NOTHING RETURNING id`,
    [orgId, counter!.value, alert.fingerprint, title, alert.severity, alert.source, JSON.stringify(alert.labels), JSON.stringify(alert.annotations), hostId],
  )
  if (!row) {
    // Lost a race with a concurrent alert for the same fingerprint: count it as a repeat.
    const [other] = await q.query<{ id: string }>(`SELECT id FROM incidents WHERE org_id = $1 AND fingerprint = $2 AND status = 'open'`, [orgId, alert.fingerprint])
    if (!other) return null
    await q.query(`UPDATE incidents SET alert_count = alert_count + 1, last_alert_at = now() WHERE id = $1`, [other.id])
    return { incident: (await getIncident(q, orgId, other.id))!, opened: false, resolved: false }
  }
  await addIncidentEvent(q, orgId, row.id, 'alert.firing', null, alertData)
  return { incident: (await getIncident(q, orgId, row.id))!, opened: true, resolved: false }
}

export async function resolveIncident(q: Queryable, orgId: string, id: string, userId: string): Promise<boolean> {
  const rows = await q.query(`UPDATE incidents SET status = 'resolved', resolved_at = now(), resolved_by = $3 WHERE org_id = $1 AND id = $2 AND status = 'open' RETURNING id`, [orgId, id, userId])
  if (rows.length) await addIncidentEvent(q, orgId, id, 'resolved', userId)
  return rows.length > 0
}

export async function setPostmortem(q: Queryable, orgId: string, id: string, pm: Postmortem): Promise<void> {
  await q.query('UPDATE incidents SET postmortem = $3 WHERE org_id = $1 AND id = $2', [orgId, id, JSON.stringify(pm)])
}

export async function linkRun(q: Queryable, orgId: string, incidentId: string, run: { id: string; number: number }, jobName: string): Promise<void> {
  await q.query('UPDATE runs SET incident_id = $3 WHERE org_id = $1 AND id = $2', [orgId, run.id, incidentId])
  await addIncidentEvent(q, orgId, incidentId, 'run.started', null, { runId: run.id, number: run.number, jobName })
}

export interface IncidentRun {
  id: string
  number: number
  jobName: string
  status: string
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export async function listIncidentRuns(q: Queryable, orgId: string, incidentId: string): Promise<IncidentRun[]> {
  const rows = await q.query<{ id: string; number: number; job_name: string; status: string; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null }>(
    `SELECT id, number, job_snapshot->>'name' AS job_name, status, error, created_at, started_at, finished_at FROM runs WHERE org_id = $1 AND incident_id = $2 ORDER BY number`,
    [orgId, incidentId],
  )
  return rows.map((r) => ({ id: r.id, number: r.number, jobName: r.job_name, status: r.status, error: r.error, createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at) }))
}
