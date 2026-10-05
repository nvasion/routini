// ─────────────────────────────────────────────────────────────────────────────
// Runs, approvals, inbox, and live streams
//
//   GET  /api/orgs/:org/runs                     ?jobId= &status=a,b &before=<number> &limit=
//   GET  /api/orgs/:org/runs/:run                :run is the id or the number
//   GET  /api/orgs/:org/runs/:run/events         ?after=<eventId>
//   GET  /api/orgs/:org/runs/:run/stream         SSE; resumes from Last-Event-ID
//   POST /api/orgs/:org/runs/:run/cancel                                   (member)
//   POST /api/orgs/:org/runs/:run/rerun          new run of the same job   (member)
//   POST /api/orgs/:org/runs/:run/steps/:idx/approve | deny   { comment? } (approval's minRole)
//   GET  /api/orgs/:org/inbox                    approvals, failures (24h), live runs, upcoming
//   GET  /api/orgs/:org/stream                   SSE of run status changes across the org
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, forbidden, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { openSse, resumeFrom } from '../http/sse.js'
import { roleAtLeast } from '../repos/identity.js'
import { getJob, listUpcoming } from '../repos/jobs.js'
import {
  appendEvent,
  createRun,
  decideApproval,
  enqueueRun,
  getApproval,
  getRun,
  getRunByNumber,
  listApprovalsForRun,
  listEvents,
  listPendingApprovals,
  listRecentFailures,
  listRuns,
  listSteps,
  requestCancel,
  setRunStatus,
  TERMINAL_RUN,
  updateStep,
  type Run,
  type RunStatus,
} from '../repos/runs.js'
import type { Queryable } from '../db/index.js'
import { runSummary } from './jobs.js'
import { listIncidents } from '../repos/incidents.js'

const RUN_STATUSES: RunStatus[] = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled']

async function runOr404(q: Queryable, orgId: string, ref: string): Promise<Run> {
  let run: Run | null = null
  if (/^\d{1,9}$/.test(ref)) run = await getRunByNumber(q, orgId, Number(ref))
  else if (/^[0-9a-f-]{36}$/i.test(ref)) run = await getRun(q, orgId, ref)
  if (!run) throw notFound('Run not found')
  return run
}

