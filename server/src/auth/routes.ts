import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { AUTH_COOKIE_NAME, type AuthConfig } from './config.js'
import { serializeCookie } from './cookies.js'
import { csrfProtect } from './csrf.js'
import { authenticate, requireAuth, type AuthDependencies } from './middleware.js'
import { RateLimiter, clientIpFromRequest } from './rateLimit.js'
import { issueToken } from './tokens.js'
import { normalizeUsernameForKeying, type UserStore } from './userStore.js'

interface LoginBody {
  username?: unknown
  password?: unknown
}

const MAX_CREDENTIAL_LENGTH = 256

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function setAuthCookie(res: Response, token: string, config: AuthConfig): void {
  const cookie = serializeCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: config.tokenTtlSeconds,
  })
  res.setHeader('Set-Cookie', cookie)
}

function clearAuthCookie(res: Response, config: AuthConfig): void {
  const cookie = serializeCookie(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
  })
  res.setHeader('Set-Cookie', cookie)
}

/**
 * Compute a rate-limit key that ties failed attempts to both the client IP and
 * the (normalized) username being tried. Using both dimensions means:
 *   - a distributed attack against one account still trips per-IP throttling
 *   - a single IP guessing many usernames still trips the per-user throttle
 *
 * The username uses the same normalization the UserStore applies at lookup
 * (`trim().toLowerCase()`) so `alice`, `ALICE`, and `  alice  ` map to a single
 * bucket — an attacker cannot escape the limiter by varying casing/whitespace.
 * Non-string inputs collapse to the empty string so the key is still stable
 * (they'll fail input validation anyway).
 */
function rateLimitKey(ip: string, username: unknown): string {
  const normalized = normalizeUsernameForKeying(username)
  return `${ip}\x1f${normalized.slice(0, MAX_CREDENTIAL_LENGTH)}`
}

export interface AuthRouterOptions {
  /** Optional preconstructed limiter — primarily for tests. */
  loginRateLimiter?: RateLimiter
}

export function createAuthRouter(
  deps: AuthDependencies,
  options: AuthRouterOptions = {},
): Router {
  const router = Router()
  const { config, users } = deps

  const loginLimiter =
    options.loginRateLimiter ??
    new RateLimiter({
      maxAttempts: config.loginMaxAttempts,
      windowSeconds: config.loginWindowSeconds,
    })

  // CSRF: state-changing auth endpoints must be application/json. Applied
  // before the handlers so it's impossible to skip by adding a new route
  // later without also touching this line.
  const csrf = csrfProtect()

  router.post('/login', csrf, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as LoginBody
    const ip = clientIpFromRequest(req)
    const key = rateLimitKey(ip, body.username)

    const decision = loginLimiter.hit(key)
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds))
      res.status(429).json({
        error: 'Too many login attempts. Try again later.',
      })
      return
    }

    if (
      !isNonEmptyString(body.username) ||
      !isNonEmptyString(body.password) ||
      body.username.length > MAX_CREDENTIAL_LENGTH ||
      body.password.length > MAX_CREDENTIAL_LENGTH
    ) {
      // Use a generic message so we don't leak whether the field or format was
      // the problem, but still return 400 for obviously malformed input.
      res.status(400).json({ error: 'username and password are required' })
      return
    }

    try {
      const user = await users.verifyCredentials(body.username, body.password)
      if (!user) {
        // Do not distinguish "unknown user" from "wrong password" — both leak
        // information about which accounts exist.
        res.status(401).json({ error: 'Invalid credentials' })
        return
      }

      // Reset the failure counter so a legitimate user isn't punished for
      // fat-fingering their password a few times before typing it correctly.
      loginLimiter.reset(key)

      const sessionId = randomUUID()
      const registered = await users.registerSession(user.id, sessionId)
      if (!registered) {
        // Should not happen — the user was found moments ago. Still, refuse to
        // hand out a token that couldn't be revoked.
        res.status(500).json({ error: 'Login failed' })
        return
      }

      const token = issueToken({
        subject: user.id,
        expiresInSeconds: config.tokenTtlSeconds,
        secret: config.jwtSecret,
        tokenId: sessionId,
      })
      setAuthCookie(res, token, config)
      res.json({ user, expiresInSeconds: config.tokenTtlSeconds })
    } catch (err) {
      // Wrap unexpected errors so the caller sees a stable payload but the
      // original failure is still visible in the logs (without credentials).
      console.error('login: failed to verify credentials', {
        name: (err as Error).name,
        message: (err as Error).message,
      })
      res.status(500).json({ error: 'Login failed' })
    }
  })

  router.post('/logout', csrf, async (req: Request, res: Response) => {
    // Best-effort revocation: if the caller presented a valid session, drop
    // it from the allowlist so the JWT stops working immediately. We always
    // clear the cookie regardless — a caller with an already-expired token
    // still expects a clean logout response.
    try {
      const result = authenticate(req, deps)
      const jti = result?.payload.jti
      if (result && jti) {
        await revokeSessionSafely(users, result.user.id, jti)
      }
    } catch (err) {
      // Never fail the logout response over revocation errors — surface it in
      // the log so operators can investigate persistence issues.
      console.error('logout: failed to revoke session', {
        name: (err as Error).name,
        message: (err as Error).message,
      })
    }

    clearAuthCookie(res, config)
    res.json({ ok: true })
  })

  router.get('/me', requireAuth(deps), (req: Request, res: Response) => {
    // `requireAuth` populates req.user, and it's non-null here.
    res.json({ user: req.user })
  })

  // Convenience endpoint for the client to check auth state without a 401 in
  // the browser console every time it loads.
  router.get('/session', (req: Request, res: Response) => {
    const result = authenticate(req, deps)
    res.json({ user: result?.user ?? null })
  })

  return router
}

async function revokeSessionSafely(
  users: UserStore,
  userId: string,
  sessionId: string,
): Promise<void> {
  try {
    await users.revokeSession(userId, sessionId)
  } catch (err) {
    // Rethrow with context so the caller's log line pinpoints revocation.
    throw new Error(
      `failed to revoke session for user ${userId}: ${(err as Error).message}`,
    )
  }
}
