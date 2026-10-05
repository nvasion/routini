// ─────────────────────────────────────────────────────────────────────────────
// Runners (routini-runner)
//
//   POST   /api/orgs/:org/runners/enrollments   one-time token + install commands   (admin)
//   GET    /api/orgs/:org/runners
//   DELETE /api/orgs/:org/runners/:id           revoke (the runner exits)           (admin)
//   POST   /api/runner/enroll                   token → runner credential           (public; the runner)
//
// The control connection itself is a WebSocket handled by runner/gateway.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { addHostEvent } from '../repos/hosts.js'
import { createEnrollment, ENROLL_PREFIX, enrollRunner, listRunners, revokeRunner } from '../repos/runners.js'

const RUNNER_IMAGE = 'ghcr.io/nvasion/routini-runner:latest'
const INSTALL_SCRIPT = 'https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh'

export function installCommands(url: string, token: string, name?: string) {
  const n = name ? ` --name ${name}` : ''
  return {
    script: `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --url ${url} --token ${token}${n}`,
    docker: `docker run -d --init --name routini-runner --restart unless-stopped -e ROUTINI_RUNNER_URL=${url} -e ROUTINI_RUNNER_TOKEN=${token}${name ? ` -e ROUTINI_RUNNER_NAME=${name}` : ''} -v routini-runner:/home/routini-runner/.config ${RUNNER_IMAGE}`,
    manual: `routini-runner enroll --url ${url} --token ${token}${n} && routini-runner run`,
  }
}

export function runnersRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })

  r.post(
    '/runners/enrollments',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const name = b['name'] === undefined || b['name'] === '' ? undefined : String(b['name'])
      if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/.test(name)) throw badRequest('name must be 1–58 chars of letters, digits, ".", "_" or "-"')
      const group = b['group'] === undefined ? '' : String(b['group'])
      if (!/^[A-Za-z0-9 ._-]{0,60}$/.test(group)) throw badRequest('group must be at most 60 plain characters')
      const tags = b['tags'] === undefined ? [] : b['tags']
      if (!Array.isArray(tags) || tags.length > 20 || !tags.every((t) => typeof t === 'string' && /^[A-Za-z0-9._:-]{1,40}$/.test(t))) throw badRequest('tags must be up to 20 short tags')
      const e = await ctx.db.org(org.id, (q) => createEnrollment(q, org.id, currentUser(req).id, { name, group, tags: tags as string[] }))
      res.status(201).json({ token: e.token, expiresAt: e.expiresAt, url: ctx.config.publicUrl, commands: installCommands(ctx.config.publicUrl, e.token, name) })
    }),
  )

  r.get(
    '/runners',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json({ runners: await ctx.db.org(org.id, (q) => listRunners(q, org.id)) })
    }),
  )

  r.delete(
    '/runners/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = String(req.params['id'])
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Runner not found')
      const runner = await ctx.db.org(org.id, async (q) => {
        const r2 = await revokeRunner(q, org.id, id)
        if (r2?.hostId) await addHostEvent(q, org.id, r2.hostId, 'runner.removed', currentUser(req).id)
        return r2
      })
      if (!runner) throw notFound('Runner not found')
      await ctx.runners.revoke(id)
      res.status(204).end()
    }),
  )

  return r
}

/** Public: the runner exchanges its one-time token for a credential. */
export function runnerEnrollRouter(ctx: AppContext): Router {
  const r = Router()
  r.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, skip: () => ctx.config.env === 'test' }))
  r.post(
    '/enroll',
    ah(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const s = (k: string, max: number, required = true) => {
        const v = b[k]
        if (v === undefined && !required) return undefined
        if (typeof v !== 'string' || !v.trim() || v.length > max) throw badRequest(`${k} is required (at most ${max} characters)`)
        return v.trim()
      }
      const token = s('token', 200)!
      if (!token.startsWith(ENROLL_PREFIX)) throw new HttpError(401, 'Invalid enrollment token')
      const req2 = { token, name: s('name', 58, false), hostname: s('hostname', 253)!, os: s('os', 40)!, arch: s('arch', 40)!, version: s('version', 40)! }
      const result = await ctx.db.system((q) => enrollRunner(q, req2))
      if (!result) throw new HttpError(401, 'The enrollment token is invalid, expired or already used')
      const [org] = await ctx.db.system((q) => q.query<{ slug: string }>('SELECT slug FROM orgs WHERE id = $1', [result.orgId]))
      res.status(201).json({ runnerId: result.runnerId, credential: result.credential, hostId: result.hostId, name: result.name, org: org?.slug ?? null })
    }),
  )
  return r
}
