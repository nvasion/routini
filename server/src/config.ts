// ─────────────────────────────────────────────────────────────────────────────
// Runtime configuration
//
// Every environment variable the server reads is parsed here, once, into a
// typed Config. Modules receive the Config (or the pieces they need) instead
// of reading process.env themselves, which keeps them testable.
//
// Fail-closed rules for production: JWT_SECRET, COOKIE_SECRET and
// CREDENTIALS_MASTER_KEY must be set. Development and test generate ephemeral
// values with a warning, so the server boots with zero configuration.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

export type RuntimeEnv = 'production' | 'development' | 'test'
/** selfhost: one operator, generous limits. hosted: multi-tenant routini.tynhub.com with plan limits. */
export type DeploymentMode = 'selfhost' | 'hosted'
export type SignupPolicy = 'open' | 'first-user-only' | 'closed'

export interface Config {
  env: RuntimeEnv
  mode: DeploymentMode
  port: number
  /** Postgres connection string. When absent, embedded Postgres (PGlite) is used. */
  databaseUrl?: string
  /** Directory for embedded Postgres data. ':memory:' keeps it in-process (tests). */
  dataDir: string
  jwtSecret: string
  cookieSecret?: string
  /** Raw CREDENTIALS_MASTER_KEY (hex or base64 of 32 bytes); undefined → ephemeral (non-production only). */
  masterKey?: string
  clientUrl: string
  /** Where runners and monitoring tools reach this server (ROUTINI_PUBLIC_URL; default CLIENT_URL). */
  publicUrl: string
  /** Where agent containers reach this server for Routini's MCP tools (ROUTINI_AGENT_API_URL; default publicUrl). */
  agentApiUrl: string
  /** Sign-in with an OIDC provider (TynHub), or null. */
  oidc: { issuer: string; clientId: string; clientSecret: string; name: string; scopes: string } | null
  signup: SignupPolicy
  /**
   * Agent steps and environments need an org owner with a verified email
   * (ROUTINI_REQUIRE_VERIFIED_EMAIL; default on in hosted mode once SMTP_HOST is
   * set, since without mail nobody could verify).
   */
  requireVerifiedEmail: boolean
  /** Header the platform edge sets to the client address (ROUTINI_CLIENT_IP_HEADER, e.g. do-connecting-ip). */
  clientIpHeader?: string
  /** Run the scheduler and queue worker inside the API process. Required with embedded Postgres. */
  inlineWorker: boolean
  /** Bootstrap account created on first boot when the database has no users. */
  seed?: { email: string; password: string }
}

function parseEnv(value: string | undefined): RuntimeEnv {
  if (value === 'production' || value === 'test') return value
  return 'development'
}

function ephemeral(name: string, env: RuntimeEnv): string {
  if (env === 'production') {
    throw new Error(`${name} environment variable must be set in production`)
  }
  if (env !== 'test') {
    console.warn(`[config] ${name} not set – using an ephemeral value (development only).`)
  }
  return randomBytes(32).toString('hex')
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = parseEnv(source['NODE_ENV'])
  const nonEmpty = (key: string): string | undefined => {
    const v = source[key]?.trim()
    return v ? v : undefined
  }

  const mode = nonEmpty('ROUTINI_MODE') === 'hosted' ? 'hosted' : 'selfhost'
  const publicUrl = (nonEmpty('ROUTINI_PUBLIC_URL') ?? nonEmpty('CLIENT_URL') ?? 'http://localhost:5173').replace(/\/+$/, '')

  const signupRaw = nonEmpty('ROUTINI_SIGNUP')
  const signup: SignupPolicy =
    signupRaw === 'open' || signupRaw === 'closed' || signupRaw === 'first-user-only'
      ? signupRaw
      : mode === 'hosted' ? 'open' : 'first-user-only'

  const verifyRaw = nonEmpty('ROUTINI_REQUIRE_VERIFIED_EMAIL')
  const requireVerifiedEmail = verifyRaw ? verifyRaw === 'true' || verifyRaw === '1' : mode === 'hosted' && Boolean(nonEmpty('SMTP_HOST'))

  const databaseUrl = nonEmpty('DATABASE_URL')
  const dataDir = nonEmpty('ROUTINI_DATA_DIR') ?? (env === 'test' ? ':memory:' : resolve('data/pg'))

  if (env === 'production' && !nonEmpty('COOKIE_SECRET')) {
    throw new Error('COOKIE_SECRET environment variable must be set in production')
  }
  const masterKey = nonEmpty('CREDENTIALS_MASTER_KEY')
  if (env === 'production' && !masterKey) {
    throw new Error('CREDENTIALS_MASTER_KEY environment variable must be set in production')
  }

  // Embedded Postgres lives in this process, so the worker must too.
  const inlineRaw = nonEmpty('ROUTINI_INLINE_WORKER')
  const inlineWorker = !databaseUrl ? true : inlineRaw === '1' || inlineRaw === 'true'

  const seedEmail = nonEmpty('SEED_EMAIL')
  const seedPassword = nonEmpty('SEED_PASSWORD')
  let seed: Config['seed']
  if (seedEmail && seedPassword) {
    seed = { email: seedEmail, password: seedPassword }
  } else if (env === 'development') {
    seed = { email: 'admin@routini.dev', password: 'changeme' }
  }

  return {
    env,
    mode,
    port: Number(nonEmpty('PORT') ?? 3001),
    databaseUrl,
    dataDir,
    jwtSecret: nonEmpty('JWT_SECRET') ?? ephemeral('JWT_SECRET', env),
    cookieSecret: nonEmpty('COOKIE_SECRET'),
    masterKey,
    clientUrl: nonEmpty('CLIENT_URL') ?? 'http://localhost:5173',
    publicUrl,
    agentApiUrl: (nonEmpty('ROUTINI_AGENT_API_URL') ?? publicUrl).replace(/\/+$/, ''),
    oidc: oidcFromEnv(nonEmpty),
    signup,
    requireVerifiedEmail,
    clientIpHeader: nonEmpty('ROUTINI_CLIENT_IP_HEADER')?.toLowerCase(),
    inlineWorker,
    seed,
  }
}

/** OIDC sign-in (TynHub or any provider): all of issuer, client id and secret, or nothing. */
function oidcFromEnv(nonEmpty: (k: string) => string | undefined): Config['oidc'] {
  const issuer = nonEmpty('ROUTINI_OIDC_ISSUER')
  const clientId = nonEmpty('ROUTINI_OIDC_CLIENT_ID')
  const clientSecret = nonEmpty('ROUTINI_OIDC_CLIENT_SECRET')
  if (!issuer && !clientId && !clientSecret) return null
  if (!issuer || !clientId || !clientSecret) throw new Error('ROUTINI_OIDC_ISSUER, ROUTINI_OIDC_CLIENT_ID and ROUTINI_OIDC_CLIENT_SECRET must be set together')
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    name: nonEmpty('ROUTINI_OIDC_NAME') ?? 'TynHub',
    scopes: nonEmpty('ROUTINI_OIDC_SCOPES') ?? 'openid profile email orgs',
  }
}
