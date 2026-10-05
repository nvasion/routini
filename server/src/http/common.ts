// ─────────────────────────────────────────────────────────────────────────────
// Shared HTTP plumbing: app context, typed errors, async handler wrapper.
// ─────────────────────────────────────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import type { Org, Role, User } from '../repos/identity.js'
import { EventHub } from '../engine/hub.js'
import { createEngine, type Engine } from '../engine/engine.js'
import type { EngineOptions } from '../engine/types.js'
import { createEnvManager, type EnvManager } from '../engine/environments.js'
import { DockerEnvRuntime, type EnvRuntime } from '../services/envRuntime.js'
import { BrokerClient, brokerConfigFromEnv } from '../egress/client.js'

function brokerFromEnv(): BrokerClient | null {
  const cfg = brokerConfigFromEnv()
  return cfg ? new BrokerClient(cfg) : null
}

/** Everything route factories and the engine need. Built once at boot (or per test). */
export interface AppContext {
  config: Config
  db: Db
  box: SecretBox
  hub: EventHub
  engine: Engine
  envs: EnvManager
  /** Credential broker (egress proxy); null when not configured. */
  broker: BrokerClient | null
  /** Test doubles for http/ssh/imap (shared by the engine and the host check). */
  actions?: EngineOptions['actions']
}

export function createContext(
  base: { config: Config; db: Db; box: SecretBox },
  engineOpts: EngineOptions = {},
  extra: { envRuntime?: EnvRuntime; broker?: BrokerClient | null } = {},
): AppContext {
  const ctx = { ...base, actions: engineOpts.actions } as AppContext
  ctx.hub = new EventHub(base.db)
  ctx.broker = extra.broker === undefined ? brokerFromEnv() : extra.broker
  ctx.envs = createEnvManager({ db: base.db, box: base.box, runtime: extra.envRuntime ?? new DockerEnvRuntime() })
  ctx.engine = createEngine(ctx, engineOpts)
  return ctx
}

declare global {
  namespace Express {
    interface Request {
      user?: User
      /** Set only for cookie auth; requireCsrf compares it to the X-CSRF-Token header. */
      csrfToken?: string
      /** Set by the org middleware for /api/orgs/:org/* routes. */
      org?: Org & { role: Role }
    }
  }
}

/** An error whose message is safe to show the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg)
export const notFound = (msg = 'Not found') => new HttpError(404, msg)
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg)

/** Wraps an async handler so rejections reach the error middleware (Express 4 does not await). */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

/** Final error middleware: HttpErrors pass through; anything else is logged and hidden. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' })
    return
  }
  console.error('[error]', err instanceof Error ? err.message : err)
  res.status(500).json({ error: 'Internal server error' })
}

/** The authenticated user; only call after requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Authentication required')
  return req.user
}

/** The resolved org; only call inside the org router. */
export function currentOrg(req: Request): Org & { role: Role } {
  if (!req.org) throw new Error('currentOrg() used outside an org-scoped route')
  return req.org
}
