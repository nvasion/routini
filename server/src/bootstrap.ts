// ─────────────────────────────────────────────────────────────────────────────
// Boot-time setup shared by the API (index.ts) and the worker (worker.ts):
// open the database, build the app context, seed the first account, and start
// the background engine (scheduler + queue worker) when asked to.
// ─────────────────────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs'
import { loadConfig, type Config } from './config.js'
import { openDb } from './db/index.js'
import { createSecretBox } from './crypto/secrets.js'
import { createContext, type AppContext } from './http/common.js'
import { addIdentity, addMembership, countUsers, createOrg, createUser, pruneRevokedTokens } from './repos/identity.js'
import { runNotifier } from './engine/notify.js'
import { Scheduler } from './engine/scheduler.js'
import { Worker } from './engine/worker.js'
import { agentExecutor, defaultAgentImages, killStepContainers } from './engine/agent.js'
import { DockerService } from './services/docker.js'
import { cancelStepRunnerTasks } from './repos/runners.js'

export async function bootstrap(config: Config = loadConfig()): Promise<AppContext> {
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir })
  const base = { config, db, box: createSecretBox(config.masterKey) }
  // Docker comes from DOCKER_HOST (local socket by default; ssh:// or tcp:// for a remote runner host).
  const docker = new DockerService()
  const ctx = createContext(base, {
    executors: { agent: agentExecutor({ docker }) },
    onStepLost: async (run, idx) => {
      const killed = await killStepContainers(docker, run.id, idx)
      if (killed) console.log(`[engine] removed ${killed} orphaned container(s) of run ${run.id} step ${idx}`)
      // Commands it left running on runners: ask the runners to stop them.
      await base.db.org(run.orgId, (q) => cancelStepRunnerTasks(q, run.orgId, run.id, idx))
    },
    onRunFinished: runNotifier(base),
  })
  await seedFirstAccount(ctx)
  return ctx
}

export interface Background {
  stop(): Promise<void>
}

/** Starts the scheduler, the queue worker, and token housekeeping. */
export async function startBackground(ctx: AppContext): Promise<Background> {
  const worker = new Worker(ctx, ctx.engine, { concurrency: Number(process.env['ROUTINI_WORKER_CONCURRENCY'] ?? 4) })
  const scheduler = new Scheduler(ctx.db)
  await worker.start()
  scheduler.start()
  const prune = setInterval(() => {
    pruneRevokedTokens(ctx.db).catch(() => {})
  }, 60 * 60 * 1000)
  // Environments: reconcile with Docker and stop idle ones every minute.
  const sweep = setInterval(() => {
    ctx.envs.sweep().catch((err) => console.error('[environments] sweep failed:', (err as Error).message))
  }, 60 * 1000)
  // Pre-pull agent images so the first run (or environment) does not wait on a download.
  for (const image of new Set(Object.values(defaultAgentImages()).filter((i): i is string => Boolean(i)))) {
    ctx.envs.runtime.pull(image).catch(() => {
      // Locally built images (e.g. routini/agent-claude:latest) have no registry; that is fine.
    })
  }
  console.log(`[engine] worker ${worker.id} and scheduler started`)
  return {
    async stop() {
      clearInterval(prune)
      clearInterval(sweep)
      await scheduler.stop()
      await worker.stop()
    },
  }
}

/**
 * When the database has no users and a seed account is configured (SEED_EMAIL /
 * SEED_PASSWORD, or the development default), creates that user with an org.
 * Never touches an existing database, so changing SEED_* later does nothing.
 */
export async function seedFirstAccount(ctx: AppContext): Promise<boolean> {
  const seed = ctx.config.seed
  if (!seed) return false
  const hash = await bcrypt.hash(seed.password, ctx.config.env === 'test' ? 1 : 10)
  return ctx.db.tx(async (q) => {
    await q.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
    if ((await countUsers(q)) > 0) return false
    const user = await createUser(q, { email: seed.email, passwordHash: hash, displayName: 'Admin', emailVerified: true })
    await addIdentity(q, user.id, 'local', user.email.toLowerCase())
    const org = await createOrg(q, { name: 'Default', slugBase: 'default', plan: ctx.config.mode === 'hosted' ? 'free' : 'selfhost' })
    await addMembership(q, org.id, user.id, 'owner')
    console.log(`[bootstrap] created first account ${seed.email} with org "${org.slug}"`)
    return true
  })
}
