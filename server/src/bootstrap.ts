// ─────────────────────────────────────────────────────────────────────────────
// Boot-time setup: open the database, build the app context, seed the first
// account. Shared by index.ts (API) and, from M2, worker.ts.
// ─────────────────────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs'
import { loadConfig, type Config } from './config.js'
import { openDb } from './db/index.js'
import { createSecretBox } from './crypto/secrets.js'
import type { AppContext } from './http/common.js'
import { addIdentity, addMembership, countUsers, createOrg, createUser } from './repos/identity.js'

export async function bootstrap(config: Config = loadConfig()): Promise<AppContext> {
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir })
  const ctx: AppContext = { config, db, box: createSecretBox(config.masterKey) }
  await seedFirstAccount(ctx)
  return ctx
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
    const user = await createUser(q, { email: seed.email, passwordHash: hash, displayName: 'Admin' })
    await addIdentity(q, user.id, 'local', user.email.toLowerCase())
    const org = await createOrg(q, { name: 'Default', slugBase: 'default', plan: ctx.config.mode === 'hosted' ? 'free' : 'selfhost' })
    await addMembership(q, org.id, user.id, 'owner')
    console.log(`[bootstrap] created first account ${seed.email} with org "${org.slug}"`)
    return true
  })
}
