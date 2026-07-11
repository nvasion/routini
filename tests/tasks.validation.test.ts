import { describe, it, expect } from 'vitest'
import {
  validateCreateTask,
  validateUpdateTask,
  validateUrl,
  validateCron,
  validateBranchName,
  isSsrfUnsafeHostname,
  VALID_AGENTS,
} from '../server/src/tasks/validation.js'
import type { DailyTask, DevelopmentalTask, RoutineTask } from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(errors: string[]): void {
  expect(errors).toHaveLength(0)
}

function fails(errors: string[], fragment: string): void {
  expect(errors.length).toBeGreaterThan(0)
  const joined = errors.join(' ')
  expect(joined.toLowerCase()).toContain(fragment.toLowerCase())
}

// ---------------------------------------------------------------------------
// SSRF / URL validators
// ---------------------------------------------------------------------------

describe('isSsrfUnsafeHostname', () => {
  it('blocks localhost', () => {
    expect(isSsrfUnsafeHostname('localhost')).toBe(true)
  })

  it('blocks 127.x.x.x loopback', () => {
    expect(isSsrfUnsafeHostname('127.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('127.255.255.255')).toBe(true)
  })

  it('blocks 0.0.0.0 wildcard', () => {
    expect(isSsrfUnsafeHostname('0.0.0.0')).toBe(true)
  })

  it('blocks 10.x.x.x private range', () => {
    expect(isSsrfUnsafeHostname('10.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('10.255.255.255')).toBe(true)
  })

  it('blocks 172.16-31.x.x private range', () => {
    expect(isSsrfUnsafeHostname('172.16.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('172.31.255.255')).toBe(true)
  })

  it('allows 172.15.x.x (just outside private range)', () => {
    expect(isSsrfUnsafeHostname('172.15.0.1')).toBe(false)
  })

  it('allows 172.32.x.x (just outside private range)', () => {
    expect(isSsrfUnsafeHostname('172.32.0.1')).toBe(false)
  })

  it('blocks 192.168.x.x private range', () => {
    expect(isSsrfUnsafeHostname('192.168.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('192.168.255.255')).toBe(true)
  })

  it('blocks link-local / cloud metadata 169.254.x.x', () => {
    expect(isSsrfUnsafeHostname('169.254.169.254')).toBe(true)
    expect(isSsrfUnsafeHostname('169.254.0.1')).toBe(true)
  })

  it('blocks IPv6 loopback ::1', () => {
    expect(isSsrfUnsafeHostname('::1')).toBe(true)
    expect(isSsrfUnsafeHostname('[::1]')).toBe(true)
  })

  it('blocks IPv6 link-local fe80::', () => {
    expect(isSsrfUnsafeHostname('fe80::1')).toBe(true)
  })

  it('blocks IPv6 unique-local fc/fd prefixes', () => {
    expect(isSsrfUnsafeHostname('fc00::1')).toBe(true)
    expect(isSsrfUnsafeHostname('fd00::1')).toBe(true)
  })

  it('allows a normal public hostname', () => {
    expect(isSsrfUnsafeHostname('example.com')).toBe(false)
    expect(isSsrfUnsafeHostname('api.github.com')).toBe(false)
  })

  it('allows a normal public IPv4 address', () => {
    expect(isSsrfUnsafeHostname('8.8.8.8')).toBe(false)
    expect(isSsrfUnsafeHostname('1.1.1.1')).toBe(false)
  })

  // --- Non-standard notation bypass attempts ---

  it('blocks octal IPv4 notation (0177.0.0.1 = 127.0.0.1)', () => {
    // Octal leading-zero: underlying OS/library may resolve 0177 as loopback
    expect(isSsrfUnsafeHostname('0177.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('0127.0.0.1')).toBe(true)
  })

  it('blocks hex IPv4 notation (0x7f.0.0.1 = 127.0.0.1)', () => {
    expect(isSsrfUnsafeHostname('0x7f.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('0xc0.0xa8.0.1')).toBe(true)
  })

  it('blocks IPv4 with leading-zero octets in any position', () => {
    // 010.0.0.1 might be interpreted as 8.0.0.1 (octal 10) by some libraries
    expect(isSsrfUnsafeHostname('010.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('192.0168.1.1')).toBe(true)
  })

  // --- CGNAT / additional reserved ranges ---

  it('blocks CGNAT range 100.64.0.0/10 (RFC 6598)', () => {
    expect(isSsrfUnsafeHostname('100.64.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('100.127.255.255')).toBe(true)
  })

  it('allows addresses just outside the CGNAT range', () => {
    expect(isSsrfUnsafeHostname('100.63.255.255')).toBe(false)
    expect(isSsrfUnsafeHostname('100.128.0.1')).toBe(false)
  })

  it('blocks IETF protocol assignment range 192.0.0.0/24', () => {
    expect(isSsrfUnsafeHostname('192.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('192.0.0.255')).toBe(true)
  })

  it('allows 192.0.1.0 (just outside IETF protocol assignments)', () => {
    expect(isSsrfUnsafeHostname('192.0.1.1')).toBe(false)
  })

  it('blocks multicast range 224.0.0.0/4', () => {
    expect(isSsrfUnsafeHostname('224.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('239.255.255.255')).toBe(true)
  })

  it('blocks reserved range 240.0.0.0/4', () => {
    expect(isSsrfUnsafeHostname('240.0.0.1')).toBe(true)
    expect(isSsrfUnsafeHostname('255.255.255.255')).toBe(true)
  })

  // --- IPv6-mapped IPv4 ---

  it('blocks IPv6-mapped loopback ::ffff:127.0.0.1', () => {
    expect(isSsrfUnsafeHostname('::ffff:127.0.0.1')).toBe(true)
  })

  it('blocks IPv6-mapped private ::ffff:192.168.1.1', () => {
    expect(isSsrfUnsafeHostname('::ffff:192.168.1.1')).toBe(true)
  })

  it('blocks IPv6-mapped link-local ::ffff:169.254.169.254', () => {
    expect(isSsrfUnsafeHostname('::ffff:169.254.169.254')).toBe(true)
  })

  it('allows IPv6-mapped public IP ::ffff:8.8.8.8', () => {
    expect(isSsrfUnsafeHostname('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('validateUrl', () => {
  it('accepts a valid https URL', () => {
    ok(validateUrl('https://example.com/path', 'url'))
  })

  it('accepts a valid http URL', () => {
    ok(validateUrl('http://example.com', 'url'))
  })

  it('rejects a non-URL string', () => {
    fails(validateUrl('not-a-url', 'url'), 'valid url')
  })

  it('rejects ftp:// scheme', () => {
    fails(validateUrl('ftp://example.com', 'url'), 'http')
  })

  it('rejects file:// scheme', () => {
    fails(validateUrl('file:///etc/passwd', 'url'), 'http')
  })

  it('rejects localhost URL (SSRF)', () => {
    fails(validateUrl('http://localhost:8080/admin', 'url'), 'disallowed host')
  })

  it('rejects 127.0.0.1 URL (SSRF)', () => {
    fails(validateUrl('http://127.0.0.1/secret', 'url'), 'disallowed host')
  })

  it('rejects cloud metadata URL (SSRF)', () => {
    fails(validateUrl('http://169.254.169.254/latest/meta-data/', 'url'), 'disallowed host')
  })

  it('uses the fieldName in the error message', () => {
    const errors = validateUrl('not-a-url', 'repoUrl')
    expect(errors[0]).toContain('repoUrl')
  })
})

// ---------------------------------------------------------------------------
// Schedule / cron validators
// ---------------------------------------------------------------------------

describe('validateCron', () => {
  it('accepts a valid cron expression', () => {
    ok(validateCron('0 9 * * 1-5'))
    ok(validateCron('*/15 * * * *'))
    ok(validateCron('0 0 1 1 *'))
    ok(validateCron('30 14 * * 0,6'))
  })

  it('rejects too few fields', () => {
    fails(validateCron('0 9 * *'), 'cron')
  })

  it('rejects too many fields', () => {
    fails(validateCron('0 9 * * * *'), 'cron')
  })

  it('rejects empty string', () => {
    fails(validateCron(''), 'cron')
  })

  it('rejects invalid characters', () => {
    fails(validateCron('0 9 * * @weekly'), 'cron')
  })
})

// ---------------------------------------------------------------------------
// Branch name validator
// ---------------------------------------------------------------------------

describe('validateBranchName', () => {
  it('accepts simple branch names', () => {
    ok(validateBranchName('main'))
    ok(validateBranchName('feature/my-thing'))
    ok(validateBranchName('fix_issue_123'))
  })

  it('rejects a name starting with a hyphen', () => {
    fails(validateBranchName('-bad'), 'letter')
  })

  it('rejects a name with spaces', () => {
    fails(validateBranchName('my branch'), 'letter')
  })

  it('rejects a name with special characters', () => {
    fails(validateBranchName('feat~bad'), 'letter')
    fails(validateBranchName('feat:bad'), 'letter')
    fails(validateBranchName('feat^bad'), 'letter')
  })

  it('rejects a name that exceeds 100 characters', () => {
    fails(validateBranchName('a'.repeat(101)), '100')
  })

  it('accepts a 100-character name', () => {
    ok(validateBranchName('a'.repeat(100)))
  })
})

// ---------------------------------------------------------------------------
// validateCreateTask — happy paths
// ---------------------------------------------------------------------------

describe('validateCreateTask — daily (ssh)', () => {
  const valid = {
    type: 'daily',
    name: 'SSH check',
    subtype: 'ssh',
    config: { host: 'example.com', username: 'deploy', command: 'uptime' },
  }

  it('accepts a valid ssh daily task', () => {
    ok(validateCreateTask(valid))
  })

  it('accepts optional port in ssh config', () => {
    ok(validateCreateTask({ ...valid, config: { ...valid.config, port: 22 } }))
  })

  it('accepts cron schedule', () => {
    ok(validateCreateTask({ ...valid, schedule: { type: 'cron', cron: '0 9 * * 1-5' } }))
  })

  it('rejects missing host', () => {
    fails(validateCreateTask({ ...valid, config: { username: 'u', command: 'ls' } }), 'host')
  })

  it('rejects missing username', () => {
    fails(validateCreateTask({ ...valid, config: { host: 'h', command: 'ls' } }), 'username')
  })

  it('rejects missing command', () => {
    fails(validateCreateTask({ ...valid, config: { host: 'h', username: 'u' } }), 'command')
  })

  it('rejects invalid port', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, port: 99999 } }),
      'port',
    )
  })

  it('rejects non-integer port', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, port: 'twenty-two' } }),
      'port',
    )
  })

  it('rejects a cron schedule with missing cron expression', () => {
    fails(validateCreateTask({ ...valid, schedule: { type: 'cron' } }), 'cron')
  })

  it('rejects an invalid schedule type', () => {
    fails(validateCreateTask({ ...valid, schedule: { type: 'every-day' } }), 'schedule')
  })

  it('rejects SSH host that is a private IP (SSRF)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, host: '192.168.1.1' } }),
      'disallowed',
    )
  })

  it('rejects SSH host that is localhost (SSRF)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, host: 'localhost' } }),
      'disallowed',
    )
  })

  it('rejects SSH command containing a newline (injection)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, command: 'uptime\nrm -rf /' } }),
      'newline',
    )
  })

  it('rejects SSH command containing a null byte (injection)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, command: 'uptime\x00evil' } }),
      'null',
    )
  })

  it('rejects SSH command with backtick command substitution', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, command: 'echo `id`' } }),
      'backtick',
    )
  })

  it('rejects SSH command with $() command substitution', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, command: 'echo $(id)' } }),
      'command substitution',
    )
  })

  it('accepts SSH commands with standard shell operators (|, ;, &&)', () => {
    ok(validateCreateTask({ ...valid, config: { ...valid.config, command: 'cd /app && npm start' } }))
    ok(validateCreateTask({ ...valid, config: { ...valid.config, command: 'ls | head -10' } }))
    ok(validateCreateTask({ ...valid, config: { ...valid.config, command: 'ping -c1 host; echo done' } }))
  })
})

