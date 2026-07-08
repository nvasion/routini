import { describe, expect, it, vi } from 'vitest'
import { authenticate, requireAuth } from '../server/src/auth/middleware.js'
import { AUTH_COOKIE_NAME } from '../server/src/auth/config.js'
import { serializeCookie } from '../server/src/auth/cookies.js'
import { issueToken } from '../server/src/auth/tokens.js'
import type { AuthConfig } from '../server/src/auth/config.js'
import type { AuthDependencies } from '../server/src/auth/middleware.js'
import type { User } from '../server/src/auth/userStore.js'
import type { NextFunction, Request, Response } from 'express'

/**
 * Unit tests for the auth middleware module.
 *
 * These exercise `authenticate()` and `requireAuth()` directly — without
 * spinning up an HTTP server — so failures point immediately to the middleware
 * logic rather than to routing, cookie parsing, or network concerns. Full
 * integration coverage (real HTTP requests, cookie round-trip, CSRF check) is
 * in tests/auth.routes.test.ts.
 */

const SECRET = 'test-middleware-signing-secret-abcdefghij'

const ALICE: User = {
  id: 'user-alice-uuid',
  username: 'alice',
  createdAt: '2024-01-01T00:00:00.000Z',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtSecret: SECRET,
    tokenTtlSeconds: 3600,
    cookieSecure: false,
    defaultUsername: 'admin',
    defaultPassword: 'changeme',
    userStorePath: null,
    loginMaxAttempts: 10,
    loginWindowSeconds: 60,
    ...overrides,
  }
}

/**
 * Build a minimal `AuthDependencies` stub. Only the two synchronous methods
 * consumed by the middleware (`findById`, `isSessionActive`) need to be
 * provided; everything else is excluded via `as unknown as`.
 */
function makeDeps(
  userStubs: {
    findById?: (id: string) => User | null
    isSessionActive?: (userId: string, sessionId: string) => boolean
  } = {},
  configOverrides: Partial<AuthConfig> = {},
): AuthDependencies {
  return {
    config: makeAuthConfig(configOverrides),
    users: {
      findById: userStubs.findById ?? (() => ALICE),
      isSessionActive: userStubs.isSessionActive ?? (() => true),
    } as unknown as AuthDependencies['users'],
  }
}

