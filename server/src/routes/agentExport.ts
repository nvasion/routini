// ─────────────────────────────────────────────────────────────────────────────
// Factory pull-back route (Contract part B, see CLAUDE.md / the Factory PRD).
//
//   GET /api/agent/factory-export?format=bundle|patch
//   header x-routini-pull-token: <jwt>
//
// No session auth: the agent container authenticates with a short-lived pull
// token minted by engine/agent.ts (config.startFrom), scoped to one run, one
// Factory project and a base/head ref range. Mounted before the org routers.
// Streams GET <factory base>/api/projects/<project>/git/export with the org's
// own Factory token (same SSRF guard as engine/factory.ts), passing through
// status, content-type and the X-Git-* / X-Commits / X-Files-Changed headers.
// ─────────────────────────────────────────────────────────────────────────────

import { Readable } from 'node:stream'
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { ah, HttpError, type AppContext } from '../http/common.js'
import { getRun } from '../repos/runs.js'
import { getIntegrationCredentials } from '../repos/integrations.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'
import { DEFAULT_FACTORY_URL, type FactoryFetch } from '../engine/factory.js'

const PULL_TOKEN_HEADER = 'x-routini-pull-token'
const INVALID_TOKEN = 'Pull token is invalid or expired'
/** Headers Factory's export endpoint sends, passed straight through to the agent. */
const PASSTHROUGH_HEADERS = ['x-git-base', 'x-git-head', 'x-commits', 'x-files-changed']

interface PullTokenPayload {
  k: 'pull'
  org: string
  run: string
  step: number
  project: string
  base: string
  head: string
  label: string
}

function isPullTokenPayload(v: unknown): v is PullTokenPayload {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    p['k'] === 'pull' &&
    typeof p['org'] === 'string' &&
    typeof p['run'] === 'string' &&
    typeof p['project'] === 'string' &&
    typeof p['base'] === 'string' &&
    typeof p['head'] === 'string' &&
    typeof p['label'] === 'string'
  )
}

function verifyPullToken(token: string, secret: string): PullTokenPayload | null {
  let payload: unknown
  try {
    payload = jwt.verify(token, secret)
  } catch {
    return null
  }
  return isPullTokenPayload(payload) ? payload : null
}

export function agentExportRouter(ctx: AppContext): Router {
  const r = Router()
  r.use(
    rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      // Scoped per pull token, not per IP: many agent containers can share an egress IP.
      keyGenerator: (req) => req.header(PULL_TOKEN_HEADER) ?? ipKeyGenerator(req.ip ?? 'unknown'),
      message: { error: 'Too many requests, please try again later' },
      skip: () => ctx.config.env === 'test',
    }),
  )

  r.get(
    '/factory-export',
    ah(async (req, res) => {
      const token = req.header(PULL_TOKEN_HEADER)
      const payload = token ? verifyPullToken(token, ctx.config.jwtSecret) : null
      if (!payload) throw new HttpError(401, INVALID_TOKEN)

      const format = req.query['format']
      if (format !== 'bundle' && format !== 'patch') throw new HttpError(400, 'format must be bundle or patch')

      const run = await ctx.db.org(payload.org, (q) => getRun(q, payload.org, payload.run))
      // A run that no longer exists under this token's org is as good as a forged token.
      if (!run) throw new HttpError(401, INVALID_TOKEN)
      if (run.status !== 'running') throw new HttpError(409, 'The run is no longer running')

      const creds = await ctx.db.org(payload.org, (q) => getIntegrationCredentials(q, ctx.box, payload.org, 'factory'))
      if (!creds['apiToken']) throw new HttpError(502, 'The Factory integration is not connected (Integrations → Factory)')

      let base: URL
      try {
        base = new URL(creds['baseUrl'] || DEFAULT_FACTORY_URL)
      } catch {
        throw new HttpError(502, 'The Factory URL in the integration is not valid')
      }
      if (ctx.config.mode !== 'selfhost') {
        const safe = isSsrfSafeHostname(base.hostname) && (await resolvedIpIsSsrfSafe(base.hostname).catch(() => false))
        if (!safe) throw new HttpError(502, 'The Factory URL points at a private address')
      }

      const exportUrl = new URL(`/api/projects/${encodeURIComponent(payload.project)}/git/export`, base)
      exportUrl.searchParams.set('base', payload.base)
      exportUrl.searchParams.set('head', payload.head)
      exportUrl.searchParams.set('format', format)

      const fetchImpl = ctx.actions?.factoryFetch ?? (fetch as FactoryFetch)
      let upstream: Response
      try {
        upstream = await fetchImpl(exportUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: { authorization: `Bearer ${creds['apiToken']}` },
        })
      } catch (err) {
        throw new HttpError(502, `Factory did not respond: ${(err as Error).message}`)
      }

      if (!upstream.ok) {
        const text = await upstream.text()
        let data: unknown = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
        }
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${upstream.status}`
        throw new HttpError(502, msg)
      }

      res.status(upstream.status)
      const contentType = upstream.headers.get('content-type')
      if (contentType) res.setHeader('content-type', contentType)
      for (const h of PASSTHROUGH_HEADERS) {
        const v = upstream.headers.get(h)
        if (v !== null) res.setHeader(h, v)
      }
      if (!upstream.body) {
        res.end()
        return
      }
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
    }),
  )
  return r
}
