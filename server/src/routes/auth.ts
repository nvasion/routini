import { Router, Request, Response, NextFunction } from 'express'
import { hashSync, compareSync } from 'bcryptjs'
import { sign, verify, TokenExpiredError } from 'jsonwebtoken'
import { randomBytes, randomUUID } from 'node:crypto'
import rateLimit from 'express-rate-limit'
import type { User } from '../types.js'

export const authRouter = Router()

// ── Configuration ─────────────────────────────────────────────────

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

// ── Rate limiter for login endpoint ───────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 10,                   // max 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
  // Skip rate limiting in test environments so integration tests are not blocked
  // by the shared in-process store. The limiter is still instantiated and tested
  // via the middleware being present; production behaviour is unchanged.
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
  const token = sign(
    { userId: user.id, email: user.email, jti },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  )

  res.json({ token, user: safeUser(user) })
})

// ── POST /api/auth/logout ─────────────────────────────────────────

authRouter.post('/logout', (req: Request, res: Response) => {
  const token = extractBearerToken(req)

  if (token) {
    try {
      const decoded = verify(token, JWT_SECRET) as { jti?: string }
      if (decoded.jti) {
        revokedJtis.add(decoded.jti)
      }
    } catch {
      // Token is invalid or already expired – nothing to revoke
    }
  }

  res.json({ message: 'Logged out successfully' })
})

// ── Auth middleware ───────────────────────────────────────────────
// Shared verification logic used by /me and requireAuth.

function verifyBearerToken(
  req: Request,
  res: Response,
): { user: User } | null {
  const token = extractBearerToken(req)

  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }

  let payload: { userId: string; email: string; jti?: string }
  try {
    payload = verify(token, JWT_SECRET) as { userId: string; email: string; jti?: string }
  } catch (err) {
    const message =
      err instanceof TokenExpiredError ? 'Token has expired' : 'Invalid or expired token'
    res.status(401).json({ error: message })
    return null
  }

  if (payload.jti && revokedJtis.has(payload.jti)) {
    res.status(401).json({ error: 'Token has been revoked' })
    return null
  }

  const user = users.get(payload.userId)
  if (!user) {
    res.status(401).json({ error: 'User not found' })
    return null
  }

  return { user: safeUser(user) }
}

/**
 * Express middleware that enforces Bearer-token authentication.
 * Mount before any router that should be protected.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const result = verifyBearerToken(req, res)
  if (result) next()
}

// ── GET /api/auth/me ──────────────────────────────────────────────

authRouter.get('/me', (req: Request, res: Response) => {
  const result = verifyBearerToken(req, res)
  if (!result) return
  res.json(result.user)
})
