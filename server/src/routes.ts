import { Router, type Request, type Response } from 'express'
import { csrfProtect, requireAuth, type AuthDependencies } from './auth/index.js'
import {
  TaskStore,
  createRunsRouter,
  createTaskEventsRouter,
  createTasksRouter,
  defaultRunBus,
} from './tasks/index.js'
import type {
  SseRouterOptions,
  TaskRouterOptions,
  TaskRunEventTransport,
} from './tasks/index.js'
import {
  AiSettingsStore,
  createAiSettingsRouter,
  resolveAiEncryptor,
} from './aiSettings/index.js'

interface Item {
  id: number
  name: string
  createdAt: string
}

const MAX_ITEM_NAME_LENGTH = 200

export interface RouterOptions extends TaskRouterOptions {
  /**
   * Optional pre-constructed task store. When omitted a fresh in-memory
   * store is created per router instance (suitable for most scenarios).
   * Inject an explicit store in tests that need to inspect or pre-populate
   * task data.
   */
  tasks?: TaskStore
  /**
   * Optional pre-constructed AI settings store. When omitted a fresh
   * in-memory store is created — with an ephemeral, per-process encryption
   * key in non-production environments and a KMS-backed key
   * (`AI_SETTINGS_ENCRYPTION_KEY`) in production.
   *
   * Inject an explicit store in tests to (a) seed initial state, (b) reuse
   * a stable encryption key across requests, and (c) avoid the console
   * warning `resolveAiEncryptor` emits on the ephemeral-key path.
   */
  aiSettings?: AiSettingsStore
  /**
   * Shared event transport that carries task/run status transitions. The
   * store publishes on it and the SSE endpoint subscribes to it. Defaults
   * to the process-wide `defaultRunBus` (an in-process EventEmitter) when
   * omitted. Multi-replica production deployments MUST pass a distributed
   * transport (Redis Pub/Sub, NATS, …) that satisfies the same
   * `TaskRunEventTransport` interface — otherwise events published on pod
   * A never reach an SSE client connected to pod B. Tests inject an
   * isolated bus so events do not leak across suites.
   */
  runBus?: TaskRunEventTransport
  /** Overrides passed straight through to the SSE endpoint. */
  sseOptions?: SseRouterOptions
}

/**
 * Build the main API router. The auth dependencies are injected so tests can
 * supply an isolated user store / config per suite.
 */
export function createRouter(deps: AuthDependencies, options: RouterOptions = {}): Router {
  const router = Router()
  // Bus is a lightweight in-process pub/sub used by the SSE endpoint. When
  // omitted we default to the process-wide singleton — which is fine for a
  // single-process production deploy, but tests should inject their own so
  // events do not bleed across suites.
  const runBus = options.runBus ?? defaultRunBus
  // WARNING: a new in-memory TaskStore is created when `options.tasks` is
  // omitted. Each distinct router instance gets its own independent store —
  // avoid creating multiple router instances (e.g. in hot-reload or test
  // setups) without injecting a shared store, or task data will not be shared
  // between them. In tests always pass `tasks: taskStore` explicitly.
  //
  // The default in-line store is wired to `runBus` so an SSE client sees
  // task/run mutations without additional plumbing. Callers that inject an
  // explicit store are responsible for wiring the bus themselves (see
  // `new TaskStore({ bus })`).
  const taskStore = options.tasks ?? new TaskStore({ bus: runBus })
  // Same warning applies to the AI settings store: without an explicit
  // instance, hot-reloads produce multiple independent stores. Production
  // wiring (`server/src/index.ts`) constructs a single store and passes it
  // through so all routers share it.
  const aiSettingsStore =
    options.aiSettings ??
    new AiSettingsStore({ encryptor: resolveAiEncryptor() })

  // In-memory storage for demo purposes. Swap for a real store when needed.
  const items: Item[] = [
    { id: 1, name: 'First Item', createdAt: new Date().toISOString() },
    { id: 2, name: 'Second Item', createdAt: new Date().toISOString() },
  ]
  let nextId = items.length + 1

  // Version endpoint is public so unauthenticated clients can perform simple
  // feature/version checks (e.g. from the login page).
  router.get('/version', (_req: Request, res: Response) => {
    res.json({ version: '0.1.0', name: 'routini' })
  })

  // Everything else in this router requires an authenticated user.
  router.use(requireAuth(deps))

  // Real-time task/run event stream. Mounted BEFORE the CRUD router because
  // `router.use('/tasks', …)` would otherwise catch `/tasks/stream` as
  // `GET /:id` inside the tasks sub-router. Mount order = match order in
  // Express, so registering the more-specific prefix first is required.
  router.use(
    '/tasks/stream',
    createTaskEventsRouter(taskStore, runBus, options.sseOptions),
  )
  // Task CRUD + execution triggers (auth-protected; csrf applied per-handler)
  router.use(
    '/tasks',
    createTasksRouter(taskStore, {
      executor: options.executor,
      executeRateLimiter: options.executeRateLimiter,
      // Ensure the retry loop publishes to the same bus the SSE endpoint
      // subscribes to. Caller-supplied launchOptions win so tests can still
      // inject a stub bus if they need one.
      launchOptions: { bus: runBus, ...options.launchOptions },
    }),
  )
  // Run-level read endpoints (auth-protected, read-only so no csrf needed)
  router.use('/runs', createRunsRouter(taskStore))

  // AI settings (auth-protected; PUT is CSRF-guarded inside the sub-router)
  router.use('/settings/ai', createAiSettingsRouter(aiSettingsStore))

  // State-changing endpoints must be application/json — see csrfProtect for
  // the rationale. Reads (GET) are unaffected.
  const csrf = csrfProtect()

  router.get('/items', (_req: Request, res: Response) => {
    res.json({ items, count: items.length })
  })

  router.get('/items/:id', (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const item = items.find((i) => i.id === id)
    if (!item) {
      res.status(404).json({ error: 'Item not found' })
      return
    }
    res.json(item)
  })

  router.post('/items', csrf, (req: Request, res: Response) => {
    const { name } = (req.body ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' })
      return
    }
    if (name.length > MAX_ITEM_NAME_LENGTH) {
      res.status(400).json({ error: 'Name is too long' })
      return
    }

    const newItem: Item = {
      id: nextId++,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    }
    items.push(newItem)
    res.status(201).json(newItem)
  })

  router.delete('/items/:id', csrf, (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const index = items.findIndex((i) => i.id === id)
    if (index === -1) {
      res.status(404).json({ error: 'Item not found' })
      return
    }
    items.splice(index, 1)
    res.json({ message: 'Item deleted', id })
  })

  return router
}
