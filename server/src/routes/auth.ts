import { Router, Request, Response, NextFunction } from 'express'
import { hashSync, compareSync } from 'bcryptjs'
import jwt from 'jsonwebtoken'
const { sign, verify, TokenExpiredError } = jwt
import { randomBytes, randomUUID } from 'node:crypto'
import rateLimit from 'express-rate-limit'
import type { User } from '../types.js'

// ── Global type augmentation ──────────────────────────────────────
// Extend Express Request so downstream handlers can access the
// authenticated user and CSRF token set by requireAuth.
declare global {
  namespace Express {
    interface Request {
      user?: User
      /**
       * CSRF token extracted from the JWT.
       * Set only when auth was performed via the HTTP-only cookie.
       * Undefined when auth uses a Bearer token (CSRF is not required
       * for Bearer-based auth because Bearer tokens in sessionStorage
       * cannot be forged cross-origin – OWASP CSRF Cheat Sheet §7.2).
       */
      csrfToken?: string
    }
  }
}

export const authRouter = Router()

// ── Configuration ─────────────────────────────────────────────────

const COOKIE_NAME = 'routini_token' as const
const CSRF_HEADER = 'x-csrf-token' as const
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 h

// JWT_SECRET must be set via environment variable in production.
// In development/test an ephemeral secret is generated so the server starts
// without configuration; tokens are invalidated on every restart.
const JWT_SECRET: string = process.env['JWT_SECRET'] ?? (() => {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production')
  }
  console.warn(
    '[auth] JWT_SECRET not set – using ephemeral secret (dev/test only). ' +
    'All tokens are invalidated on restart.',
  )
  return randomBytes(32).toString('hex')
})()

const JWT_EXPIRES_IN = '24h'

// Fewer bcrypt rounds in test environments for speed; 10 rounds in production.
const BCRYPT_ROUNDS = process.env['NODE_ENV'] === 'test' ? 1 : 10

// ── In-memory stores (skeleton – no persistence) ──────────────────

interface StoredUser extends User {
  /** bcrypt digest */
  passwordHash: string
}

// userId → StoredUser
export const users = new Map<string, StoredUser>()

// Revoked JWT IDs (jti claim) – populated on logout.
// In production, move this to Redis or a database.
const revokedJtis = new Set<string>()

// Pre-computed dummy hash used in constant-time comparisons for unknown emails,
// preventing timing attacks that reveal whether an email is registered.
const DUMMY_HASH = hashSync('__dummy_to_prevent_timing_attack__', BCRYPT_ROUNDS)

// Seed developer account – configure via environment variables.
const seedUser: StoredUser = {
  id: randomUUID(),
  email: process.env['SEED_EMAIL'] ?? 'admin@routini.dev',
  passwordHash: hashSync(process.env['SEED_PASSWORD'] ?? 'changeme', BCRYPT_ROUNDS),
  createdAt: new Date().toISOString(),
}
users.set(seedUser.id, seedUser)

// ── Helpers ───────────────────────────────────────────────────────

function safeUser(u: StoredUser): User {
  const { passwordHash: _drop, ...safe } = u
  return safe
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

interface JwtPayload {
  userId: string
  email: string
  jti?: string
  csrfToken?: string
}

/**
 * Verify a raw JWT string. Returns the decoded payload if the token is valid
 * and has not been revoked, or null otherwise. Never throws.
 */
function verifyJwt(token: string): JwtPayload | null {
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload
    if (payload.jti && revokedJtis.has(payload.jti)) {
      return null // revoked
    }
    return payload
  } catch {
    return null
  }
}

// ── Rate limiter for login endpoint ───────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 10,                   // max 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
  // Skip rate limiting in test environments so integration tests are not blocked
  // by the shared in-process store.
  skip: () => process.env['NODE_ENV'] === 'test',
})

// ── POST /api/auth/login ─────────────────────────────────────────

authRouter.post('/login', loginLimiter, (req: Request, res: Response) => {
  const { email, password } = req.body as Record<string, unknown>

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' })
    return
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Invalid email format' })
    return
  }

  if (typeof password !== 'string') {
    res.status(400).json({ error: 'Password must be a string' })
    return
  }

  const user = [...users.values()].find(u => u.email === email)

  // Always run bcrypt compare (with a dummy hash for unknown emails) so that
  // the response time is the same regardless of whether the email exists.
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH
  const valid = compareSync(password, hashToCompare)

  if (!user || !valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const jti = randomUUID()

  // Generate a cryptographically random CSRF token and embed it in the JWT.
  // The client receives the CSRF token in the response body, stores it in
  // sessionStorage, and must include it as X-CSRF-Token on all state-changing
  // requests when using cookie-based auth (Double-Submit Cookie pattern).
  const csrfToken = randomBytes(32).toString('hex')

  const token = sign(
    { userId: user.id, email: user.email, jti, csrfToken },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  )

  // Set the JWT in an HTTP-only cookie for browser clients.
  //  - httpOnly:   prevents XSS from reading the token via document.cookie
  //  - sameSite:   'strict' provides defense-in-depth against CSRF
  //  - secure:     HTTPS-only in production
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS,
  })

  // Return:
  //  - token:      raw JWT for programmatic / test clients using Bearer auth
  //  - user:       safe user object (no password hash)
  //  - csrfToken:  for browser clients using cookie-based auth; must be stored
  //                in sessionStorage (not in an accessible cookie) so it can be
  //                sent as a request header
  res.json({ token, user: safeUser(user), csrfToken })
})