describe('validateCreateTask — daily (email)', () => {
  const valid = {
    type: 'daily',
    name: 'Email check',
    subtype: 'email',
    config: { host: 'imap.example.com', username: 'user@example.com' },
  }

  it('accepts a valid email task', () => {
    ok(validateCreateTask(valid))
  })

  it('accepts optional folder', () => {
    ok(validateCreateTask({ ...valid, config: { ...valid.config, folder: 'INBOX' } }))
  })

  it('rejects missing host', () => {
    fails(validateCreateTask({ ...valid, config: { username: 'user@example.com' } }), 'host')
  })

  it('rejects missing username', () => {
    fails(validateCreateTask({ ...valid, config: { host: 'imap.example.com' } }), 'username')
  })

  it('rejects email host that is a private IP (SSRF)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, host: '10.0.0.1' } }),
      'disallowed',
    )
  })

  it('rejects email host that is localhost (SSRF)', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, host: 'localhost' } }),
      'disallowed',
    )
  })
})

describe('validateCreateTask — daily (http)', () => {
  const valid = {
    type: 'daily',
    name: 'HTTP ping',
    subtype: 'http',
    config: { url: 'https://example.com/ping', method: 'GET' },
  }

  it('accepts a valid http task', () => {
    ok(validateCreateTask(valid))
  })

  it('accepts optional headers', () => {
    ok(
      validateCreateTask({
        ...valid,
        config: { ...valid.config, headers: { 'X-Token': 'abc' } },
      }),
    )
  })

  it('rejects SSRF target in URL', () => {
    fails(
      validateCreateTask({ ...valid, config: { url: 'http://localhost:8080' } }),
      'disallowed host',
    )
  })

  it('rejects invalid URL', () => {
    fails(validateCreateTask({ ...valid, config: { url: 'not-a-url' } }), 'url')
  })

  it('rejects invalid HTTP method', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, method: 'CONNECT' } }),
      'method',
    )
  })

  it('rejects headers with newlines (header injection)', () => {
    fails(
      validateCreateTask({
        ...valid,
        config: { ...valid.config, headers: { 'X-Bad\r\nHeader': 'value' } },
      }),
      'newline',
    )
  })

  it('rejects header values with newlines', () => {
    fails(
      validateCreateTask({
        ...valid,
        config: {
          ...valid.config,
          headers: { 'X-Token': 'value\r\nInjected: header' },
        },
      }),
      'newline',
    )
  })

  it('rejects headers that are an array instead of object', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, headers: ['bad'] } }),
      'headers',
    )
  })

  it('rejects non-string header value', () => {
    fails(
      validateCreateTask({ ...valid, config: { ...valid.config, headers: { 'X-Count': 42 } } }),
      'string',
    )
  })
})

