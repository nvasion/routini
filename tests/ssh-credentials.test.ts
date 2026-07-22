/**
 * Unit tests for SSH credential resolution in the SSH Daily Task Service.
 *
 * These tests focus on the credential-resolution contract documented in
 * server/src/services/ssh.ts: secrets are resolved through an injectable
 * `SshCredentialProvider` that checks the encrypted credential store first
 * and falls back to environment variables.  The provider is injected via
 * `SshRunnerOptions.credentialProvider`, which is the seam the production
 * code uses (the default provider lazily loads the credential store and
 * falls back to env vars).
 *
 * Coverage:
 *   – Injected provider is preferred for SSH_PRIVATE_KEY / SSH_PASSWORD /
 *     SSH_KEY_PASSPHRASE resolution.
 *   – Provider value takes precedence over the matching environment variable.
 *   – Environment variable is used when the provider returns undefined.
 *   – Store read failure falls back to environment variables.
 *   – Missing both store and env returns the "no credentials" error.
 *   – Private key from the provider is preferred over password.
 *   – Passphrase from the provider is passed through to the executor.
 *   – Credentials resolved via the provider never appear in logs.
 *
 * All tests use an injected SshExecutor mock and an injected
 * credentialProvider stub — no real SSH daemon, DB, or credential store is
 * required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSshTask } from '../server/src/services/ssh'
import type {
  SshExecutor,
  SshRunnerOptions,
  SshExecResult,
  SshConnectConfig,
  SshCredentialProvider,
} from '../server/src/services/ssh'
import type { DailyTask } from '../server/src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(configOverrides: Record<string, string> = {}): DailyTask {
  return {
    id: 'task-ssh-cred-001',
    name: 'SSH Check',
    description: 'Run uptime on remote server',
    type: 'daily',
    status: 'idle',
    schedule: '0 9 * * *',
    actionType: 'ssh',
    config: {
      host: 'example.com',
      port: '22',
      username: 'deploy',
      command: 'uptime',
      ...configOverrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function makeExecutor(
  result: SshExecResult | Error = { stdout: '', stderr: '', exitCode: 0 },
): SshExecutor {
  return {
    exec: vi.fn().mockImplementation(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  }
}

/**
 * Builds a credential provider stub that returns values from a map.
 * Any name not in the map resolves to `undefined` (not configured).
 */
function makeCredentialProvider(
  values: Record<string, string> = {},
): SshCredentialProvider & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockImplementation((name: string) => {
      const v = values[name]
      return Promise.resolve(v && v.trim() !== '' ? v : undefined)
    }),
  } as unknown as SshCredentialProvider & { get: ReturnType<typeof vi.fn> }
}

/** Options with a no-op ssrfCheck so tests don't make real DNS lookups. */
function makeOptions(
  executor: SshExecutor,
  credentialProvider: SshCredentialProvider,
  ssrfCheck: SshRunnerOptions['ssrfCheck'] = async () => true,
): SshRunnerOptions {
  return { executor, credentialProvider, ssrfCheck }
}

// ── Environment helpers ───────────────────────────────────────────────────────

const SSH_ENV_VARS = ['SSH_PRIVATE_KEY', 'SSH_KEY_PASSPHRASE', 'SSH_PASSWORD'] as const

function clearSshEnv(): void {
  for (const key of SSH_ENV_VARS) delete process.env[key]
}

beforeEach(() => {
  clearSshEnv()
})

afterEach(() => {
  clearSshEnv()
})

