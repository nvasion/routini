/**
 * Unit tests for log-line sanitization via the exported appendLog function.
 *
 * `sanitizeLogMessage` is an internal helper in server/src/routes/tasks.ts
 * that cannot be imported directly. Its behaviour is verified here by calling
 * the exported `appendLog` function and inspecting the stored entry in the
 * exported `taskLogs` map.
 *
 * Coverage:
 *   – Pattern 1 – Bearer token:     Bearer <token>  →  Bearer [REDACTED]
 *   – Pattern 2 – API-key prefixes: sk-/pk-/api-/key-<8+chars>  →  [REDACTED]
 *   – Pattern 3 – URI credentials:  ://user:pass@  →  ://user:[REDACTED]@
 *   – Pattern 4 – key=value pairs:  password=/secret=/token=/…  →  key=[REDACTED]
 *   – Multiple patterns in one line
 *   – Non-secret messages pass through unchanged
 *   – appendLog storage: shape, ordering, new-list creation
 */

import { describe, it, expect } from 'vitest'
import { appendLog, taskLogs } from '../server/src/routes/tasks'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a pseudo-unique task ID so each test writes to its own log bucket. */
function uid(): string {
  return `sanitize-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
}

/** Appends a single log line and returns the stored (sanitized) message. */
function stored(taskId: string, message: string): string {
  appendLog(taskId, message)
  const logs = taskLogs.get(taskId)
  return logs![logs!.length - 1]!.message
}

// ═════════════════════════════════════════════════════════════════════════════
// Pattern 1 – Bearer tokens
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – Bearer token pattern', () => {
  it('redacts a JWT Bearer token in an Authorization header', () => {
    const id = uid()
    const msg = stored(id, 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(msg).toContain('Bearer [REDACTED]')
    expect(msg).toContain('Authorization:')
  })

  it('redacts a Bearer token with the sk- prefix style (OpenAI-style key)', () => {
    const id = uid()
    const msg = stored(id, 'Access granted with Bearer sk-abcdefgh12345678')
    expect(msg).not.toContain('sk-abcdefgh12345678')
    expect(msg).toContain('[REDACTED]')
  })

  it('is case-insensitive: redacts "BEARER" and "bearer" variants', () => {
    const id1 = uid()
    const id2 = uid()
    const upper = stored(id1, 'BEARER tokenABCDEFGHIJ')
    const lower = stored(id2, 'bearer token1234567890')
    expect(upper).not.toContain('tokenABCDEFGHIJ')
    expect(lower).not.toContain('token1234567890')
  })

  it('preserves surrounding non-secret text when redacting a Bearer token', () => {
    const id = uid()
    const msg = stored(id, 'Sending request with Authorization: Bearer abc123xyzPQR to the API')
    expect(msg).toContain('Sending request')
    expect(msg).toContain('to the API')
    expect(msg).not.toContain('abc123xyzPQR')
  })

  it('redacts tokens that contain Base64url characters (dots, hyphens, underscores)', () => {
    const id = uid()
    const msg = stored(id, 'Bearer header.payload.signature-with-extra_chars')
    expect(msg).toContain('Bearer [REDACTED]')
    expect(msg).not.toContain('header.payload')
  })

  it('redacts tokens with trailing = padding characters', () => {
    const id = uid()
    const msg = stored(id, 'Bearer base64Value==')
    expect(msg).toContain('[REDACTED]')
    expect(msg).not.toContain('base64Value')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Pattern 2 – API key prefixes
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – API key prefix pattern (sk-/pk-/api-/key-)', () => {
  it('redacts sk- prefixed keys (OpenAI, Anthropic, Stripe, etc.)', () => {
    const id = uid()
    const msg = stored(id, 'Initialising with API key sk-abcdefghij1234567890')
    expect(msg).not.toContain('sk-abcdefghij1234567890')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts pk- prefixed keys (Stripe-style publishable key)', () => {
    // The pattern requires 8+ alphanumeric chars (A-Za-z0-9) immediately after
    // the "pk-" prefix.  Dashes in the body would break the alphanumeric run,
    // so we use an all-alphanumeric suffix here.
    const id = uid()
    const msg = stored(id, 'Using pk-ABCDEFGHIJKLMNOP in config')
    expect(msg).not.toContain('pk-ABCDEFGHIJKLMNOP')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts api- prefixed credentials', () => {
    const id = uid()
    const msg = stored(id, 'Credential: api-ABCDEFGHIJKLMNOPQ')
    expect(msg).not.toContain('api-ABCDEFGHIJKLMNOPQ')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts key- prefixed credentials', () => {
    const id = uid()
    const msg = stored(id, 'Config key-ABCDEFGHIJKLMNOPQRSTUVWX')
    expect(msg).not.toContain('key-ABCDEFGHIJKLMNOPQRSTUVWX')
    expect(msg).toContain('[REDACTED]')
  })

  it('does NOT redact short sequences (fewer than 8 chars after prefix)', () => {
    // The pattern requires {8,} alphanumeric characters after the prefix dash.
    // "short" has 5 chars – below the 8-char threshold.
    const id = uid()
    const msg = stored(id, 'Version tag: sk-short')
    expect(msg).toContain('sk-short')
  })

  it('redacts a key with exactly the 8-char minimum after prefix', () => {
    const id = uid()
    const msg = stored(id, 'Key sk-ABCDEFGH found')
    expect(msg).not.toContain('sk-ABCDEFGH')
    expect(msg).toContain('[REDACTED]')
  })

  it('is case-insensitive for the prefix (SK- matches)', () => {
    const id = uid()
    const msg = stored(id, 'Using SK-ABCDEFGHIJ1234567890')
    expect(msg).not.toContain('SK-ABCDEFGHIJ1234567890')
    expect(msg).toContain('[REDACTED]')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Pattern 3 – URI embedded credentials
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – URI credential pattern', () => {
  it('redacts the password in an https URI (://user:password@host)', () => {
    const id = uid()
    const msg = stored(id, 'Cloning https://deploy:supersecret@github.com/org/repo')
    expect(msg).not.toContain('supersecret')
    expect(msg).toContain('[REDACTED]')
    // Username and host are preserved
    expect(msg).toContain('deploy')
    expect(msg).toContain('github.com')
  })

  it('redacts the password in a mysql:// connection string', () => {
    const id = uid()
    const msg = stored(id, 'DB conn: mysql://admin:dbpassword123@db.internal/mydb')
    expect(msg).not.toContain('dbpassword123')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts the password in a postgresql:// connection string', () => {
    const id = uid()
    const msg = stored(id, 'Connecting to postgresql://user:secret@localhost:5432/app')
    expect(msg).not.toContain('secret')
    expect(msg).toContain('[REDACTED]')
  })

  it('preserves the host and path after the @ sign', () => {
    const id = uid()
    const msg = stored(id, 'git clone https://ci:token123456@github.com/org/repo.git')
    expect(msg).toContain('github.com/org/repo.git')
    expect(msg).not.toContain('token123456')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Pattern 4 – key=value credential pairs
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – key=value credential pairs', () => {
  it('redacts password=value', () => {
    const id = uid()
    const msg = stored(id, 'Authenticating with password=topsecretvalue')
    expect(msg).not.toContain('topsecretvalue')
    expect(msg).toContain('password=[REDACTED]')
  })

  it('redacts passwd=value', () => {
    const id = uid()
    const msg = stored(id, 'DB config: passwd=mydbpassword')
    expect(msg).not.toContain('mydbpassword')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts secret=value', () => {
    const id = uid()
    const msg = stored(id, 'Loaded env var secret=myvaulttoken')
    expect(msg).not.toContain('myvaulttoken')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts token=value', () => {
    const id = uid()
    const msg = stored(id, 'GitHub token=ghp_ABCDEFGHIJKLMNOPQR')
    expect(msg).not.toContain('ghp_ABCDEFGHIJKLMNOPQR')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts api_key=value (underscore variant)', () => {
    const id = uid()
    const msg = stored(id, 'AWS api_key=AKIAIOSFODNN7EXAMPLE')
    expect(msg).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(msg).toContain('[REDACTED]')
  })

  it('redacts apikey=value (no-underscore variant)', () => {
    const id = uid()
    const msg = stored(id, 'Sendgrid apikey=SG.abcdefghij1234567890')
    expect(msg).not.toContain('SG.abcdefghij1234567890')
    expect(msg).toContain('[REDACTED]')
  })

  it('is case-insensitive: redacts PASSWORD=value', () => {
    const id = uid()
    const msg = stored(id, 'Env var PASSWORD=UpperCasePassword123')
    expect(msg).not.toContain('UpperCasePassword123')
    expect(msg).toContain('[REDACTED]')
  })

  it('tolerates spaces around the = sign (token = value)', () => {
    const id = uid()
    const msg = stored(id, 'Setting token = my-secret-value')
    expect(msg).not.toContain('my-secret-value')
    expect(msg).toContain('[REDACTED]')
  })

  it('preserves non-credential context text around the pair', () => {
    const id = uid()
    const msg = stored(id, 'Connection opened; password=hidden; port=5432')
    expect(msg).not.toContain('hidden')
    // port=5432 is numeric and does not match the pattern keyword list, so it
    // is preserved.  (Verify that non-secret key=value pairs pass through.)
    expect(msg).toContain('port=5432')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Multiple patterns in one message
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – multiple secrets in one message', () => {
  it('redacts both a Bearer token and a password= pair in the same line', () => {
    const id = uid()
    const msg = stored(
      id,
      'Auth: Bearer sk-abcdefghij12345678 and password=topsecret in same line',
    )
    expect(msg).not.toContain('sk-abcdefghij12345678')
    expect(msg).not.toContain('topsecret')
    expect(msg).toContain('[REDACTED]')
    // Non-secret parts preserved
    expect(msg).toContain('Auth:')
    expect(msg).toContain('in same line')
  })

  it('redacts a URI password and an api_key= pair in the same line', () => {
    const id = uid()
    const msg = stored(
      id,
      'Cloning https://ci:mysecretpw@github.com/repo with api_key=AKID123EXAMPLE',
    )
    expect(msg).not.toContain('mysecretpw')
    expect(msg).not.toContain('AKID123EXAMPLE')
    expect(msg).toContain('[REDACTED]')
    expect(msg).toContain('github.com/repo')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Non-secret messages
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeLogMessage – non-secret messages pass through unchanged', () => {
  it('does not modify plain build output', () => {
    const id = uid()
    const original = 'Starting container for task abc-123'
    expect(stored(id, original)).toBe(original)
  })

  it('does not modify a git clone progress line', () => {
    const id = uid()
    const original = 'Cloning into /workspace/repo...'
    expect(stored(id, original)).toBe(original)
  })

  it('does not modify a connection-refused error without credentials', () => {
    const id = uid()
    const original = 'Error: connection refused to 127.0.0.1:5432'
    expect(stored(id, original)).toBe(original)
  })

  it('does not modify a docker image pull line', () => {
    const id = uid()
    const original = 'Pulling image routini/claude-agent:latest'
    expect(stored(id, original)).toBe(original)
  })

  it('does not redact "key" used as a word in a non-credential context', () => {
    const id = uid()
    // "key" without the dash-prefix pattern should not be redacted.
    const original = 'The key feature is the retry mechanism'
    expect(stored(id, original)).toBe(original)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// appendLog – storage behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('appendLog – log storage behaviour', () => {
  it('creates a new log list when none exists for the task ID', () => {
    const id = uid()
    expect(taskLogs.get(id)).toBeUndefined()

    appendLog(id, 'First entry')

    const logs = taskLogs.get(id)
    expect(Array.isArray(logs)).toBe(true)
    expect(logs).toHaveLength(1)
  })

  it('stores a log entry with a valid ISO 8601 timestamp', () => {
    const id = uid()
    const before = Date.now()
    appendLog(id, 'Timed entry')
    const after = Date.now()

    const entry = taskLogs.get(id)![0]!
    expect(typeof entry.timestamp).toBe('string')
    const ts = new Date(entry.timestamp).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('stores a log entry with a message field', () => {
    const id = uid()
    appendLog(id, 'Test log message')
    const entry = taskLogs.get(id)![0]!
    expect(entry.message).toBe('Test log message')
  })

  it('appends entries in insertion order (multiple calls)', () => {
    const id = uid()
    const messages = ['step one', 'step two', 'step three', 'step four', 'step five']
    for (const msg of messages) appendLog(id, msg)

    const stored = taskLogs.get(id)!
    expect(stored).toHaveLength(5)
    expect(stored.map(l => l.message)).toEqual(messages)
  })

  it('appends to an existing list rather than overwriting', () => {
    const id = uid()
    appendLog(id, 'First')
    appendLog(id, 'Second')

    const logs = taskLogs.get(id)!
    expect(logs).toHaveLength(2)
    expect(logs[0]!.message).toBe('First')
    expect(logs[1]!.message).toBe('Second')
  })

  it('stores the sanitized message, not the raw input', () => {
    const id = uid()
    appendLog(id, 'Auth: Bearer REALTOKENABCDEFGHIJKLMNOP')
    const entry = taskLogs.get(id)![0]!
    expect(entry.message).not.toContain('REALTOKENABCDEFGHIJKLMNOP')
    expect(entry.message).toContain('[REDACTED]')
  })

  it('each entry has both timestamp and message fields (TaskLog shape)', () => {
    const id = uid()
    appendLog(id, 'Shape check')
    const entry = taskLogs.get(id)![0]!
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['timestamp', 'message']))
  })
})