describe('validateCreateTask — developmental', () => {
  const valid = {
    type: 'developmental',
    name: 'Refactor',
    repoUrl: 'https://github.com/example/repo',
    agentName: 'claude-code',
  }

  it('accepts a valid developmental task', () => {
    ok(validateCreateTask(valid))
  })

  it('accepts an optional branchName', () => {
    ok(validateCreateTask({ ...valid, branchName: 'feature/new' }))
  })

  it('rejects missing repoUrl', () => {
    const { repoUrl: _, ...noUrl } = valid
    fails(validateCreateTask(noUrl), 'repourl')
  })

  it('rejects SSRF repoUrl', () => {
    fails(
      validateCreateTask({ ...valid, repoUrl: 'http://192.168.1.1/repo.git' }),
      'disallowed host',
    )
  })

  it('rejects invalid agentName', () => {
    fails(validateCreateTask({ ...valid, agentName: 'gpt-4' }), 'agentname')
  })

  it('accepts all valid agent names', () => {
    for (const agent of VALID_AGENTS) {
      ok(validateCreateTask({ ...valid, agentName: agent }))
    }
  })

  it('rejects an invalid branchName', () => {
    fails(validateCreateTask({ ...valid, branchName: 'has spaces' }), 'letter')
  })
})

describe('validateCreateTask — routine', () => {
  const valid = {
    type: 'routine',
    name: 'Morning workflow',
    // Condition uses single quotes around the status value — the canonical form
    // documented in types.ts and enforced by the condition validator.
    steps: [{ taskId: 'abc' }, { taskId: 'def', condition: "previous.status === 'succeeded'" }],
  }

  it('accepts a valid routine task', () => {
    ok(validateCreateTask(valid))
  })

  it('rejects an empty steps array', () => {
    fails(validateCreateTask({ ...valid, steps: [] }), 'at least one')
  })

  it('rejects steps that are not an array', () => {
    fails(validateCreateTask({ ...valid, steps: 'bad' }), 'array')
  })

  it('rejects a step with missing taskId', () => {
    fails(validateCreateTask({ ...valid, steps: [{ condition: 'x' }] }), 'taskid')
  })

  it('rejects a step with an empty taskId', () => {
    fails(validateCreateTask({ ...valid, steps: [{ taskId: '' }] }), 'taskid')
  })

  it('rejects a condition that is not a string', () => {
    fails(
      validateCreateTask({ ...valid, steps: [{ taskId: 'abc', condition: 123 }] }),
      'condition',
    )
  })

  it('rejects an unrecognized condition syntax', () => {
    fails(
      validateCreateTask({ ...valid, steps: [{ taskId: 'abc', condition: 'always' }] }),
      'condition',
    )
  })

  it('rejects a condition using double quotes around the status value', () => {
    fails(
      validateCreateTask({
        ...valid,
        steps: [{ taskId: 'abc', condition: 'previous.status === "succeeded"' }],
      }),
      'condition',
    )
  })

  it('rejects a condition with an unknown status value', () => {
    fails(
      validateCreateTask({
        ...valid,
        steps: [{ taskId: 'abc', condition: "previous.status === 'done'" }],
      }),
      'condition',
    )
  })

  it('accepts condition previous.status !== \'failed\'', () => {
    ok(
      validateCreateTask({
        ...valid,
        steps: [{ taskId: 'abc', condition: "previous.status !== 'failed'" }],
      }),
    )
  })

  it('rejects too many steps', () => {
    const manySteps = Array.from({ length: 51 }, (_, i) => ({ taskId: `id-${i}` }))
    fails(validateCreateTask({ ...valid, steps: manySteps }), '50')
  })
})

