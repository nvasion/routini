/**
 * Central place to resolve auth configuration from the environment. Kept
 * separate from the runtime code so tests can inject overrides cleanly.
 */

export const AUTH_COOKIE_NAME = 'routini_auth'
/**
 * One hour. A conservative default keeps the blast radius small when a token
 * is stolen — stateless JWTs can only be revoked server-side via the session
 * allowlist, so lower TTL is defense-in-depth. Operators who need longer
 * sessions can raise this via JWT_TTL_SECONDS.
 */
export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60

/** Never accept a TTL longer than 24 hours — guardrail against typos. */
export const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24

/**
 * Rate limiting on the login endpoint. These defaults are hard-coded rather
 * than env-driven to keep the security posture predictable; operators who
 * need to override them can supply LOGIN_RATE_LIMIT_* env vars.
 */
export const DEFAULT_LOGIN_MAX_ATTEMPTS = 10
export const DEFAULT_LOGIN_WINDOW_SECONDS = 60

/** Sentinel default password. Never allowed in production. */
export const DEFAULT_ADMIN_SENTINEL_PASSWORD = 'changeme'

export interface AuthConfig {
  jwtSecret: string
  tokenTtlSeconds: number
  cookieSecure: boolean
  defaultUsername: string
  defaultPassword: string
  /** Absolute path for persistent user storage, or null for in-memory only. */
  userStorePath: string | null
  loginMaxAttempts: number
  loginWindowSeconds: number
}

const MIN_SECRET_LENGTH = 32

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  if (typeof max === 'number' && parsed > max) return max
  return parsed
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET?.trim() ?? ''
  const nodeEnv = env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'

  if (isProduction && jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters in production`,
    )
  }

  // Development fallback keeps the app runnable locally without exposing a real
  // secret in source control. Never trust this outside dev.
  const resolvedSecret =
    jwtSecret.length >= MIN_SECRET_LENGTH
      ? jwtSecret
      : 'routini-dev-secret-do-not-use-in-production-0123456789'

  const tokenTtlSeconds = parsePositiveInt(
    env.JWT_TTL_SECONDS,
    DEFAULT_TOKEN_TTL_SECONDS,
    MAX_TOKEN_TTL_SECONDS,
  )

  const defaultPassword = env.DEFAULT_ADMIN_PASSWORD?.trim() || DEFAULT_ADMIN_SENTINEL_PASSWORD
  if (isProduction && defaultPassword === DEFAULT_ADMIN_SENTINEL_PASSWORD) {
    throw new Error(
      'DEFAULT_ADMIN_PASSWORD must be set to a non-default value in production',
    )
  }

  const userStorePath = env.USER_STORE_PATH?.trim() ?? ''
  if (userStorePath.length > 0 && !userStorePath.startsWith('/')) {
    // Reject relative paths — CWD is fragile across dev / prod deployments.
    throw new Error('USER_STORE_PATH must be an absolute path')
  }

  return {
    jwtSecret: resolvedSecret,
    tokenTtlSeconds,
    cookieSecure: isProduction,
    defaultUsername: env.DEFAULT_ADMIN_USERNAME?.trim() || 'admin',
    defaultPassword,
    userStorePath: userStorePath.length > 0 ? userStorePath : null,
    loginMaxAttempts: parsePositiveInt(
      env.LOGIN_RATE_LIMIT_MAX,
      DEFAULT_LOGIN_MAX_ATTEMPTS,
    ),
    loginWindowSeconds: parsePositiveInt(
      env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_LOGIN_WINDOW_SECONDS,
    ),
  }
}