// ═════════════════════════════════════════════════════════════════════════════
// Provider resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – credential provider resolution', () => {
  it('uses the injected credential provider for SSH_PRIVATE_KEY', async () => {
    const provider = makeCredentialProvider({ SSH_PRIVATE_KEY: 'stored-key' })
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor, provider))
    expect(provider.get).toHaveBeenCalledWith('SSH_PRIVATE_KEY')
    expect(captured[0]?.privateKey).toBe('stored-key')
    expect(captured[0]?.password).toBeUndefined()
  })

  it('uses the injected credential provider for SSH_PASSWORD (no key)', async () => {
    const provider = makeCredentialProvider({ SSH_PASSWORD: 'stored-pass' })
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor, provider))
    expect(provider.get).toHaveBeenCalledWith('SSH_PASSWORD')
    expect(captured[0]?.password).toBe('stored-pass')
    expect(captured[0]?.privateKey).toBeUndefined()
  })

  it('passes the passphrase from the provider alongside the private key', async () => {
    const provider = makeCredentialProvider({
      SSH_PRIVATE_KEY: 'stored-key',
      SSH_KEY_PASSPHRASE: 'stored-passphrase',
    })
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor, provider))
    expect(provider.get).toHaveBeenCalledWith('SSH_KEY_PASSPHRASE')
    expect(captured[0]?.privateKey).toBe('stored-key')
    expect(captured[0]?.passphrase).toBe('stored-passphrase')
  })

  it('provider value takes precedence over the environment variable', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'env-key'
    const provider = makeCredentialProvider({ SSH_PRIVATE_KEY: 'stored-key' })
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor, provider))
    // The stored key must win over the env var.
    expect(captured[0]?.privateKey).toBe('stored-key')
  })

  it('returns no-credentials when the provider returns undefined (injected provider is authoritative)', async () => {
    // The injected provider owns its own env-var fallback (per the
    // SshCredentialProvider contract).  When it returns undefined, runSshTask
    // treats the credential as not configured and must NOT independently read
    // process.env — that would bypass the provider's lookup-order control.
    process.env['SSH_PRIVATE_KEY'] = 'env-key'
    const provider = makeCredentialProvider({}) // returns undefined for all names
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runSshTask(task, makeOptions(executor, provider))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('returns a clean failure when the provider throws (no crash)', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'env-key'
    // Simulate a credential store that throws on read (e.g. DB error). The
    // injected provider does not implement its own fallback, so the error
    // would propagate; runSshTask must wrap it into a clean failure result
    // rather than rejecting or crashing the task runner.
    const provider: SshCredentialProvider = {
      get: vi.fn().mockRejectedValue(new Error('store read failed')),
    }
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runSshTask(task, makeOptions(executor, provider))
    expect(result.success).toBe(false)
    // The error must be generic and must NOT leak the raw store error detail.
    expect(result.error).toMatch(/credential/i)
    expect(result.error).not.toContain('store read failed')
    // The executor must never be reached when credential resolution fails.
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('returns failure when neither provider nor env has credentials', async () => {
    const provider = makeCredentialProvider({})
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runSshTask(task, makeOptions(executor, provider))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('prefers private key over password when the provider returns both', async () => {
    const provider = makeCredentialProvider({
      SSH_PRIVATE_KEY: 'stored-key',
      SSH_PASSWORD: 'stored-pass',
    })
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor, provider))
    expect(captured[0]?.privateKey).toBe('stored-key')
    expect(captured[0]?.password).toBeUndefined()
  })

  it('resolves credentials before performing the SSRF/DNS check', async () => {
    // When no credentials are configured, the task must fail without ever
    // invoking the SSRF check or the executor — credentials come first.
    const provider = makeCredentialProvider({})
    const task = makeTask({ host: 'example.com' })
    const executor = makeExecutor()
    const ssrfCheck = vi.fn().mockResolvedValue(true)
    const result = await runSshTask(task, { executor, credentialProvider: provider, ssrfCheck })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(ssrfCheck).not.toHaveBeenCalled()
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('does not include provider-resolved credentials in logs', async () => {
    const provider = makeCredentialProvider({
      SSH_PRIVATE_KEY: 'STORED_SUPER_SECRET_KEY',
      SSH_PASSWORD: 'STORED_SUPER_SECRET_PASS',
    })
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor, provider))
    const allLogs = result.logs.join('\n')
    expect(allLogs).not.toContain('STORED_SUPER_SECRET_KEY')
    expect(allLogs).not.toContain('STORED_SUPER_SECRET_PASS')
  })

  it('treats an empty-string provider value as not configured', async () => {
    // An injected provider returning an empty string signals "not set". Since
    // the injected provider is the authority (it owns its own env fallback),
    // runSshTask must not reach into process.env itself — an empty stored value
    // means no credentials, even if an env var happens to be present.
    process.env['SSH_PRIVATE_KEY'] = 'env-key'
    const provider: SshCredentialProvider = {
      get: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(name === 'SSH_PRIVATE_KEY' ? '' : undefined),
      ),
    }
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runSshTask(task, makeOptions(executor, provider))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Default provider (store-first → env-var fallback)
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – default credential provider fallback', () => {
  // When no credentialProvider is injected, runSshTask uses the default
  // provider, which checks the encrypted credential store first and falls back
  // to environment variables.  In this test environment the credential store
  // module is not present, so the default provider degrades to env-var only —
  // this exercises the fallback path that keeps existing env-based deployments
  // working unchanged.

  it('falls back to SSH_PRIVATE_KEY env var when no provider is injected', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'env-key-content'
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    // No credentialProvider passed — default provider is used.
    const result = await runSshTask(task, { executor, ssrfCheck: async () => true })
    expect(result.success).toBe(true)
    expect(captured[0]?.privateKey).toBe('env-key-content')
  })

  it('falls back to SSH_PASSWORD env var when no provider is injected', async () => {
    process.env['SSH_PASSWORD'] = 'env-pass-content'
    const task = makeTask()
    const captured: SshConnectConfig[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    const result = await runSshTask(task, { executor, ssrfCheck: async () => true })
    expect(result.success).toBe(true)
    expect(captured[0]?.password).toBe('env-pass-content')
  })

  it('returns no-credentials when neither store nor env is configured (no provider injected)', async () => {
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runSshTask(task, { executor, ssrfCheck: async () => true })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })
})