describe('validateCreateTask — common field validation', () => {
  const base = {
    type: 'daily',
    name: 'Valid',
    subtype: 'ssh',
    config: { host: 'h', username: 'u', command: 'ls' },
  }

  it('rejects missing name', () => {
    const { name: _, ...noName } = base
    fails(validateCreateTask(noName), 'name')
  })

  it('rejects empty name', () => {
    fails(validateCreateTask({ ...base, name: '   ' }), 'name')
  })

  it('rejects name exceeding 200 characters', () => {
    fails(validateCreateTask({ ...base, name: 'a'.repeat(201) }), '200')
  })

  it('rejects an unknown task type', () => {
    fails(validateCreateTask({ ...base, type: 'unknown' }), 'type')
  })

  it('rejects a non-object body', () => {
    fails(validateCreateTask('string'), 'object')
    fails(validateCreateTask(42), 'object')
    fails(validateCreateTask(null), 'object')
    fails(validateCreateTask([]), 'object')
  })
})

// ---------------------------------------------------------------------------
// validateUpdateTask
// ---------------------------------------------------------------------------

describe('validateUpdateTask — daily task', () => {
  const existingDaily: DailyTask = {
    id: 'test-id',
    userId: 'test-user-id',
    type: 'daily',
    name: 'Original',
    subtype: 'ssh',
    config: { host: 'h', username: 'u', command: 'ls' },
    schedule: { type: 'manual' },
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('accepts an empty patch (no changes)', () => {
    ok(validateUpdateTask({}, existingDaily))
  })

  it('accepts a name-only update', () => {
    ok(validateUpdateTask({ name: 'New name' }, existingDaily))
  })

  it('accepts a config update matching existing subtype', () => {
    ok(
      validateUpdateTask(
        { config: { host: 'new-host', username: 'u', command: 'date' } },
        existingDaily,
      ),
    )
  })

  it('accepts a simultaneous subtype + config change', () => {
    ok(
      validateUpdateTask(
        {
          subtype: 'http',
          config: { url: 'https://example.com' },
        },
        existingDaily,
      ),
    )
  })

  it('rejects a subtype change without a new config', () => {
    fails(validateUpdateTask({ subtype: 'http' }, existingDaily), 'config')
  })

  it('rejects an invalid schedule in the patch', () => {
    fails(validateUpdateTask({ schedule: { type: 'cron' } }, existingDaily), 'cron')
  })

  it('rejects a non-object body', () => {
    fails(validateUpdateTask(null, existingDaily), 'object')
  })
})

describe('validateUpdateTask — developmental task', () => {
  const existingDev: DevelopmentalTask = {
    id: 'dev-id',
    userId: 'test-user-id',
    type: 'developmental',
    name: 'Dev task',
    repoUrl: 'https://github.com/example/repo',
    agentName: 'opencode',
    branchName: 'main',
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('accepts a repoUrl update', () => {
    ok(validateUpdateTask({ repoUrl: 'https://github.com/example/other' }, existingDev))
  })

  it('rejects an SSRF repoUrl in the patch', () => {
    fails(
      validateUpdateTask({ repoUrl: 'http://10.0.0.1/repo' }, existingDev),
      'disallowed host',
    )
  })

  it('rejects an invalid agentName in the patch', () => {
    fails(validateUpdateTask({ agentName: 'bad-agent' }, existingDev), 'agentname')
  })

  it('rejects an invalid branchName in the patch', () => {
    fails(validateUpdateTask({ branchName: 'bad branch' }, existingDev), 'letter')
  })
})

describe('validateUpdateTask — routine task', () => {
  const existingRoutine: RoutineTask = {
    id: 'rt-id',
    userId: 'test-user-id',
    type: 'routine',
    name: 'Routine',
    steps: [{ taskId: 'abc' }],
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('accepts a valid steps replacement', () => {
    ok(validateUpdateTask({ steps: [{ taskId: 'xyz' }] }, existingRoutine))
  })

  it('rejects empty steps array in the patch', () => {
    fails(validateUpdateTask({ steps: [] }, existingRoutine), 'at least one')
  })
})
