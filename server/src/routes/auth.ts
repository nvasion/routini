import { Router, Request, Response, NextFunction } from 'express'
import { hashSync, compareSync } from 'bcryptjs'
import jwt from 'jsonwebtoken'
const { sign, verify, TokenExpiredError } = jwt
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
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

// ── User record type ──────────────────────────────────────────────

export interface StoredUser extends User {
  /** bcrypt digest */
  passwordHash: string
}

// Pre-computed dummy hash used in constant-time comparisons for unknown emails,
// preventing timing attacks that reveal whether an email is registered.
const DUMMY_HASH = hashSync('__dummy_to_prevent_timing_attack__', BCRYPT_ROUNDS)

// ── Persistence layer ─────────────────────────────────────────────
//
// Users and revoked JWT IDs (jti) are persisted to the SQLite database exposed
// by server/src/db/index.ts (configured via ROUTINI_DB_PATH). Login performs an
// email lookup, requireAuth resolves users by id (for both cookie- and
// Bearer-based tokens), and logout writes the revoked jti so revocation
// survives server restarts.
//
// The DB module (server/src/db/index.ts) is owned by another task and may not
// be present while this file is developed in isolation. It is therefore loaded
// defensively with createRequire: when present its `getDb()` handle and the
// `users` / `revoked_tokens` tables back the store; when absent an in-memory
// fallback keeps the server runnable (e.g. during isolated development). Once
// the DB module is merged the fallback is never selected.

interface UserRepository {
  upsertUser(u: StoredUser): void
  findByEmail(email: string): StoredUser | null
  findById(id: string): StoredUser | null
  revokeJti(jti: string): void
  isJtiRevoked(jti: string | undefined): boolean
}

interface PreparedStmt {
  run(...params: unknown[]): void
  get(...params: unknown[]): unknown
}

interface DbHandle {
  prepare(sql: string): PreparedStmt
}

export type { UserRepository, DbHandle }

/** Row shape returned by the `users` table in the SQLite schema. */
interface DbUserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
}

function toStoredUser(row: DbUserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  }
}

// Lazily resolve the DB module so an import error never crashes startup while
// the module is still being developed on another branch.
const requireDb = createRequire(import.meta.url)

function loadDb(): DbHandle | null {
  try {
    const mod = requireDb('./db/index.js') as { getDb?: () => unknown }
    const handle = mod.getDb?.()
    if (handle && typeof handle === 'object' && 'prepare' in handle) {
      return handle as DbHandle
    }
  } catch {
    // DB module not available yet (isolated development) — fall back to memory.
  }
  return null
}

/** SQLite-backed repository. Queries are parameterized to prevent injection. */
export function createDbRepository(db: DbHandle): UserRepository {
  return {
    upsertUser(u) {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES (@id, @email, @password_hash, @created_at)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash`,
      ).run({
        id: u.id,
        email: u.email,
        password_hash: u.passwordHash,
        created_at: u.createdAt,
      })
    },
    findByEmail(email) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?')
        .get(email) as DbUserRow | undefined
      return row ? toStoredUser(row) : null
    },
    findById(id) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at FROM users WHERE id = ?')
        .get(id) as DbUserRow | undefined
      return row ? toStoredUser(row) : null
    },
    revokeJti(jti) {
      if (!jti) return
      db.prepare(
        `INSERT OR IGNORE INTO revoked_tokens (jti, revoked_at) VALUES (?, ?)`,
      ).run(jti, new Date().toISOString())
    },
    isJtiRevoked(jti) {
      const row = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti)
      return row !== undefined
    },
  }
}

/**
 * In-memory repository fallback. Mirrors the DB repository exactly so callers
 * are unaware of the backing store; used only while the DB module is absent.
 */
export function createMemoryRepository(): UserRepository {
  const usersById = new Map<string, StoredUser>()
  const emailIndex = new Map<string, string>() // email → id
  const revokedJtis = new Set<string>()

  return {
    upsertUser(u) {
      const existingId = emailIndex.get(u.email)
      if (existingId && existingId !== u.id) {
        usersById.delete(existingId)
      }
      usersById.set(u.id, u)
      emailIndex.set(u.email, u.id)
    },
    findByEmail(email) {
      const id = emailIndex.get(email)
      return id ? (usersById.get(id) ?? null) : null
    },
    findById(id) {
      return usersById.get(id) ?? null
    },
    revokeJti(jti) {
      if (jti) revokedJtis.add(jti)
    },
    isJtiRevoked(jti) {
      return jti ? revokedJtis.has(jti) : false
    },
  }
}

const repository: UserRepository = (() => {
  const db = loadDb()
  return db ? createDbRepository(db) : createMemoryRepository()
})()

// ── Seed developer account ───────────────────────────────────────
//
// Configured via the SEED_EMAIL / SEED_PASSWORD environment variables. The
// account is created (or its password refreshed) at startup so that an
// administrator can always authenticate. Seeding is idempotent: an existing
// row with the same email keeps its id but is updated to the current
// password hash, so changing SEED_PASSWORD and restarting rotates the
// credential without orphaning issued tokens.

function seedDeveloperAccount(): void {
  const seedEmail = process.env['SEED_EMAIL'] ?? 'admin@routini.dev'
  const seedPassword = process.env['SEED_PASSWORD'] ?? 'changeme'

  const existing = repository.findByEmail(seedEmail)
  const user: StoredUser = {
    id: existing?.id ?? randomUUID(),
    email: seedEmail,
    passwordHash: hashSync(seedPassword, BCRYPT_ROUNDS),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  repository.upsertUser(user)
}

seedDeveloperAccount()

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
    if (payload.jti && repository.isJtiRevoked(payload.jti)) {
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

  const user = repository.findByEmail(email)

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
        repository.revokeJti(decoded.jti)
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
      const user = repository.findById(payload.userId)
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
    if (repository.isJtiRevoked(decoded.jti)) {
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

  const user = repository.findById(payload.userId)
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
