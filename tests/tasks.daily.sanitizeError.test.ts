/**
 * Tests for the credential-scrubbing helpers used by the daily handlers.
 */

import { describe, expect, it } from 'vitest'
import {
  REDACTED,
  redactCommonSecrets,
  redactCredentials,
  sanitizeError,
} from '../server/src/tasks/daily/sanitizeError.js'

describe('redactCredentials', () => {
  it('replaces literal secrets with [REDACTED]', () => {
    const scrubbed = redactCredentials('login failed: password=hunter22', ['hunter22'])
    expect(scrubbed).toBe(`login failed: password=${REDACTED}`)
    expect(scrubbed).not.toContain('hunter22')
  })

  it('handles multiple sensitive strings', () => {
    const scrubbed = redactCredentials('user=alice, token=abcd1234, key=xyz9876', [
      'alice',
      'abcd1234',
      'xyz9876',
    ])
    expect(scrubbed).toBe(`user=${REDACTED}, token=${REDACTED}, key=${REDACTED}`)
  })

  it('ignores empty and undefined entries', () => {
    const scrubbed = redactCredentials('nothing to see', [undefined, '', '   ', 'longsecret'])
    expect(scrubbed).toBe('nothing to see')
  })

  it('ignores very short secrets to avoid mangling English text', () => {
    // A 3-char secret would otherwise scrub common substrings.
    const scrubbed = redactCredentials('the quick brown fox', ['the'])
    expect(scrubbed).toBe('the quick brown fox')
  })

  it('sorts longest-first so overlapping secrets do not produce partial redactions', () => {
    // If the shorter secret ("abcd") were processed first it would break the
    // longer one ("abcd1234") into two REDACTED pieces.
    const scrubbed = redactCredentials('token=abcd1234', ['abcd', 'abcd1234'])
    expect(scrubbed).toBe(`token=${REDACTED}`)
  })

  it('handles regex-metacharacter secrets literally', () => {
    const scrubbed = redactCredentials('sig=(a+b)*c', ['(a+b)*c'])
    expect(scrubbed).toBe(`sig=${REDACTED}`)
  })

  it('returns empty input unchanged', () => {
    expect(redactCredentials('', ['secret'])).toBe('')
  })
})

describe('redactCommonSecrets', () => {
  it('scrubs PEM private-key blocks in full', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END RSA PRIVATE KEY-----'
    expect(redactCommonSecrets(`ssh error: ${pem}`)).toBe(`ssh error: ${REDACTED}`)
  })

  it('scrubs Authorization header lines', () => {
    const scrubbed = redactCommonSecrets(
      'HTTP/1.1 401\r\nAuthorization: Bearer abcd1234\r\nContent-Length: 0',
    )
    expect(scrubbed).toContain(`Authorization: ${REDACTED}`)
    expect(scrubbed).not.toContain('abcd1234')
  })

  it('scrubs Cookie header lines case-insensitively', () => {
    const scrubbed = redactCommonSecrets('cookie: session=zzz; other=yyy')
    expect(scrubbed).toContain(`cookie: ${REDACTED}`)
    expect(scrubbed).not.toContain('session=zzz')
  })

  it('scrubs URL userinfo', () => {
    const scrubbed = redactCommonSecrets(
      'failed to connect to https://alice:hunter22@example.com/path',
    )
    expect(scrubbed).toContain('https://[REDACTED]@example.com/path')
    expect(scrubbed).not.toContain('hunter22')
    expect(scrubbed).not.toContain('alice')
  })

  it('scrubs inline Bearer / Basic tokens', () => {
    const scrubbed = redactCommonSecrets('Bearer eyJhbGci and Basic dXNlcjpwYXNz')
    expect(scrubbed).toBe(`Bearer ${REDACTED} and Basic ${REDACTED}`)
  })

  it('leaves plain messages untouched', () => {
    expect(redactCommonSecrets('nothing sensitive here')).toBe('nothing sensitive here')
  })
})

describe('sanitizeError', () => {
  it('wraps a plain string throw', () => {
    const err = sanitizeError('oh no', { context: 'ssh' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('ssh: oh no')
  })

  it('scrubs caller-supplied secrets and preserves cause', () => {
    const original = new Error('login failed for pw=hunter22')
    const wrapped = sanitizeError(original, {
      context: 'ssh connection',
      sensitive: ['hunter22'],
    })
    expect(wrapped.message).toBe(`ssh connection: login failed for pw=${REDACTED}`)
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(original)
  })

  it('scrubs both literal and pattern-based secrets in one pass', () => {
    const wrapped = sanitizeError(
      'saw https://u:supersecret@dashboards.local/api and header Authorization: Bearer supersecret',
      { context: 'http', sensitive: ['supersecret'] },
    )
    expect(wrapped.message).not.toContain('supersecret')
    expect(wrapped.message).toContain(REDACTED)
  })

  it('handles non-Error non-string throws', () => {
    const wrapped = sanitizeError({ foo: 'bar' }, { context: 'test' })
    expect(wrapped.message).toBe('test: {"foo":"bar"}')
    expect((wrapped as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it('handles cyclic non-Error throws without crashing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const wrapped = sanitizeError(cyclic, { context: 'test' })
    expect(wrapped.message).toContain('test:')
  })

  it('omits context prefix when not supplied', () => {
    const wrapped = sanitizeError('plain')
    expect(wrapped.message).toBe('plain')
  })
})
