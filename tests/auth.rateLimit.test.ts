import { describe, expect, it } from 'vitest'
import { RateLimiter, clientIpFromRequest } from '../server/src/auth/rateLimit.js'

describe('RateLimiter', () => {
  it('validates its options', () => {
    expect(() => new RateLimiter({ maxAttempts: 0, windowSeconds: 60 })).toThrow(
      /maxAttempts/,
    )
    expect(() => new RateLimiter({ maxAttempts: 5, windowSeconds: 0 })).toThrow(
      /windowSeconds/,
    )
    expect(() => new RateLimiter({ maxAttempts: 1.5, windowSeconds: 60 })).toThrow(
      /maxAttempts/,
    )
  })

  it('allows attempts up to the limit and rejects the next one', () => {
    let now = 1_000_000_000_000
    const limiter = new RateLimiter({
      maxAttempts: 3,
      windowSeconds: 60,
      now: () => now,
    })
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(true)
    const denied = limiter.hit('k')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('recovers after the window elapses', () => {
    let now = 1_000_000_000_000
    const limiter = new RateLimiter({
      maxAttempts: 2,
      windowSeconds: 10,
      now: () => now,
    })
    limiter.hit('k')
    limiter.hit('k')
    expect(limiter.hit('k').allowed).toBe(false)
    // Advance clock past window.
    now += 11_000
    expect(limiter.hit('k').allowed).toBe(true)
  })

  it('isolates counters per key', () => {
    const limiter = new RateLimiter({ maxAttempts: 1, windowSeconds: 60 })
    expect(limiter.hit('a').allowed).toBe(true)
    expect(limiter.hit('b').allowed).toBe(true)
    expect(limiter.hit('a').allowed).toBe(false)
    expect(limiter.hit('b').allowed).toBe(false)
  })

  it('reset clears a key', () => {
    const limiter = new RateLimiter({ maxAttempts: 1, windowSeconds: 60 })
    limiter.hit('a')
    expect(limiter.hit('a').allowed).toBe(false)
    limiter.reset('a')
    expect(limiter.hit('a').allowed).toBe(true)
  })

  it('is fail-open on empty keys rather than globally rejecting', () => {
    const limiter = new RateLimiter({ maxAttempts: 1, windowSeconds: 60 })
    // Empty keys arise from bad input; treat as "unrelated" so a bug doesn't
    // globally lock users out.
    expect(limiter.hit('').allowed).toBe(true)
    expect(limiter.hit('').allowed).toBe(true)
  })

  it('bounds memory by evicting oldest keys past maxKeys', () => {
    const limiter = new RateLimiter({
      maxAttempts: 5,
      windowSeconds: 60,
      maxKeys: 3,
    })
    limiter.hit('a')
    limiter.hit('b')
    limiter.hit('c')
    limiter.hit('d')
    limiter.hit('e')
    expect(limiter.size()).toBeLessThanOrEqual(3)
  })
})

describe('clientIpFromRequest', () => {
  it('prefers req.ip when present', () => {
    expect(clientIpFromRequest({ ip: '10.0.0.1' })).toBe('10.0.0.1')
  })

  it('falls back to socket.remoteAddress', () => {
    expect(
      clientIpFromRequest({ ip: undefined, socket: { remoteAddress: '10.0.0.2' } }),
    ).toBe('10.0.0.2')
  })

  it('returns a fixed key when nothing is available', () => {
    expect(clientIpFromRequest({})).toBe('unknown')
  })
})
