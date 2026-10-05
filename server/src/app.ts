// ─────────────────────────────────────────────────────────────────────────────
// Express app factory. No listen() and no globals: index.ts (and each test)
// builds an AppContext and calls createApp(ctx).
// ─────────────────────────────────────────────────────────────────────────────

import express, { type Express } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { errorHandler, type AppContext } from './http/common.js'
import { createAuth } from './http/auth.js'
import { loadOrg } from './http/orgContext.js'
import { orgCollectionRouter, orgRouter } from './routes/orgs.js'
import { settingsRouter } from './routes/settings.js'
import { integrationsRouter } from './routes/integrations.js'
import { jobsRouter } from './routes/jobs.js'
import { runsRouter } from './routes/runs.js'
import { hostsRouter } from './routes/hosts.js'
import { hooksRouter } from './routes/hooks.js'
import { environmentsRouter } from './routes/environments.js'
import { policyRouter } from './routes/policy.js'
import { mcpRouter, type McpFetch } from './routes/mcp.js'
import { runnerEnrollRouter, runnersRouter } from './routes/runners.js'
import { alertIntakeRouter, incidentsRouter } from './routes/incidents.js'
import type { ProviderTestContext } from './integrations/providers.js'

export interface AppOptions {
  /** Overrides for integration live checks (tests inject a fake fetch). */
  providerCtx?: ProviderTestContext
  /** fetch for MCP server health checks (tests). */
  mcpFetch?: McpFetch
}

export function createApp(ctx: AppContext, opts: AppOptions = {}): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1) // behind nginx / a load balancer: rate limits key on the client IP

  // Webhooks verify signatures over the raw body, so they mount before the JSON parser.
  app.use('/api/hooks', hooksRouter(ctx))

  // Credentials (cookies) require an explicit origin; '*' is not allowed.
  app.use(cors({ origin: ctx.config.clientUrl, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser(ctx.config.cookieSecret))

  // Unauthenticated by session: runners enroll with a one-time token; monitoring tools post alerts with the org's alert token.
  app.use('/api/runner', runnerEnrollRouter(ctx))
  app.use('/api/alerts', alertIntakeRouter(ctx))

  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
      skip: () => ctx.config.env === 'test',
    }),
  )

  const auth = createAuth(ctx)
  // The terminal WebSocket (http/terminal.ts) authenticates upgrades with the same session logic.
  app.locals['auth'] = auth
  app.use('/api/auth', auth.router)

  // Every org route: authenticated, CSRF-checked for mutations, membership-resolved.
  app.use('/api/orgs', auth.requireAuth, auth.requireCsrf, orgCollectionRouter(ctx))
  const org = express.Router({ mergeParams: true })
  org.use(loadOrg(ctx))
  org.use(orgRouter(ctx))
  org.use(settingsRouter(ctx))
  org.use(integrationsRouter(ctx, opts.providerCtx))
  org.use(jobsRouter(ctx))
  org.use(runsRouter(ctx))
  org.use(hostsRouter(ctx))
  org.use(environmentsRouter(ctx))
  org.use(policyRouter(ctx))
  org.use(mcpRouter(ctx, opts.mcpFetch))
  org.use(runnersRouter(ctx))
  org.use(incidentsRouter(ctx))
  app.use('/api/orgs/:org', auth.requireAuth, auth.requireCsrf, org)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  app.use(errorHandler)
  return app
}
