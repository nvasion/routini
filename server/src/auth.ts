import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { Request, Response, NextFunction } from 'express'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number
  username: string
}

interface StoredUser {
  id: number
  username: string
  passwordHash: string
}

// Extend Express Request so downstream handlers see req.user and req.csrfToken
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
      /** CSRF token extracted from the verified JWT. Set by requireAuth. */
      csrfToken?: string
    }
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'routini_token'
const CSRF_HEADER = 'x-csrf-token' as const
const JWT_EXPIRES_IN = '24h'
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 h

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production')
  }
  if (!secret) {
    console.warn('[auth] JWT_SECRET not set — using insecure development default')
  }
  return secret ?? 'dev-secret-change-in-production'
}

// ── In-memory user store ──────────────────────────────────────────────────────
// In production this would be a database. Passwords are always stored as
// bcrypt hashes; plain-text passwords never touch persistent storage.

const users: StoredUser[] = [
  {
    id: 1,
    username: 'admin',
    // bcryptjs hashSync is acceptable here — it runs once at startup
    passwordHash: bcrypt.hashSync('password', 10),
  },
]

// ── JWT helpers ───────────────────────────────────────────────────────────────

/**
 * Signs a JWT that embeds the user identity AND a cryptographically random
 * CSRF token. Binding the CSRF token to the JWT means it shares the same
 * expiry and cannot be forged without the JWT secret.
 */
export function signToken(user: AuthUser, csrfToken: string): string {
  return jwt.sign(
    { id: user.id, username: user.username, csrfToken },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRES_IN },
  )
}

export function verifyToken(token: string): { user: AuthUser; csrfToken: string } {
  const payload = jwt.verify(token, getJwtSecret())
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid token payload')
  }
  const { id, username, csrfToken } = payload as {
    id?: unknown
    username?: unknown
    csrfToken?: unknown
  }
  if (
    typeof id !== 'number' ||
    typeof username !== 'string' ||
    typeof csrfToken !== 'string'
  ) {
    throw new Error('Token payload missing required fields')
  }
  return { user: { id, username }, csrfToken }
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body

  // Validate inputs — never reveal which field was wrong (prevents enumeration)
  if (
    !username || typeof username !== 'string' ||
    !password || typeof password !== 'string'
  ) {
    res.status(400).json({ error: 'Username and password are required' })
    return
  }

  const user = users.find(u => u.username === username)

  // Always run bcrypt compare to avoid timing-based username enumeration
  const dummyHash = '$2a$10$invalidhashpaddingtomakecomparerunXXXXXXXXXXXXXXXXXXXX'
  const passwordValid = await bcrypt.compare(password, user?.passwordHash ?? dummyHash)

  if (!user || !passwordValid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  // Generate a cryptographically random CSRF token and embed it in the JWT.
  // The client receives the token in the response body and must include it
  // as the X-CSRF-Token header on all state-changing requests. The server
  // validates the header against the value stored in the JWT, binding CSRF
  // protection to the session without any server-side state.
  const csrfToken = crypto.randomBytes(32).toString('hex')
  const token = signToken({ id: user.id, username: user.username }, csrfToken)

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS,
  })

  res.json({ user: { id: user.id, username: user.username }, csrfToken })
}

export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, { sameSite: 'strict' })
  res.json({ message: 'Logged out successfully' })
}

export function meHandler(req: Request, res: Response): void {
  // req.user and req.csrfToken are both guaranteed by requireAuth middleware.
  // Returning csrfToken here allows the client to re-sync the in-memory token
  // after a page refresh without requiring any additional cookie or API calls.
  res.json({ user: req.user, csrfToken: req.csrfToken })
}

// ── Auth middleware ───────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token: string | undefined = req.cookies?.[COOKIE_NAME]

  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  try {
    const session = verifyToken(token)
    req.user = session.user
    req.csrfToken = session.csrfToken
    next()
  } catch (err) {
    // Clear a bad/expired cookie so the client is prompted to re-login
    res.clearCookie(COOKIE_NAME, { sameSite: 'strict' })
    res.status(401).json({ error: 'Invalid or expired session' })
  }
}

/**
 * CSRF protection middleware (must run after requireAuth so req.csrfToken is set).
 *
 * Validates the X-CSRF-Token request header against the CSRF token embedded
 * in the session JWT. This implements the Synchronizer Token Pattern without
 * server-side state: the token is cryptographically bound to the JWT and
 * cannot be forged without knowing the JWT secret.
 *
 * Apply to all state-changing routes (POST, PUT, PATCH, DELETE) that require
 * authentication. Read-only routes (GET, HEAD) do not need CSRF protection.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const headerToken = req.headers[CSRF_HEADER] as string | undefined

  if (!headerToken || !req.csrfToken || headerToken !== req.csrfToken) {
    res.status(403).json({ error: 'CSRF token validation failed' })
    return
  }

  next()
}
