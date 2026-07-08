import express, { Express, NextFunction, Request, Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { router } from './routes.js'
import { AppConfig, loadConfig } from './config.js'

/**
 * Build a fully wired Express application.
 *
 * Kept as a factory (rather than a module-level singleton that calls
 * `app.listen`) so tests can mount the app in-process with supertest and
 * multiple isolated instances can coexist. Accepts an optional config
 * override to make security-relevant defaults (CORS allowlist, etc.)
 * trivially exercisable in tests.
 */
export function createApp(config: AppConfig = loadConfig()): Express {
  const app = express()

  // Security headers. Helmet's defaults set X-Content-Type-Options,
  // Strict-Transport-Security, X-Frame-Options, Referrer-Policy, and a
  // conservative CSP. This is our security baseline — every downstream
  // route inherits it.
  app.use(helmet())

  // Explicit CORS allowlist. No wildcards: an unknown Origin gets rejected
  // rather than reflected, which is required for cookie-based auth and
  // guards against confused-deputy attacks from arbitrary sites.
  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin / server-to-server requests have no Origin header.
        if (!origin) {
          callback(null, true)
          return
        }
        if (config.allowedOrigins.includes(origin)) {
          callback(null, true)
          return
        }
        callback(new Error(`Origin not allowed: ${origin}`))
      },
      credentials: true,
    })
  )

  // `express.json` gets a modest limit to avoid trivial DoS via oversized
  // payloads on unauthenticated endpoints during the skeleton phase; the
  // auth layer will refine this later.
  app.use(express.json({ limit: '1mb' }))

  // Health check lives outside `/api` so infrastructure probes (LB, k8s)
  // can hit it without knowledge of API versioning.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use('/api', router)

  // 404 handler — must come after all routes.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' })
  })

  // Centralized error handler. Logs the underlying error server-side but
  // never leaks stack traces or internal messages to the client. Rejected
  // CORS preflights surface here as 403 rather than the default 500 so
  // that operators can distinguish policy failures from bugs.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error('[error]', message)
    if (message.startsWith('Origin not allowed')) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    res.status(500).json({ error: 'Internal Server Error' })
  })

  return app
}