export function runsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const db = ctx.db

  r.get(
    '/runs',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const status = typeof req.query['status'] === 'string' ? (req.query['status'].split(',') as RunStatus[]) : undefined
      if (status && !status.every((s) => RUN_STATUSES.includes(s))) throw badRequest(`status must be among: ${RUN_STATUSES.join(', ')}`)
      const jobId = typeof req.query['jobId'] === 'string' ? req.query['jobId'] : undefined
      if (jobId && !/^[0-9a-f-]{36}$/i.test(jobId)) throw badRequest('jobId must be a job id')
      const before = req.query['before'] !== undefined ? Number(req.query['before']) : undefined
      const limit = req.query['limit'] !== undefined ? Number(req.query['limit']) : undefined
      const runs = await db.org(org.id, (q) => listRuns(q, org.id, { jobId, status, beforeNumber: before, limit }))
      res.json({ runs: runs.map(runSummary), nextBefore: runs.length ? runs[runs.length - 1]!.number : null })
    }),
  )

  r.get(
    '/runs/:run',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const out = await db.org(org.id, async (q) => {
        const run = await runOr404(q, org.id, String(req.params['run']))
        const steps = await listSteps(q, org.id, run.id)
        const approvals = await listApprovalsForRun(q, org.id, run.id)
        return { run: { ...runSummary(run), jobSnapshot: run.jobSnapshot, trigger: run.trigger, cancelRequested: run.cancelRequested }, steps, approvals }
      })
      res.json(out)
    }),
  )

  r.get(
    '/runs/:run/events',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const after = resumeFrom(req)
      const events = await db.org(org.id, async (q) => {
        const run = await runOr404(q, org.id, String(req.params['run']))
        return listEvents(q, org.id, run.id, after)
      })
      res.json({ events })
    }),
  )

  r.get(
    '/runs/:run/stream',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const run = await db.org(org.id, (q) => runOr404(q, org.id, String(req.params['run'])))
      const stream = openSse(req, res)
      let last = resumeFrom(req)
      let pumping = Promise.resolve()
      let unsubscribe: (() => void) | null = null

      const pump = () => {
        pumping = pumping.then(async () => {
          if (stream.closed) return
          for (;;) {
            const batch = await db.org(org.id, (q) => listEvents(q, org.id, run.id, last))
            for (const e of batch) {
              stream.send(e.type, e, e.id)
              last = e.id
              if (e.type === 'status' && TERMINAL_RUN.includes(e.data['status'] as RunStatus)) {
                stream.send('end', { status: e.data['status'] })
                unsubscribe?.()
                stream.close()
                return
              }
            }
            if (batch.length < 500) return
          }
        }).catch((err) => {
          console.error('[sse] run stream failed:', (err as Error).message)
          stream.close()
        })
      }
      unsubscribe = await ctx.hub.subscribeRun(run.id, pump)
      req.on('close', () => unsubscribe?.())
      pump()
    }),
  )

  r.post(
    '/runs/:run/cancel',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const run = await db.org(org.id, async (q) => {
        const run = await runOr404(q, org.id, String(req.params['run']))
        if (TERMINAL_RUN.includes(run.status)) throw new HttpError(409, `Run is already ${run.status}`)
        await requestCancel(q, org.id, run.id)
        return run
      })
      // A run nobody is executing must be finalised here; a running one stops on its worker's next heartbeat.
      const idle = await db.org(org.id, async (q) => {
        if (run.status === 'waiting') return true
        const freed = await q.query(
          `DELETE FROM queue WHERE run_id = $1 AND (locked_until IS NULL OR locked_until < now()) RETURNING id`,
          [run.id],
        )
        return freed.length > 0
      })
      if (idle) await ctx.engine.cancelIdleRun({ ...run, cancelRequested: true })
      res.status(202).json({ run: runSummary((await db.org(org.id, (q) => getRun(q, org.id, run.id)))!) })
    }),
  )

  r.post(
    '/runs/:run/rerun',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const run = await db.org(org.id, async (q) => {
        const prev = await runOr404(q, org.id, String(req.params['run']))
        const job = await getJob(q, org.id, prev.jobId)
        if (!job || job.archivedAt) throw new HttpError(409, 'The job behind this run was archived')
        return createRun(q, job, { kind: 'manual', userId: user.id })
      })
      res.status(201).json({ run: runSummary(run) })
    }),
  )

  for (const decision of ['approve', 'deny'] as const) {
    r.post(
      `/runs/:run/steps/:idx/${decision}`,
      ah(async (req, res) => {
        const org = currentOrg(req)
        const user = currentUser(req)
        const idx = Number(req.params['idx'])
        if (!Number.isInteger(idx) || idx < 0) throw badRequest('Invalid step index')
        const rawComment = (req.body ?? {})['comment']
        if (rawComment !== undefined && (typeof rawComment !== 'string' || rawComment.length > 2000)) {
          throw badRequest('comment must be a string of at most 2000 characters')
        }
        const comment = typeof rawComment === 'string' && rawComment.trim() ? rawComment.trim() : null

        await db.org(org.id, async (q) => {
          const run = await runOr404(q, org.id, String(req.params['run']))
          const approval = await getApproval(q, org.id, run.id, idx)
          if (!approval) throw notFound('No approval for that step')
          if (approval.status !== 'pending') throw new HttpError(409, `Approval is already ${approval.status}`)
          if (org.role === 'viewer' || !roleAtLeast(org.role, approval.minRole)) {
            throw forbidden(`Approving this step requires the ${approval.minRole} role`)
          }
          const decided = await decideApproval(q, org.id, approval.id, decision === 'approve' ? 'approved' : 'denied', user.id, comment)
          if (!decided) throw new HttpError(409, 'Approval was decided concurrently')
          const by = user.displayName || user.email
          await appendEvent(q, org.id, run.id, 'approval.decided', { decision: decided.status, by, comment }, idx)
          if (approval.source === 'policy') {
            // A policy gate in front of a real step: approving lets that step run (once).
            if (decision === 'approve') await updateStep(q, run, idx, { status: 'pending', policyCleared: true })
            else {
              await updateStep(q, run, idx, {
                status: 'failed',
                error: `Denied by ${by} under policy "${approval.rule ?? 'org policy'}"${comment ? `: ${comment}` : ''}`,
              })
            }
          } else if (decision === 'approve') {
            await updateStep(q, run, idx, { status: 'succeeded', output: { approvedBy: by, comment } })
          } else {
            await updateStep(q, run, idx, { status: 'failed', output: { deniedBy: by, comment }, error: `Denied by ${by}${comment ? `: ${comment}` : ''}` })
          }
          await setRunStatus(q, run, 'queued')
          await enqueueRun(q, org.id, run.id)
        })
        res.json({ ok: true })
      }),
    )
  }

  r.get(
    '/inbox',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const out = await db.org(org.id, async (q) => ({
        approvals: await listPendingApprovals(q, org.id),
        failures: (await listRecentFailures(q, org.id)).map(runSummary),
        live: (await listRuns(q, org.id, { status: ['queued', 'running', 'waiting'], limit: 50 })).map(runSummary),
        upcoming: await listUpcoming(q, org.id),
        incidents: await listIncidents(q, org.id, { status: 'open', limit: 20 }),
      }))
      res.json(out)
    }),
  )

  r.get(
    '/stream',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const stream = openSse(req, res)
      const unsubscribe = await ctx.hub.subscribeOrg(org.id, (n) => {
        if (n.t !== 'status' && n.t !== 'approval.requested' && n.t !== 'approval.decided') return
        void db
          .org(org.id, (q) => getRun(q, org.id, n.r))
          .then((run) => {
            if (run) stream.send('run', runSummary(run), n.e)
          })
          .catch(() => {})
      })
      req.on('close', unsubscribe)
    }),
  )

  return r
}
