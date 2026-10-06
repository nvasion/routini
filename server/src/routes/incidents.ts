// ─────────────────────────────────────────────────────────────────────────────
// Alerts in, incidents out
//
//   POST /api/alerts/:org                         alert intake (Bearer org alert token; Alertmanager, Grafana, generic JSON)
//   GET  /api/orgs/:org/alerts/settings           intake URL, whether a token exists, examples
//   POST /api/orgs/:org/alerts/token              create/rotate the token (shown once)            (admin)
//   GET  /api/orgs/:org/incidents?status=open|resolved
//   GET  /api/orgs/:org/incidents/:number         incident, timeline, runs
//   POST /api/orgs/:org/incidents/:number/resolve                                             (member)
//   POST /api/orgs/:org/incidents/:number/notes   { text }                                    (member)
//   POST /api/orgs/:org/incidents/:number/postmortem/generate   rebuild the draft              (member)
//   PUT  /api/orgs/:org/incidents/:number/postmortem            { markdown }                   (member)
//
// A firing alert opens an incident (or repeats the open one with the same
// fingerprint) and starts every enabled job whose alert trigger matches. A
// resolved alert resolves the incident and drafts its postmortem.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ah, badRequest, currentOrg, currentUser, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import type { Queryable } from '../db/index.js'
import { getOrgBySlug } from '../repos/identity.js'
import { getSecret, hasSecret, putSecret } from '../repos/credentials.js'
import { listJobs } from '../repos/jobs.js'
import { createRun } from '../repos/runs.js'
import {
  addIncidentEvent,
  getIncidentByNumber,
  ingestAlert,
  linkRun,
  listIncidentEvents,
  listIncidentRuns,
  listIncidents,
  resolveIncident,
  setPostmortem,
  type Incident,
} from '../repos/incidents.js'
import { AlertFormatError, alertMatches, normalizeAlerts } from '../engine/alerts.js'
import { buildPostmortem, loadPostmortemData } from '../engine/postmortem.js'

export const ALERT_TOKEN_KEY = 'alerts.token'

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Rebuilds the postmortem draft unless a person has edited it (or `force`). */
export async function draftPostmortem(q: Queryable, orgId: string, incident: Incident, force = false): Promise<void> {
  if (!force && incident.postmortem?.editedAt) return
  const data = await loadPostmortemData(q, orgId, incident.id)
  if (!data) return
  await setPostmortem(q, orgId, incident.id, { markdown: buildPostmortem(data), generatedAt: new Date().toISOString(), editedAt: null, editedBy: null })
}

export function alertIntakeRouter(ctx: AppContext): Router {
  const r = Router()
  r.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false, skip: () => ctx.config.env === 'test' }))
  r.post(
    '/:org',
    ah(async (req, res) => {
      const org = await getOrgBySlug(ctx.db, String(req.params['org']))
      if (!org) throw notFound()
      const auth = req.header('authorization') ?? ''
      const token = await ctx.db.org(org.id, (q) => getSecret(q, ctx.box, org.id, ALERT_TOKEN_KEY))
      if (!token || !auth.startsWith('Bearer ') || !safeEqual(auth.slice(7).trim(), token)) throw notFound()

      let alerts
      try {
        alerts = normalizeAlerts(req.body)
      } catch (err) {
        if (err instanceof AlertFormatError) throw badRequest(err.message)
        throw err
      }

      const results = []
      for (const alert of alerts) {
        const out = await ctx.db.org(org.id, async (q) => {
          const ing = await ingestAlert(q, org.id, alert)
          if (!ing) return null
          const runs: number[] = []
          if (ing.opened) {
            const jobs = (await listJobs(q, org.id)).filter((j) => j.enabled && !j.archivedAt && j.trigger.kind === 'alert' && alertMatches(j.trigger.match, alert))
            for (const job of jobs) {
              const run = await createRun(q, job, { kind: 'alert', incidentId: ing.incident.id, incidentNumber: ing.incident.number, alert, hostId: ing.incident.hostId })
              await linkRun(q, org.id, ing.incident.id, run, job.name)
              runs.push(run.number)
            }
          }
          if (ing.resolved) await draftPostmortem(q, org.id, ing.incident)
          return { incident: ing.incident.number, status: ing.incident.status, opened: ing.opened, resolved: ing.resolved, runs }
        })
        if (out) results.push(out)
      }
      res.status(202).json({ received: alerts.length, incidents: results })
    }),
  )
  return r
}

