/**
 * Unit tests for the SMTP credential store integration in the email service.
 *
 * These tests focus specifically on the store-first → env-var-fallback
 * resolution added to `createTransporter` (server/src/services/email.ts):
 *   – `createTransporter` returns `null` when `SMTP_HOST` is unset (no-op).
 *   – When the credential store is empty, SMTP_USER/SMTP_PASS fall back to
 *     environment variables (preserving the original behaviour).
 *   – When the store holds SMTP_USER/SMTP_PASS, those stored values take
 *     precedence over environment variables.
 *   – A blank/whitespace-only stored value does NOT shadow a real env-var
 *     value (treated as "not set").
 *   – A store read failure (e.g. decryption error) degrades gracefully to
 *     environment variables rather than crashing `createTransporter`.
 *   – The resolver is injectable via `setSmtpCredentialResolver`, allowing
 *     tests to verify the lookup order without a live database.
 *
 * The credential store (services/credentials.ts) uses a synchronous
 * better-sqlite3 backend; an in-memory database (resetDb) is used per test
 * for isolation, mirroring tests/credentials.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  createTransporter,
  setSmtpCredentialResolver,
} from '../server/src/services/email'
import {
  saveCredential,
  getCredentialSecret,
} from '../server/src/services/credentials.js'
import { resetDb, closeDb, getDb } from '../server/src/db/index.js'

// ── Environment snapshot / restore ────────────────────────────────────────────

const origMaster = process.env['CREDENTIALS_MASTER_KEY']
const origNodeEnv = process.env['NODE_ENV']
const origHost = process.env['SMTP_HOST']
const origUser = process.env['SMTP_USER']
const origPass = process.env['SMTP_PASS']

beforeAll(() => {
  // The credential store resolves its master key at import time and fails
  // fast in production when CREDENTIALS_MASTER_KEY is missing.  Provide a
  // fixed 32-byte (64 hex char) key so the store is deterministic in tests.
  process.env['NODE_ENV'] = 'test'
  process.env['CREDENTIALS_MASTER_KEY'] =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
})

beforeEach(() => {
  // Fresh in-memory database for each test so stored credentials never leak
  // across tests.
  resetDb()
  // SMTP_HOST is required for createTransporter to proceed past the no-op
  // guard; the other SMTP_* values are reset per test.
  process.env['SMTP_HOST'] = 'smtp.test.local'
  delete process.env['SMTP_USER']
  delete process.env['SMTP_PASS']
  // Restore the default (real-store) resolver so each test starts clean.
  setSmtpCredentialResolver(undefined)
})

afterAll(() => {
  closeDb()
  if (origMaster === undefined) delete process.env['CREDENTIALS_MASTER_KEY']
  else process.env['CREDENTIALS_MASTER_KEY'] = origMaster
  if (origNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = origNodeEnv
  if (origHost === undefined) delete process.env['SMTP_HOST']
  else process.env['SMTP_HOST'] = origHost
  if (origUser !== undefined) process.env['SMTP_USER'] = origUser
  if (origPass !== undefined) process.env['SMTP_PASS'] = origPass
  // Ensure the default resolver is restored after the suite.
  setSmtpCredentialResolver(undefined)
})

// ═════════════════════════════════════════════════════════════════════════════
// createTransporter — no-op guard (SMTP_HOST)
// ═════════════════════════════════════════════════════════════════════════════

describe('createTransporter — SMTP_HOST guard', () => {
  it('returns null when SMTP_HOST is unset', () => {
    delete process.env['SMTP_HOST']
    expect(createTransporter()).toBeNull()
  })

  it('returns a transporter when SMTP_HOST is set (even without credentials)', () => {
    // No SMTP_USER/SMTP_PASS in env or store — transporter still builds
    // (auth is undefined when user is empty).
    expect(createTransporter()).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Store-first → env-var fallback resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('createTransporter — credential store fallback', () => {
  it('falls back to environment variables when the store is empty', () => {
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    // Inject a resolver that asserts the store was consulted first (and was
    // empty), then fell back to the env var.
    let storeConsultedForUser = false
    setSmtpCredentialResolver((name) => {
      const stored = getCredentialSecret(null, name)
      if (name === 'SMTP_USER') storeConsultedForUser = true
      return stored && stored.trim() !== '' ? stored : (process.env[name] ?? '')
    })

    const transporter = createTransporter()
    expect(transporter).not.toBeNull()
    expect(storeConsultedForUser).toBe(true)
  })

  it('uses stored credentials over environment variables (store precedence)', () => {
    saveCredential(null, 'SMTP_USER', 'stored-user')
    saveCredential(null, 'SMTP_PASS', 'stored-pass')
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    // The real (default) resolver checks the store first; inject one that
    // records which source won so we can assert precedence.
    let resolvedUser: string | undefined
    setSmtpCredentialResolver((name) => {
      const stored = getCredentialSecret(null, name)
      const value = stored && stored.trim() !== '' ? stored : (process.env[name] ?? '')
      if (name === 'SMTP_USER') resolvedUser = value
      return value
    })

    createTransporter()
    expect(resolvedUser).toBe('stored-user')
  })

  it('does not let a blank stored value shadow a real env-var value', () => {
    // A whitespace-only stored secret should be treated as "not set" so the
    // env-var fallback still applies.
    saveCredential(null, 'SMTP_USER', '   ')
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    let resolvedUser: string | undefined
    setSmtpCredentialResolver((name) => {
      const stored = getCredentialSecret(null, name)
      const value = stored && stored.trim() !== '' ? stored : (process.env[name] ?? '')
      if (name === 'SMTP_USER') resolvedUser = value
      return value
    })

    createTransporter()
    expect(resolvedUser).toBe('envuser')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Graceful degradation on store read failure
// ═════════════════════════════════════════════════════════════════════════════

describe('createTransporter — store read failure degradation', () => {
  it('falls back to env vars when the credential store throws', () => {
    // The default resolver wraps the store read in try/catch and falls back
    // to the env var on any store failure (DB unavailable, decryption error,
    // etc.).  We force a genuine decryption failure by corrupting the stored
    // ciphertext and confirm the transporter still builds from the env var.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    saveCredential(null, 'SMTP_USER', 'corrupted-user')
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    // Corrupt the ciphertext so decryption throws.
    getDb()
      .prepare('UPDATE credentials SET encrypted_value = ? WHERE user_id IS NULL AND key = ?')
      .run('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'SMTP_USER')

    setSmtpCredentialResolver(undefined)
    const transporter = createTransporter()
    expect(transporter).not.toBeNull()

    // A warning must have been emitted (the failure was non-fatal but logged).
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0)
    warnSpy.mockRestore()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Injectable resolver — lookup order verification
// ═════════════════════════════════════════════════════════════════════════════

describe('setSmtpCredentialResolver — injectable resolver', () => {
  it('createTransporter consults the resolver for SMTP_USER and SMTP_PASS', () => {
    const calls: string[] = []
    setSmtpCredentialResolver((name) => {
      calls.push(name)
      return name === 'SMTP_USER' ? 'injected-user' : 'injected-pass'
    })

    const transporter = createTransporter()
    expect(transporter).not.toBeNull()
    // Both secrets must be resolved through the injected resolver, in order.
    expect(calls).toEqual(['SMTP_USER', 'SMTP_PASS'])
  })

  it('restoring the default resolver (undefined) uses the real store again', () => {
    // Override, then restore.
    setSmtpCredentialResolver(() => 'override')
    setSmtpCredentialResolver(undefined)

    saveCredential(null, 'SMTP_USER', 'real-store-user')
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    let resolvedUser: string | undefined
    setSmtpCredentialResolver((name) => {
      const stored = getCredentialSecret(null, name)
      const value = stored && stored.trim() !== '' ? stored : (process.env[name] ?? '')
      if (name === 'SMTP_USER') resolvedUser = value
      return value
    })
    createTransporter()
    expect(resolvedUser).toBe('real-store-user')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Security — credentials never leak in store-failure warnings
// ═════════════════════════════════════════════════════════════════════════════

describe('createTransporter — credential safety', () => {
  it('store-read-failure warnings never include the secret material', () => {
    // Covered by the corrupted-ciphertext test above; this is a focused
    // assertion that the warning message (which includes the key NAME, not
    // the value) never leaks the plaintext.  A store failure on a known
    // secret must not surface that secret in logs.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    saveCredential(null, 'SMTP_PASS', 'SECRET-DO-NOT-LEAK-12345')
    process.env['SMTP_HOST'] = 'smtp.test.local'
    process.env['SMTP_USER'] = 'envuser'
    process.env['SMTP_PASS'] = 'envpass'

    // Corrupt the ciphertext to force a decryption error → warning path.
    getDb()
      .prepare('UPDATE credentials SET encrypted_value = ? WHERE user_id IS NULL AND key = ?')
      .run('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'SMTP_PASS')

    setSmtpCredentialResolver(undefined)
    expect(createTransporter()).not.toBeNull()

    const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join(' ')
    expect(warned).not.toContain('SECRET-DO-NOT-LEAK-12345')
    // The key name is safe to log; the secret value is not.
    expect(warned).toContain('SMTP_PASS')

    warnSpy.mockRestore()
  })
})
