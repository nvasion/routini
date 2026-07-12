import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import express, {
  Express,
  NextFunction,
  Request,
  Response,
  Router,
} from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { createAuthRouter, type AuthDependencies } from './auth/index.js'
import { createRouter } from './routes.js'
import { AppConfig, loadConfig } from './config.js'
import type { Notifier, TaskNotifierOptions } from './notifications/index.js'
import type { TaskExecutor } from './tasks/index.js'
import type { AiSettingsStore } from './aiSettings/index.js'

const APP_NAME = 'routini'
const APP_VERSION = '0.1.0'

export interface CreateAppOptions {
  /**
   * Runtime configuration. Defaults to `loadConfig()` so callers that don't
   * need to override anything can just call `createApp()`.
   */
  config?: AppConfig
  /**
   * Auth dependencies (config + user store). When present, `createApp` mounts
   * the auth router at `/api/auth` and the (auth-protected) main router at
   * `/api`. When absent — for example, in a bare skeleton test — a minimal
   * public `/api/version` router is mounted instead. This keeps the app
   * self-describing and callable in isolation.
   */
  authDeps?: AuthDependencies
  /**
   * Optional email notifier. When provided, task outcome events
   * (`succeeded`, `failed`) are delivered to the task owner. Build with
   * `createNotifier(loadNotificationConfig())` at startup.
   */
  notifier?: Notifier
  /** Extra options forwarded to `TaskNotifier` (e.g. `defaultToEmail`). */
  notifierOptions?: TaskNotifierOptions
  /**
   * Optional task executor injected into the task router. When omitted the
   * router uses the `defaultExecutor` (no-op stub). Production wiring in
   * `index.ts` constructs a dispatch executor that routes developmental tasks
   * to the Docker-backed executor and daily tasks to the real SSH/email/HTTP
   * handlers; pass it here so the full stack is in one place.
   */
  executor?: TaskExecutor
  /**
   * Optional AI settings store. When provided alongside `executor`, the
   * developmental executor can retrieve per-user API keys for agent auth.
   * Defaults to a fresh in-memory store inside `createRouter` when omitted.
   */
  aiSettings?: AiSettingsStore
}

/**
 * Build a fully wired Express application.
 *
 * Kept as a factory (rather than a module-level singleton that calls
 * `app.listen`) so tests can mount the app in-process with supertest and
 * multiple isolated instances can coexist. Accepts an optional config
 * override to make security-relevant defaults (CORS allowlist, etc.)
 * trivially exercisable in tests, and an optional set of auth dependencies
 * so the bootstrap in `index.ts` can inject a real user store.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.config ?? loadConfig()
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
    }),
  )

  // `express.json` gets a modest limit to keep unauthenticated endpoints
  // resistant to trivial DoS via oversized payloads. Individual routers can
  // opt in to a larger limit if a specific workload requires it.
  app.use(express.json({ limit: '100kb' }))

  // Health check lives outside `/api` so infrastructure probes (LB, k8s)
  // can hit it without knowledge of API versioning.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  if (options.authDeps) {
    app.use('/api/auth', createAuthRouter(options.authDeps))
    app.use(
      '/api',
      createRouter(options.authDeps, {
        notifier: options.notifier,
        notifierOptions: options.notifierOptions,
        executor: options.executor,
        aiSettings: options.aiSettings,
      }),
    )
  } else {
    // Skeleton mode: no user store wired in yet. Expose only the public
    // version endpoint so unauthenticated clients (e.g. the login page) can
    // still perform a feature/version check.
    app.use('/api', buildSkeletonRouter())
  }

  // Serve the pre-built React client when it exists (i.e. after `make build`
  // or in production).  The path is resolved relative to *this compiled file*
  // so it is correct whether we run from `server/src/` (tsx in dev) or from
  // `server/dist/` (node in production).
  const clientDist = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../client/dist',
  )
  if (existsSync(clientDist)) {
    // Serve static assets (JS bundles, CSS, images, …).
    app.use(express.static(clientDist))
    // SPA fallback: any GET request that is not an API/health path and has no
    // matching static file gets index.html so the React router handles it.
    // This must come before the JSON 404 handler so that client-side routes
    // (e.g. /dashboard, /settings) are not swallowed as backend 404s.
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path === '/health') {
        next()
        return
      }
      res.sendFile(resolve(clientDist, 'index.html'))
    })
  }

  // JSON 404 for unmatched API routes (and all routes when client dist is absent).
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

/**
 * Minimal router used when `createApp` is called without auth dependencies —
 * for example, in the initial skeleton test that just verifies the factory
 * boots and exposes a version endpoint.
 */
function buildSkeletonRouter(): Router {
  const router = Router()
  router.get('/version', (_req: Request, res: Response) => {
    res.json({ version: APP_VERSION, name: APP_NAME })
  })
  return router
}