export function incidentsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const db = ctx.db
  const byNumber = async (orgId: string, raw: unknown) => {
    const n = Number(raw)
    const incident = Number.isInteger(n) && n > 0 ? await db.org(orgId, (q) => getIncidentByNumber(q, orgId, n)) : null
    if (!incident) throw notFound('Incident not found')
    return incident
  }

  r.get(
    '/alerts/settings',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const configured = await db.org(org.id, (q) => hasSecret(q, org.id, ALERT_TOKEN_KEY))
      res.json({ url: `${ctx.config.publicUrl}/api/alerts/${org.slug}`, configured })
    }),
  )

  r.post(
    '/alerts/token',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const token = `ral_${randomBytes(24).toString('base64url')}`
      await db.org(org.id, (q) => putSecret(q, ctx.box, org.id, ALERT_TOKEN_KEY, token, currentUser(req).id))
      res.status(201).json({ token, url: `${ctx.config.publicUrl}/api/alerts/${org.slug}` })
    }),
  )

  r.get(
    '/incidents',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const status = req.query['status'] === 'open' || req.query['status'] === 'resolved' ? (req.query['status'] as 'open' | 'resolved') : undefined
      res.json({ incidents: await db.org(org.id, (q) => listIncidents(q, org.id, { status })) })
    }),
  )

  r.get(
    '/incidents/:number',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const incident = await byNumber(org.id, req.params['number'])
      const [events, runs] = await db.org(org.id, async (q) => [await listIncidentEvents(q, org.id, incident.id), await listIncidentRuns(q, org.id, incident.id)] as const)
      res.json({ incident, events, runs })
    }),
  )

  r.post(
    '/incidents/:number/resolve',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const incident = await byNumber(org.id, req.params['number'])
      const updated = await db.org(org.id, async (q) => {
        await resolveIncident(q, org.id, incident.id, currentUser(req).id)
        const fresh = (await getIncidentByNumber(q, org.id, incident.number))!
        await draftPostmortem(q, org.id, fresh)
        return getIncidentByNumber(q, org.id, incident.number)
      })
      res.json({ incident: updated })
    }),
  )

  r.post(
    '/incidents/:number/notes',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const text = (req.body ?? {})['text']
      if (typeof text !== 'string' || !text.trim() || text.length > 10_000) throw badRequest('text must be a non-empty string (at most 10,000 characters)')
      const incident = await byNumber(org.id, req.params['number'])
      await db.org(org.id, (q) => addIncidentEvent(q, org.id, incident.id, 'note', currentUser(req).id, { text: text.trim() }))
      res.status(201).json({ ok: true })
    }),
  )

  r.post(
    '/incidents/:number/postmortem/generate',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const incident = await byNumber(org.id, req.params['number'])
      const updated = await db.org(org.id, async (q) => {
        await draftPostmortem(q, org.id, incident, true)
        return getIncidentByNumber(q, org.id, incident.number)
      })
      res.json({ incident: updated })
    }),
  )

  r.put(
    '/incidents/:number/postmortem',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const markdown = (req.body ?? {})['markdown']
      if (typeof markdown !== 'string' || markdown.length > 200_000) throw badRequest('markdown must be a string (at most 200,000 characters)')
      const incident = await byNumber(org.id, req.params['number'])
      const updated = await db.org(org.id, async (q) => {
        await setPostmortem(q, org.id, incident.id, {
          markdown,
          generatedAt: incident.postmortem?.generatedAt ?? null,
          editedAt: new Date().toISOString(),
          editedBy: currentUser(req).id,
        })
        return getIncidentByNumber(q, org.id, incident.number)
      })
      res.json({ incident: updated })
    }),
  )

  return r
}
