// ─────────────────────────────────────────────────────────────────────────────
// Jobs
//
//   GET    /api/orgs/:org/jobs            jobs with their latest run
//   POST   /api/orgs/:org/jobs            create                                  (member)
//   GET    /api/orgs/:org/jobs/:id
//   PUT    /api/orgs/:org/jobs/:id        partial update; rotateWebhookSecret     (member)
//   DELETE /api/orgs/:org/jobs/:id        archive (runs are kept)                 (member)
//   POST   /api/orgs/:org/jobs/:id/run    manual run                              (member)
//
// Webhook jobs get a secret, returned once on create (and on rotation) and
// stored sealed as credential `webhook.<jobId>`. See routes/hooks.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { ah, badRequest, currentOrg, currentUser, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { parseJobSpec, SpecError, type JobSpec } from '../engine/spec.js'
import { archiveJob, createJob, getJob, listJobs, updateJob, type Job } from '../repos/jobs.js'
import { createRun, type Run } from '../repos/runs.js'
import { getHost } from '../repos/hosts.js'
import { deleteSecret, hasSecret, putSecret } from '../repos/credentials.js'
import type { Queryable } from '../db/index.js'

export const webhookKey = (jobId: string) => `webhook.${jobId}`

function parseOr400(raw: unknown, current?: JobSpec): JobSpec {
  try {
    return parseJobSpec(raw, current)
  } catch (err) {
    if (err instanceof SpecError) throw badRequest(err.message)
    throw err
  }
}

/** References a spec makes to other org resources must exist in this org. */
async function checkReferences(q: Queryable, orgId: string, spec: JobSpec): Promise<void> {
  for (const [i, s] of spec.steps.entries()) {
    if (s.kind === 'action' && s.config.type === 'ssh' && !(await getHost(q, orgId, s.config.hostId))) {
      throw badRequest(`steps[${i}].config.hostId does not match a host in this org`)
    }
  }
}

export function runSummary(r: Run) {
  return {
    id: r.id,
    number: r.number,
    jobId: r.jobId,
    jobName: r.jobSnapshot.name,
    status: r.status,
    trigger: r.trigger.kind,
    costUsd: r.costUsd,
    agentSeconds: r.agentSeconds,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }
}

export function jobsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const webhookUrl = (orgSlug: string, jobId: string) => `/api/hooks/${orgSlug}/${jobId}`

  const view = (job: Job, orgSlug: string, extra: Record<string, unknown> = {}) => ({
    ...job,
    ...(job.trigger.kind === 'webhook' ? { webhookUrl: webhookUrl(orgSlug, job.id) } : {}),
    ...extra,
  })

  const jobOr404 = async (q: Queryable, orgId: string, id: string) => {
    const job = /^[0-9a-f-]{36}$/i.test(id) ? await getJob(q, orgId, id) : null
    if (!job || job.archivedAt) throw notFound('Job not found')
    return job
  }

  r.get(
    '/jobs',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const { jobs, last } = await ctx.db.org(org.id, async (q) => {
        const jobs = await listJobs(q, org.id)
        const rows = await q.query<{ job_id: string; id: string; number: number; status: string; finished_at: Date | null; created_at: Date }>(
          `SELECT DISTINCT ON (job_id) job_id, id, number, status, finished_at, created_at FROM runs
           WHERE org_id = $1 ORDER BY job_id, number DESC`,
          [org.id],
        )
        return { jobs, last: new Map(rows.map((x) => [x.job_id, x])) }
      })
      res.json({
        jobs: jobs.map((j) => {
          const l = last.get(j.id)
          return view(j, org.slug, {
            lastRun: l ? { id: l.id, number: l.number, status: l.status, createdAt: new Date(l.created_at).toISOString(), finishedAt: l.finished_at ? new Date(l.finished_at).toISOString() : null } : null,
          })
        }),
      })
    }),
  )

  r.post(
    '/jobs',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const spec = parseOr400(req.body)
      const { job, secret } = await ctx.db.org(org.id, async (q) => {
        await checkReferences(q, org.id, spec)
        const job = await createJob(q, org.id, user.id, spec)
        let secret: string | undefined
        if (spec.trigger.kind === 'webhook') {
          secret = randomBytes(24).toString('base64url')
          await putSecret(q, ctx.box, org.id, webhookKey(job.id), secret, user.id)
        }
        return { job, secret }
      })
      res.status(201).json({ job: view(job, org.slug), ...(secret ? { webhookSecret: secret } : {}) })
    }),
  )

  r.get(
    '/jobs/:id',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const job = await ctx.db.org(org.id, (q) => jobOr404(q, org.id, String(req.params['id'])))
      res.json({ job: view(job, org.slug) })
    }),
  )

  r.put(
    '/jobs/:id',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const rotate = (req.body ?? {})['rotateWebhookSecret'] === true
      const { job, secret } = await ctx.db.org(org.id, async (q) => {
        const current = await jobOr404(q, org.id, String(req.params['id']))
        const { rotateWebhookSecret: _ignored, ...body } = (req.body ?? {}) as Record<string, unknown>
        const spec = Object.keys(body).length ? parseOr400(body, current) : current
        await checkReferences(q, org.id, spec)
        const job = (await updateJob(q, org.id, current.id, spec))!
        let secret: string | undefined
        if (spec.trigger.kind === 'webhook' && (rotate || !(await hasSecret(q, org.id, webhookKey(job.id))))) {
          secret = randomBytes(24).toString('base64url')
          await putSecret(q, ctx.box, org.id, webhookKey(job.id), secret, user.id)
        } else if (spec.trigger.kind !== 'webhook') {
          await deleteSecret(q, org.id, webhookKey(job.id))
        }
        return { job, secret }
      })
      res.json({ job: view(job, org.slug), ...(secret ? { webhookSecret: secret } : {}) })
    }),
  )

  r.delete(
    '/jobs/:id',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      await ctx.db.org(org.id, async (q) => {
        const job = await jobOr404(q, org.id, String(req.params['id']))
        await archiveJob(q, org.id, job.id)
        await deleteSecret(q, org.id, webhookKey(job.id))
      })
      res.status(204).end()
    }),
  )

  r.post(
    '/jobs/:id/run',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const run = await ctx.db.org(org.id, async (q) => {
        const job = await jobOr404(q, org.id, String(req.params['id']))
        return createRun(q, job, { kind: 'manual', userId: user.id })
      })
      res.status(201).json({ run: runSummary(run) })
    }),
  )

  return r
}
