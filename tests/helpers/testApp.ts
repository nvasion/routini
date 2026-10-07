// Test harness: a fresh in-memory Postgres (PGlite), migrated, per call.

import supertest from 'supertest'
import type { Express } from 'express'
import { loadConfig, type Config } from '../../server/src/config'
import { openDb } from '../../server/src/db/index'
import { createMigratedSnapshot } from '../../server/src/db/drivers'
import { migrate } from '../../server/src/db/migrations'
import { createSecretBox } from '../../server/src/crypto/secrets'
import { createApp } from '../../server/src/app'
import { createContext, type AppContext } from '../../server/src/http/common'
import type { EngineOptions } from '../../server/src/engine/types'
import type { EnvRuntime } from '../../server/src/services/envRuntime'
import { FakeEnvRuntime } from './fakeEnvRuntime'
import type { BrokerClient } from '../../server/src/egress/client'
import type { ProviderTestContext } from '../../server/src/integrations/providers'
import type { RunnerReleases } from '../../server/src/services/runnerReleases'

export const TEST_MASTER_KEY = '00'.repeat(32)

// One migrated database per test worker; every test clones it (much faster than migrating each time).
let snapshot: Promise<Blob | File> | undefined
export function migratedSnapshot(): Promise<Blob | File> {
  snapshot ??= createMigratedSnapshot((owner) => migrate(owner))
  return snapshot
}

export interface TestApp {
  ctx: AppContext
  app: Express
  request: supertest.Agent
  close(): Promise<void>
  /** Signs up a user and returns a helper that authenticates requests with their Bearer token. */
  signup(email: string, extra?: Record<string, unknown>): Promise<TestUser>
}

export interface TestUser {
  token: string
  csrfToken: string
  userId: string
  orgSlug: string
  orgId: string
  get(path: string): supertest.Test
  post(path: string, body?: unknown): supertest.Test
  put(path: string, body?: unknown): supertest.Test
  del(path: string): supertest.Test
}

export async function makeTestApp(
  opts: {
    config?: Partial<Config>
    providerCtx?: ProviderTestContext
    dataDir?: string
    engine?: EngineOptions
    envRuntime?: EnvRuntime
    broker?: BrokerClient | null
    /** Default: no known release, so tests never ask GitHub. */
    runnerReleases?: RunnerReleases
    /** A fleet environment's ops against an offline runner: default fast, so no test waits out a real grace period. */
    envRunnerOfflineGraceMs?: number
    envRunnerPollMs?: number
  } = {},
): Promise<TestApp> {
  const config: Config = { ...loadConfig({ NODE_ENV: 'test' }), signup: 'open', ...opts.config }
  const db = opts.dataDir
    ? await openDb({ dataDir: opts.dataDir })
    : await openDb({ dataDir: ':memory:', snapshot: await migratedSnapshot() })
  const ctx: AppContext = createContext(
    { config, db, box: createSecretBox(TEST_MASTER_KEY) },
    { retryDelayMs: () => 0, ...opts.engine },
    {
      envRuntime: opts.envRuntime ?? new FakeEnvRuntime(),
      broker: opts.broker ?? null,
      runnerReleases: opts.runnerReleases ?? { latest: async () => null },
      envRunnerOfflineGraceMs: opts.envRunnerOfflineGraceMs ?? 300,
      envRunnerPollMs: opts.envRunnerPollMs ?? 25,
    },
  )
  const app = createApp(ctx, { providerCtx: opts.providerCtx })
  const request = supertest(app)

  return {
    ctx,
    app,
    request: supertest.agent(app),
    close: async () => {
      await ctx.envs.idle()
      await ctx.runners.stop()
      await ctx.hub.stop()
      await db.close()
    },
    async signup(email, extra = {}) {
      const res = await request.post('/api/auth/signup').send({ email, password: 'password123', ...extra })
      if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`)
      return asUser(app, res.body)
    },
  }
}

export function asUser(app: Express, body: { token: string; csrfToken: string; user: { id: string }; orgs: Array<{ slug: string; id: string }> }): TestUser {
  const auth = (t: supertest.Test) => t.set('Authorization', `Bearer ${body.token}`)
  const r = supertest(app)
  return {
    token: body.token,
    csrfToken: body.csrfToken,
    userId: body.user.id,
    orgSlug: body.orgs[0]!.slug,
    orgId: body.orgs[0]!.id,
    get: (p) => auth(r.get(p)),
    post: (p, b) => auth(r.post(p)).send(b as object),
    put: (p, b) => auth(r.put(p)).send(b as object),
    del: (p) => auth(r.delete(p)),
  }
}
