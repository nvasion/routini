// ─────────────────────────────────────────────────────────────────────────────
// Webhook triggers (no session)
//
//   POST /api/hooks/:org/:jobId
//
// Authenticated by the job's webhook secret, either
//   Authorization: Bearer <secret>                     (Alertmanager, most tools)
//   X-Routini-Signature: sha256=<hex HMAC of the body>  (GitHub-style signing)
// The JSON body (up to 256 KB) is kept on the run's trigger for steps to use.
// Unknown org, unknown job and bad secret all return the same 404.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { ah, notFound, type AppContext } from '../http/common.js'
import { getOrgBySlug } from '../repos/identity.js'
import { getJob } from '../repos/jobs.js'
import { getSecret } from '../repos/credentials.js'
import { createRun } from '../repos/runs.js'
import { webhookKey } from './jobs.js'

const MAX_BODY = 256 * 1024

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function hooksRouter(ctx: AppContext): Router {
  const r = Router()
  r.use(
    rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false, skip: () => ctx.config.env === 'test' }),
  )

  r.post(
    '/:org/:jobId',
    express.raw({ type: () => true, limit: MAX_BODY }),
    ah(async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const org = await getOrgBySlug(ctx.db, String(req.params['org']))
      const jobId = String(req.params['jobId'])
      if (!org || !/^[0-9a-f-]{36}$/i.test(jobId)) throw notFound()

      const run = await ctx.db.org(org.id, async (q) => {
        const job = await getJob(q, org.id, jobId)
        if (!job || job.archivedAt || !job.enabled || job.trigger.kind !== 'webhook') return null
        const secret = await getSecret(q, ctx.box, org.id, webhookKey(job.id))
        if (!secret) return null

        const auth = req.header('authorization')
        const sig = req.header('x-routini-signature')
        const bearerOk = auth?.startsWith('Bearer ') ? safeEqual(auth.slice(7), secret) : false
        const sigOk = sig ? safeEqual(sig, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`) : false
        if (!bearerOk && !sigOk) return null

        let payload: unknown
        if (raw.length) {
          try {
            payload = JSON.parse(raw.toString('utf8'))
          } catch {
            payload = { raw: raw.toString('utf8').slice(0, 10_000) }
          }
        }
        return createRun(q, job, { kind: 'webhook', payload })
      })
      if (!run) throw notFound()
      res.status(202).json({ runId: run.id, number: run.number })
    }),
  )
  return r
}
