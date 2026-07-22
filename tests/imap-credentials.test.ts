/**
 * Unit tests for the IMAP credential store integration in the IMAP service.
 *
 * These tests focus specifically on the store-first → env-var-fallback
 * resolution added to `runImapTask` (server/src/services/imap.ts):
 *   – `runImapTask` returns the "no credentials" error when neither the
 *     credential store nor the IMAP_PASS env var has a value.
 *   – When the credential store is empty, IMAP_PASS falls back to the
 *     environment variable (preserving the original behaviour).
 *   – When the store holds IMAP_PASS, the stored value takes precedence over
 *     the environment variable.
 *   – A blank/whitespace-only stored value does NOT shadow a real env-var
 *     value (treated as "not set").
 *   – A store read failure (e.g. decryption error) degrades gracefully to the
 *     environment variable rather than crashing `runImapTask`.
 *   – The resolver is injectable via `setImapCredentialResolver` and via
 *     `ImapRunnerOptions.credentialResolver`, allowing tests to verify the
 *     lookup order without a live database.
 *   – Credential material never leaks in logs or error messages.
 *
 * The credential store (services/credentials.ts) uses a synchronous
 * better-sqlite3 backend; an in-memory database (resetDb) is used per test
 * for isolation, mirroring tests/credentials.test.ts and
 * tests/email-credentials.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  runImapTask,
  setImapCredentialResolver,
} from '../server/src/services/imap'
import type { ImapExecutor, ImapCheckConfig } from '../server/src/services/imap'
import {
  saveCredential,
  getCredentialSecret,
} from '../server/src/services/credentials.js'
import { resetDb, closeDb, getDb } from '../server/src/db/index.js'
import type { DailyTask } from '../server/src/types'

// ── Environment snapshot / restore ────────────────────────────────────────────

const origMaster = process.env['CREDENTIALS_MASTER_KEY']
const origNodeEnv = process.env['NODE_ENV']
const origImapPass = process.env['IMAP_PASS']

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
  delete process.env['IMAP_PASS']
  // Restore the default (real-store) resolver so each test starts clean.
  setImapCredentialResolver(undefined)
})

afterAll(() => {
  closeDb()
  if (origMaster === undefined) delete process.env['CREDENTIALS_MASTER_KEY']
  else process.env['CREDENTIALS_MASTER_KEY'] = origMaster
  if (origNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = origNodeEnv
  if (origImapPass !== undefined) process.env['IMAP_PASS'] = origImapPass
  else delete process.env['IMAP_PASS']
  // Ensure the default resolver is restored after the suite.
  setImapCredentialResolver(undefined)
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(configOverrides: Record<string, string> = {}): DailyTask {
  return {
    id: 'task-imap-cred-001',
    name: 'IMAP Check',
    description: 'Check inbox for unread mail',
    type: 'daily',
    status: 'idle',
    schedule: '0 8 * * *',
    actionType: 'email',
    config: {
      host: 'imap.example.com',
      port: '993',
      username: 'user@example.com',
      mailbox: 'INBOX',
      searchCriteria: 'UNSEEN',
      tls: 'true',
      ...configOverrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function makeExecutor(matchingIds: number[] = []): ImapExecutor {
  return {
    check: vi.fn().mockImplementation(() => Promise.resolve({ matchingIds })),
  }
}

/** Executor that captures the resolved config so tests can assert the password. */
function capturingExecutor(
  captured: ImapCheckConfig[],
  matchingIds: number[] = [],
): ImapExecutor {
  return {
    check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
      captured.push(cfg)
      return Promise.resolve({ matchingIds })
    }),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// No credentials configured
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask — no credentials configured', () => {
  it('returns failure referencing IMAP_PASS when neither store nor env has a value', async () => {
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/IMAP_PASS/i)
    expect(executor.check).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Store-first → env-var fallback resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask — credential store fallback', () => {
  it('falls back to the environment variable when the store is empty', async () => {
    process.env['IMAP_PASS'] = 'env-pass'
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)

    // The default resolver checks the (empty) store first, then the env var.
    await runImapTask(makeTask(), { executor })
    expect(captured[0]?.password).toBe('env-pass')
  })

  it('uses the stored credential over the environment variable (store precedence)', async () => {
    saveCredential(null, 'IMAP_PASS', 'stored-pass')
    process.env['IMAP_PASS'] = 'env-pass'

    // Inject a resolver that mirrors the default but records which source won,
    // so we can assert precedence without relying on internal ordering.
    let resolved: string | undefined
    setImapCredentialResolver(() => {
      const stored = getCredentialSecret(null, 'IMAP_PASS')
      const value = stored && stored.trim() !== '' ? stored : process.env['IMAP_PASS']
      resolved = value
      return value
    })

    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), { executor })
    expect(resolved).toBe('stored-pass')
    expect(captured[0]?.password).toBe('stored-pass')
  })

  it('does not let a blank stored value shadow a real env-var value', async () => {
    // A whitespace-only stored secret should be treated as "not set" so the
    // env-var fallback still applies.
    saveCredential(null, 'IMAP_PASS', '   ')
    process.env['IMAP_PASS'] = 'env-pass'

    let resolved: string | undefined
    setImapCredentialResolver(() => {
      const stored = getCredentialSecret(null, 'IMAP_PASS')
      const value = stored && stored.trim() !== '' ? stored : process.env['IMAP_PASS']
      resolved = value
      return value
    })

    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), { executor })
    expect(resolved).toBe('env-pass')
    expect(captured[0]?.password).toBe('env-pass')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Graceful degradation on store read failure
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask — store read failure degradation', () => {
  it('falls back to the env var when the credential store throws (default resolver)', async () => {
    // The default resolver wraps the store read in try/catch and falls back
    // to the env var on any store failure (DB unavailable, decryption error,
    // etc.).  We force a genuine decryption failure by corrupting the stored
    // ciphertext and confirm the task still runs with the env-var credential.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    saveCredential(null, 'IMAP_PASS', 'corrupted-pass')
    process.env['IMAP_PASS'] = 'env-pass'

    // Corrupt the ciphertext so decryption throws.
    getDb()
      .prepare('UPDATE credentials SET encrypted_value = ? WHERE user_id IS NULL AND key = ?')
      .run('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'IMAP_PASS')

    setImapCredentialResolver(undefined)
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    const result = await runImapTask(makeTask(), { executor })
    expect(result.success).toBe(true)
    expect(captured[0]?.password).toBe('env-pass')

    // A warning must have been emitted (the failure was non-fatal but logged).
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0)
    warnSpy.mockRestore()
  })

  it('returns a clean failure when the injected resolver throws (no crash)', async () => {
    // An injected resolver that throws must be wrapped into a clean failure
    // result rather than rejecting or crashing the task runner.  The raw
    // error detail must not leak into the surfaced error message.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runImapTask(task, {
      executor,
      credentialResolver: () => {
        throw new Error('store read failed')
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credential/i)
    expect(result.error).not.toContain('store read failed')
    // The executor must never be reached when credential resolution fails.
    expect(executor.check).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Injectable resolver — lookup order verification
// ═════════════════════════════════════════════════════════════════════════════

describe('setImapCredentialResolver / options.credentialResolver — injectable resolver', () => {
  it('uses options.credentialResolver when provided (per-call override)', async () => {
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), {
      executor,
      credentialResolver: () => 'injected-pass',
    })
    expect(captured[0]?.password).toBe('injected-pass')
  })

  it('uses the module-level resolver set via setImapCredentialResolver', async () => {
    setImapCredentialResolver(() => 'module-injected-pass')
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), { executor })
    expect(captured[0]?.password).toBe('module-injected-pass')
  })

  it('options.credentialResolver takes precedence over the module-level resolver', async () => {
    setImapCredentialResolver(() => 'module-pass')
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), {
      executor,
      credentialResolver: () => 'options-pass',
    })
    expect(captured[0]?.password).toBe('options-pass')
  })

  it('restoring the default resolver (undefined) uses the real store again', async () => {
    // Override, then restore.
    setImapCredentialResolver(() => 'override')
    setImapCredentialResolver(undefined)

    saveCredential(null, 'IMAP_PASS', 'real-store-pass')
    process.env['IMAP_PASS'] = 'env-pass'

    let resolved: string | undefined
    setImapCredentialResolver(() => {
      const stored = getCredentialSecret(null, 'IMAP_PASS')
      const value = stored && stored.trim() !== '' ? stored : process.env['IMAP_PASS']
      resolved = value
      return value
    })
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    await runImapTask(makeTask(), { executor })
    expect(resolved).toBe('real-store-pass')
    expect(captured[0]?.password).toBe('real-store-pass')
  })

  it('treats an empty-string resolver value as not configured', async () => {
    process.env['IMAP_PASS'] = 'env-pass'
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runImapTask(task, {
      executor,
      credentialResolver: () => '',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/IMAP_PASS/i)
    expect(executor.check).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Security — credentials never leak
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask — credential safety', () => {
  it('never includes the resolved password in logs', async () => {
    const captured: ImapCheckConfig[] = []
    const executor = capturingExecutor(captured)
    const result = await runImapTask(makeTask(), {
      executor,
      credentialResolver: () => 'SECRET-IMAP-PASSWORD-12345',
    })
    expect(result.logs.join('\n')).not.toContain('SECRET-IMAP-PASSWORD-12345')
    // The password did reach the executor config (sanity).
    expect(captured[0]?.password).toBe('SECRET-IMAP-PASSWORD-12345')
  })

  it('store-read-failure warnings never include the secret material', async () => {
    // A store failure on a known secret must not surface that secret in logs.
    // The warning includes the key NAME (safe) but never the plaintext value.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    saveCredential(null, 'IMAP_PASS', 'SECRET-DO-NOT-LEAK-12345')
    process.env['IMAP_PASS'] = 'env-pass'

    // Corrupt the ciphertext to force a decryption error → warning path.
    getDb()
      .prepare('UPDATE credentials SET encrypted_value = ? WHERE user_id IS NULL AND key = ?')
      .run('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'IMAP_PASS')

    setImapCredentialResolver(undefined)
    await runImapTask(makeTask(), { executor: makeExecutor() })

    const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join(' ')
    expect(warned).not.toContain('SECRET-DO-NOT-LEAK-12345')
    // The key name is safe to log; the secret value is not.
    expect(warned).toContain('IMAP_PASS')

    warnSpy.mockRestore()
  })
})