// ── POST /api/auth/logout ─────────────────────────────────────────

authRouter.post('/logout', (req: Request, res: Response) => {
  // Accept the JWT from either the HTTP-only cookie or a Bearer token header
  // so both browser clients and test clients can revoke their session.
  const cookieToken: string | undefined = req.cookies?.[COOKIE_NAME]
  const bearerToken = extractBearerToken(req)
  const rawToken = cookieToken ?? bearerToken

  if (rawToken) {
    try {
      const decoded = verify(rawToken, JWT_SECRET) as { jti?: string }
      if (decoded.jti) {
        revokedJtis.add(decoded.jti)
      }
    } catch {
      // Token invalid or already expired — nothing to revoke
    }
  }

  // Clear the HTTP-only cookie regardless of whether the token was valid.
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env['NODE_ENV'] === 'production',
  })

  res.json({ message: 'Logged out successfully' })
})

// ── Auth middleware ───────────────────────────────────────────────

/**
 * Express middleware that enforces authentication.
 *
 * Auth is accepted from two sources (checked in priority order):
 *
 * 1. HTTP-only cookie (`routini_token`) — preferred for browser clients.
 *    Sets req.csrfToken from the JWT payload so that requireCsrf can
 *    enforce the Double-Submit Cookie pattern on state-changing routes.
 *
 * 2. Authorization: Bearer <token> header — for programmatic/test clients.
 *    req.csrfToken is left undefined. CSRF protection is not required for
 *    Bearer tokens because they live in sessionStorage, which is inaccessible
 *    to cross-origin attackers (OWASP CSRF Cheat Sheet §7.2).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // ── 1. Cookie-based auth ─────────────────────────────────────────
  const cookieToken: string | undefined = req.cookies?.[COOKIE_NAME]
  if (cookieToken) {
    const payload = verifyJwt(cookieToken)
    if (payload) {
      const user = users.get(payload.userId)
      if (user) {
        req.user = safeUser(user)
        // Expose the CSRF token so requireCsrf can validate it.
        req.csrfToken = payload.csrfToken
        next()
        return
      }
    }
    // Cookie is present but invalid/expired/revoked — clear it and fall through
    // to the Bearer check so the client gets a 401 rather than a misleading 403.
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env['NODE_ENV'] === 'production',
    })
  }

  // ── 2. Bearer token auth ─────────────────────────────────────────
  const bearerToken = extractBearerToken(req)
  if (!bearerToken) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  let payload: JwtPayload
  try {
    const decoded = verify(bearerToken, JWT_SECRET) as JwtPayload
    if (decoded.jti && revokedJtis.has(decoded.jti)) {
      res.status(401).json({ error: 'Token has been revoked' })
      return
    }
    payload = decoded
  } catch (err) {
    const message =
      err instanceof TokenExpiredError ? 'Token has expired' : 'Invalid or expired token'
    res.status(401).json({ error: message })
    return
  }

  const user = users.get(payload.userId)
  if (!user) {
    res.status(401).json({ error: 'User not found' })
    return
  }

  req.user = safeUser(user)
  // req.csrfToken is intentionally NOT set for Bearer auth.
  // CSRF attacks exploit the automatic inclusion of cookies in cross-site
  // requests. Bearer tokens require explicit JavaScript inclusion and cannot
  // be forged cross-origin, so CSRF protection is unnecessary here.
  next()
}

/**
 * CSRF protection middleware for state-changing endpoints (POST, PUT, DELETE).
 * Must run after requireAuth so req.csrfToken is populated.
 *
 * Enforcement is conditional on the auth method:
 *  - Cookie auth   → req.csrfToken is set → header validation is enforced.
 *  - Bearer auth   → req.csrfToken is undefined → validation is skipped.
 *
 * This follows the established principle that CSRF protection is only required
 * when the session credential is automatically included by the browser
 * (i.e., via cookies). Bearer tokens require explicit JS inclusion and are
 * therefore inherently CSRF-safe.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  // Skip for Bearer-token-authenticated requests (req.csrfToken not set).
  if (req.csrfToken === undefined) {
    next()
    return
  }

  const headerToken = req.headers[CSRF_HEADER] as string | undefined
  if (!headerToken || headerToken !== req.csrfToken) {
    res.status(403).json({ error: 'CSRF token validation failed' })
    return
  }

  next()
}

// ── GET /api/auth/me ──────────────────────────────────────────────

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  // req.user is guaranteed by requireAuth. Return the safe user object;
  // never include password hashes or other sensitive fields.
  res.json(req.user)
})