/** Fake Express Request with only the headers the middleware reads. */
function makeRequest(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

/** Issue a JWT for ALICE using the test secret. */
function makeToken(opts: { tokenId?: string; expiresInSeconds?: number } = {}): string {
  return issueToken({
    subject: ALICE.id,
    expiresInSeconds: opts.expiresInSeconds ?? 3600,
    secret: SECRET,
    tokenId: opts.tokenId,
  })
}

/** Request with Authorization: Bearer <token>. */
function withBearer(token: string): Request {
  return makeRequest({ authorization: `Bearer ${token}` })
}

/**
 * Request with the auth cookie set to `token`.
 * The value is URL-encoded exactly as the server's `setAuthCookie` helper does
 * via `serializeCookie`, so `parseCookies` decodes it back to the raw JWT.
 */
function withCookie(token: string): Request {
  // serializeCookie returns "routini_auth=<url-encoded>; Path=/; …" — take
  // just the name=value segment so it looks like a browser Cookie header.
  const pair = serializeCookie(AUTH_COOKIE_NAME, token).split(';')[0]
  return makeRequest({ cookie: pair })
}

/** Minimal fake Response for the requireAuth() tests. */
function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

// ─── authenticate() ───────────────────────────────────────────────────────────

describe('authenticate()', () => {
  // ── No credentials ────────────────────────────────────────────────────────

  it('returns null when there is no Authorization header and no cookie', () => {
    expect(authenticate(makeRequest(), makeDeps())).toBeNull()
  })

  it('returns null for an empty Authorization header', () => {
    expect(authenticate(makeRequest({ authorization: '' }), makeDeps())).toBeNull()
  })

  it('returns null when the Authorization header is present but has no token after the scheme', () => {
    // A trailing-whitespace-only value trims to '' which is falsy.
    expect(authenticate(makeRequest({ authorization: 'Bearer    ' }), makeDeps())).toBeNull()
  })

  it('returns null when there is no auth cookie and no Authorization header', () => {
    expect(authenticate(makeRequest({ cookie: 'session_id=irrelevant' }), makeDeps())).toBeNull()
  })

  // ── Token extraction ──────────────────────────────────────────────────────

  it('returns user + payload for a valid Bearer token', () => {
    const token = makeToken()
    const result = authenticate(withBearer(token), makeDeps())
    expect(result).not.toBeNull()
    expect(result?.user).toEqual(ALICE)
    expect(result?.payload.sub).toBe(ALICE.id)
  })

  it('returns user + payload for a valid auth cookie', () => {
    const token = makeToken()
    const result = authenticate(withCookie(token), makeDeps())
    expect(result).not.toBeNull()
    expect(result?.user).toEqual(ALICE)
  })

  it('is case-insensitive on the Bearer scheme keyword', () => {
    const token = makeToken()
    expect(authenticate(makeRequest({ authorization: `bearer ${token}` }), makeDeps())).not.toBeNull()
    expect(authenticate(makeRequest({ authorization: `BEARER ${token}` }), makeDeps())).not.toBeNull()
  })

  it('prefers the Authorization Bearer header over the cookie when both are supplied', () => {
    const goodToken = makeToken()
    const req = makeRequest({
      authorization: `Bearer ${goodToken}`,
      // Intentionally bogus cookie value — middleware should not reach this.
      cookie: `${AUTH_COOKIE_NAME}=not.a.valid.token`,
    })
    // The valid Bearer token must win; the bad cookie is never consulted.
    expect(authenticate(req, makeDeps())).not.toBeNull()
  })

  it('falls back to the cookie when the Authorization header is not a Bearer token', () => {
    // A Basic auth header should be ignored; the cookie should be used instead.
    const token = makeToken()
    const req = makeRequest({
      authorization: 'Basic dXNlcjpwYXNz',
      cookie: serializeCookie(AUTH_COOKIE_NAME, token).split(';')[0],
    })
    expect(authenticate(req, makeDeps())).not.toBeNull()
  })

  // ── Token validation failures ─────────────────────────────────────────────

  it('returns null for an expired token', () => {
    const t0 = 1_000_000_000_000
    const expiredToken = issueToken({
      subject: ALICE.id,
      expiresInSeconds: 1,
      secret: SECRET,
      now: () => t0, // frozen in the past
    })
    // Real Date.now() is much later → token is expired.
    expect(authenticate(withBearer(expiredToken), makeDeps())).toBeNull()
  })

  it('returns null for a token signed with a different secret', () => {
    const foreignToken = issueToken({
      subject: ALICE.id,
      expiresInSeconds: 3600,
      secret: 'completely-different-secret-xxxxxxxxxxxxxxxx',
    })
    expect(authenticate(withBearer(foreignToken), makeDeps())).toBeNull()
  })

  it('returns null for a token whose signature has been tampered with', () => {
    const token = makeToken()
    const [h, p, sig] = token.split('.')
    const flipped = sig.endsWith('A')
      ? sig.slice(0, -1) + 'B'
      : sig.slice(0, -1) + 'A'
    const tampered = `${h}.${p}.${flipped}`
    expect(authenticate(withBearer(tampered), makeDeps())).toBeNull()
  })

  it('returns null for a completely malformed token string', () => {
    expect(authenticate(withBearer('not.a.jwt'), makeDeps())).toBeNull()
    expect(authenticate(withBearer('garbage'), makeDeps())).toBeNull()
  })

  // ── User-store failures ───────────────────────────────────────────────────

  it('returns null when findById cannot locate the user', () => {
    const token = makeToken()
    expect(
      authenticate(withBearer(token), makeDeps({ findById: () => null })),
    ).toBeNull()
  })

  // ── Session (jti) enforcement ─────────────────────────────────────────────

  it('skips the session-store lookup for tokens without a jti claim', () => {
    const token = makeToken() // no tokenId → no jti in payload
    const isSessionActive = vi.fn()
    const result = authenticate(withBearer(token), makeDeps({ isSessionActive }))
    expect(result).not.toBeNull()
    expect(isSessionActive).not.toHaveBeenCalled()
  })

  it('returns null when the jti session has been revoked', () => {
    const token = makeToken({ tokenId: 'sess-revoked' })
    expect(
      authenticate(withBearer(token), makeDeps({ isSessionActive: () => false })),
    ).toBeNull()
  })

  it('returns user + payload when the jti session is active', () => {
    const token = makeToken({ tokenId: 'sess-active' })
    const isSessionActive = vi.fn().mockReturnValue(true)
    const result = authenticate(withBearer(token), makeDeps({ isSessionActive }))
    expect(result).not.toBeNull()
    expect(isSessionActive).toHaveBeenCalledWith(ALICE.id, 'sess-active')
  })

  it('passes the correct user id and session id to isSessionActive', () => {
    const sessionId = 'sess-for-alice-12345'
    const token = makeToken({ tokenId: sessionId })
    const isSessionActive = vi.fn().mockReturnValue(true)
    authenticate(withBearer(token), makeDeps({ isSessionActive }))
    expect(isSessionActive).toHaveBeenCalledWith(ALICE.id, sessionId)
  })

  // ── Unexpected errors ─────────────────────────────────────────────────────

  it('returns null and emits a console.warn for unexpected non-TokenError exceptions', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const token = makeToken()
      const result = authenticate(
        withBearer(token),
        makeDeps({
          findById: () => {
            // Simulate a user-store failure that is not a TokenError.
            throw new Error('database connection lost')
          },
        }),
      )
      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ─── requireAuth() middleware ─────────────────────────────────────────────────

describe('requireAuth() middleware', () => {
  it('calls next() and attaches req.user + req.authToken for authenticated requests', () => {
    const token = makeToken({ tokenId: 'sess-mw-test' })
    const req = withBearer(token) as Request
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps())(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user).toEqual(ALICE)
    expect(req.authToken).toBeDefined()
    expect(req.authToken?.sub).toBe(ALICE.id)
    // Response must not have been touched.
    expect(res.statusCode).toBe(200)
  })

  it('returns 401 JSON and does not call next() for unauthenticated requests', () => {
    const req = makeRequest()
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps())(req, res as unknown as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect((res.body as { error: string }).error).toBe('Unauthorized')
  })

  it('returns 401 for a tampered token', () => {
    const token = makeToken()
    const [h, p, sig] = token.split('.')
    const bad = `${h}.${p}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`
    const req = withBearer(bad)
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps())(req, res as unknown as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a revoked session', () => {
    const token = makeToken({ tokenId: 'sess-revoked-mw' })
    const req = withBearer(token)
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps({ isSessionActive: () => false }))(req, res as unknown as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for an expired token', () => {
    const t0 = 1_000_000_000_000
    const expiredToken = issueToken({
      subject: ALICE.id,
      expiresInSeconds: 1,
      secret: SECRET,
      now: () => t0,
    })
    const req = withBearer(expiredToken)
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps())(req, res as unknown as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('accepts a valid auth cookie instead of a Bearer header', () => {
    const token = makeToken()
    const req = withCookie(token)
    const res = makeRes()
    const next = vi.fn() as unknown as NextFunction

    requireAuth(makeDeps())(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user).toEqual(ALICE)
  })
})
