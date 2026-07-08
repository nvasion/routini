/**
 * Centralized environment configuration.
 *
 * Kept in a single module so every consumer reads validated, typed values
 * instead of reaching into `process.env` ad hoc. Adding a new setting in one
 * place also means test doubles and future secrets loaders (Vault, KMS, etc.)
 * have exactly one seam to swap.
 */

const DEFAULT_PORT = 3001
const DEFAULT_CLIENT_ORIGIN = 'http://localhost:5173'

/** Parse a positive integer from a raw env string, or return the fallback. */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback
}

/**
 * Parse a comma-separated list of allowed CORS origins.
 *
 * We never fall back to `*` — an explicit allowlist is a security requirement
 * from the PRD (auth tokens must be scoped to known frontends). Empty or
 * missing config falls back to the dev client origin only.
 */
function parseOrigins(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return parsed.length > 0 ? parsed : fallback
}

export interface AppConfig {
  /** HTTP port the server listens on. */
  port: number
  /** Explicit CORS allowlist. Never contains `*`. */
  allowedOrigins: string[]
  /** True when NODE_ENV === 'production'. */
  isProduction: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT, DEFAULT_PORT),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS, [DEFAULT_CLIENT_ORIGIN]),
    isProduction: env.NODE_ENV === 'production',
  }
}
