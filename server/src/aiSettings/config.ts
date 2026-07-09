/**
 * Environment-driven bootstrap for the AI settings encryption key.
 *
 * Design
 * ──────
 * Production requires the operator to provide a stable, base64-encoded
 * 32-byte key via `AI_SETTINGS_ENCRYPTION_KEY`. Without a stable key,
 * every server restart invalidates every stored API key — an unacceptable
 * regression for a persistent settings store.
 *
 * Development falls back to a per-process random key with a loud warning.
 * That keeps `make dev` runnable without extra setup while still forcing
 * the operator to configure a real key before shipping.
 *
 * Kept as a separate module (rather than folded into `store.ts`) so the
 * store stays trivially unit-testable with a caller-supplied `Encryptor`.
 */

import {
  AI_ENCRYPTION_KEY_BYTES,
  Encryptor,
  EncryptionError,
  generateEncryptionKey,
  parseEncryptionKey,
} from './encryption.js'

export const AI_ENCRYPTION_KEY_ENV = 'AI_SETTINGS_ENCRYPTION_KEY'

/**
 * Resolve an `Encryptor` from the current environment.
 *
 * - Production + no key: throws so the process fails-fast at startup.
 * - Production + malformed key: throws.
 * - Non-production + no key: emits a `console.warn` and returns an
 *   `Encryptor` seeded with a fresh in-process random key.
 * - Any environment + valid key: returns an `Encryptor` seeded with it.
 */
export function resolveAiEncryptor(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, 'warn'> = console,
): Encryptor {
  const rawKey = env[AI_ENCRYPTION_KEY_ENV]?.trim() ?? ''
  const isProduction = env.NODE_ENV === 'production'

  if (rawKey.length === 0) {
    if (isProduction) {
      throw new EncryptionError(
        `${AI_ENCRYPTION_KEY_ENV} is required in production` +
          ` — provide a base64-encoded ${AI_ENCRYPTION_KEY_BYTES}-byte key`,
      )
    }
    logger.warn(
      `[ai-settings] ${AI_ENCRYPTION_KEY_ENV} is not set;` +
        ' generating an ephemeral in-process key — all stored API keys will' +
        ' be invalidated on restart. Do NOT use this in production.',
    )
    return new Encryptor(generateEncryptionKey())
  }

  // parseEncryptionKey throws EncryptionError on any format problem — let it
  // propagate so misconfiguration stops startup rather than silently falling
  // back to a random key.
  return new Encryptor(parseEncryptionKey(rawKey))
}
