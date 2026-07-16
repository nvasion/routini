/**
 * Unit tests for the IMAP Email Check Service.
 *
 * Coverage:
 *   – Config validation: required fields, port range, SSRF host guard,
 *     TLS flag parsing, search criteria mapping
 *   – runImapTask: missing IMAP_PASS, successful check (count = 0 and > 0),
 *     executor errors, credential safety in logs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runImapTask } from '../server/src/services/imap'
import type { ImapExecutor, ImapRunnerOptions, ImapCheckConfig } from '../server/src/services/imap'
import type { DailyTask } from '../server/src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(configOverrides: Record<string, string> = {}): DailyTask {
  return {
    id: 'task-imap-001',
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

function makeExecutor(matchingIds: number[] | Error = []): ImapExecutor {
  return {
    check: vi.fn().mockImplementation(() =>
      matchingIds instanceof Error
        ? Promise.reject(matchingIds)
        : Promise.resolve({ matchingIds }),
    ),
  }
}

// ── Environment helpers ───────────────────────────────────────────────────────

beforeEach(() => {
  delete process.env['IMAP_PASS']
})

afterEach(() => {
  delete process.env['IMAP_PASS']
})

// ═════════════════════════════════════════════════════════════════════════════
// Config validation
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask – config validation', () => {
  it('returns failure when host is missing', async () => {
    const task = makeTask({ host: '' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/host/i)
  })

  it('returns failure when username is missing', async () => {
    const task = makeTask({ username: '' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/username/i)
  })

  it('returns failure for an invalid port string', async () => {
    const task = makeTask({ port: 'xyz' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('returns failure for port 0', async () => {
    const task = makeTask({ port: '0' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('returns failure for an unknown searchCriteria', async () => {
    const task = makeTask({ searchCriteria: 'SINCE 1-Jan-2020' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/searchCriteria/i)
  })

  it('accepts SEEN as a valid criteria', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask({ searchCriteria: 'SEEN' })
    const executor = makeExecutor([1, 2])
    const result = await runImapTask(task, { executor })
    // Valid criteria — should succeed
    expect(result.success).toBe(true)
  })

  it('accepts ALL as a valid criteria', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask({ searchCriteria: 'ALL' })
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(true)
  })

  it('accepts FLAGGED as a valid criteria', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask({ searchCriteria: 'FLAGGED' })
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(true)
  })

  it('accepts UNFLAGGED as a valid criteria', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask({ searchCriteria: 'UNFLAGGED' })
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(true)
  })

  it('uses INBOX as the default mailbox when not specified', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask()
    delete (task.config as Record<string, string>)['mailbox']
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.mailbox).toBe('INBOX')
  })

  it('uses UNSEEN as the default searchCriteria when not specified', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask()
    delete (task.config as Record<string, string>)['searchCriteria']
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    // Default criteria = UNSEEN → { seen: false }
    expect(capturedConfigs[0]?.searchCriteria).toEqual({ seen: false })
  })

  it('uses port 993 as default when not specified', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask()
    delete (task.config as Record<string, string>)['port']
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.port).toBe(993)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SSRF guard
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask – SSRF guard', () => {
  it('blocks localhost', async () => {
    const task = makeTask({ host: 'localhost' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 127.0.0.1', async () => {
    const task = makeTask({ host: '127.0.0.1' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 10.1.2.3 (RFC 1918)', async () => {
    const task = makeTask({ host: '10.1.2.3' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks .local domains', async () => {
    const task = makeTask({ host: 'mail.home.local' })
    const result = await runImapTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('allows a public IMAP hostname', async () => {
    process.env['IMAP_PASS'] = 'pass'
    const task = makeTask({ host: 'imap.gmail.com' })
    const executor = makeExecutor([])
    await runImapTask(task, { executor })
    expect(executor.check).toHaveBeenCalledOnce()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Credential checks
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask – credential handling', () => {
  it('returns failure when IMAP_PASS is not set', async () => {
    const task = makeTask()
    const executor = makeExecutor()
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/IMAP_PASS/i)
    expect(executor.check).not.toHaveBeenCalled()
  })

  it('passes the IMAP_PASS to the executor', async () => {
    process.env['IMAP_PASS'] = 'my-secret-password'
    const task = makeTask()
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.password).toBe('my-secret-password')
  })

  it('does not include the password in logs', async () => {
    process.env['IMAP_PASS'] = 'TOP_SECRET_PASSWORD'
    const task = makeTask()
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.logs.join('\n')).not.toContain('TOP_SECRET_PASSWORD')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Successful execution
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask – successful execution', () => {
  beforeEach(() => {
    process.env['IMAP_PASS'] = 'pass'
  })

  it('returns success when executor resolves', async () => {
    const task = makeTask()
    const executor = makeExecutor([1, 2, 3])
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns the correct message count', async () => {
    const task = makeTask()
    const executor = makeExecutor([10, 20, 30])
    const result = await runImapTask(task, { executor })
    expect(result.messageCount).toBe(3)
  })

  it('returns 0 count when no messages match', async () => {
    const task = makeTask()
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(true)
    expect(result.messageCount).toBe(0)
  })

  it('includes message count in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor([1, 2])
    const result = await runImapTask(task, { executor })
    const combined = result.logs.join('\n')
    expect(combined).toContain('2')
  })

  it('includes the mailbox name in logs', async () => {
    const task = makeTask({ mailbox: 'Sent' })
    const executor = makeExecutor([])
    const result = await runImapTask(task, { executor })
    expect(result.logs.join('\n')).toContain('Sent')
  })

  it('passes host, port, and username to the executor', async () => {
    const task = makeTask({ host: 'mail.company.com', port: '143', username: 'ops@company.com' })
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.host).toBe('mail.company.com')
    expect(capturedConfigs[0]?.port).toBe(143)
    expect(capturedConfigs[0]?.username).toBe('ops@company.com')
  })

  it('passes tls=false when configured', async () => {
    const task = makeTask({ tls: 'false' })
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.secure).toBe(false)
  })

  it('defaults tls to true when not specified', async () => {
    const task = makeTask()
    delete (task.config as Record<string, string>)['tls']
    const capturedConfigs: ImapCheckConfig[] = []
    const executor: ImapExecutor = {
      check: vi.fn().mockImplementation((cfg: ImapCheckConfig) => {
        capturedConfigs.push(cfg)
        return Promise.resolve({ matchingIds: [] })
      }),
    }
    await runImapTask(task, { executor })
    expect(capturedConfigs[0]?.secure).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Executor errors
// ═════════════════════════════════════════════════════════════════════════════

describe('runImapTask – executor errors', () => {
  beforeEach(() => {
    process.env['IMAP_PASS'] = 'pass'
  })

  it('returns failure when executor throws', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('Connection refused'))
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('wraps executor errors with task context', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('Connection refused'))
    const result = await runImapTask(task, { executor })
    expect(result.error).toContain('task-imap-001')
  })

  it('includes the error message in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('Authentication failed'))
    const result = await runImapTask(task, { executor })
    expect(result.logs.join('\n')).toContain('Authentication failed')
  })

  it('sanitizes password from error messages', async () => {
    const task = makeTask()
    const executor: ImapExecutor = {
      check: vi.fn().mockRejectedValue(new Error('auth pass=TOP_SECRET failed')),
    }
    const result = await runImapTask(task, { executor })
    expect(result.logs.join('\n')).not.toContain('TOP_SECRET')
    expect(result.error).not.toContain('TOP_SECRET')
  })

  it('handles non-Error rejections gracefully', async () => {
    const task = makeTask()
    const executor: ImapExecutor = {
      check: vi.fn().mockRejectedValue('timeout string'),
    }
    const result = await runImapTask(task, { executor })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
