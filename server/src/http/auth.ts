// ─────────────────────────────────────────────────────────────────────────────
// Authentication: signup, login, logout, me; requireAuth / requireCsrf.
//
// Session model (unchanged from pre-Phase-0):
//   – A signed JWT (HS256, 24h) carries the user id, a jti and a CSRF token.
//   – Browsers get it in an HTTP-only SameSite=Strict cookie and must echo the
//     CSRF token as X-CSRF-Token on mutations (double-submit).
//   – Programmatic clients send it as a Bearer token; CSRF does not apply.
//   – Logout revokes the jti in Postgres, so revocation survives restarts.
//
// Signup policy (config.signup): 'open' (hosted), 'first-user-only' (self-host
// default: whoever installs it creates the first account), or 'closed'.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type NextFunction, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { randomBytes, randomUUID } from 'node:crypto'
import { ah, badRequest, currentUser, HttpError, type AppContext } from './common.js'
import {
  addIdentity,
  addMembership,
  countUsers,
  createOrg,
  createUser,
  findUserByEmail,
  findUserById,
  isTokenRevoked,
  listOrgsForUser,
  publicUser,
  revokeToken,
  type OrgMembership,
} from '../repos/identity.js'

export const COOKIE_NAME = 'routini_token'
const CSRF_HEADER = 'x-csrf-token'
const TOKEN_TTL_SEC = 24 * 60 * 60
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

interface TokenPayload {
  sub: string
  jti: string
  csrf: string
  exp?: number
}

export interface Auth {
  router: Router
  requireAuth: (req: Request, res: Response, next: NextFunction) => void
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void
}

export function publicMemberships(ms: OrgMembership[]) {
  return ms.map(({ org, role }) => ({ id: org.id, slug: org.slug, name: org.name, plan: org.plan, role }))
}

export function createAuth(ctx: AppContext): Auth {
  const { db, config } = ctx
  const rounds = config.env === 'test' ? 1 : 10
  const dummyHash = bcrypt.hashSync('__routini_timing_equaliser__', rounds)
  const secure = config.env === 'production'
  const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, secure }

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
    skip: () => config.env === 'test',
  })

  function issueSession(res: Response, userId: string) {
    const csrf = randomBytes(32).toString('hex')
    const token = jwt.sign({ sub: userId, jti: randomUUID(), csrf }, config.jwtSecret, { expiresIn: TOKEN_TTL_SEC })
    res.cookie(COOKIE_NAME, token, { ...cookieOpts, maxAge: TOKEN_TTL_SEC * 1000 })
    return { token, csrfToken: csrf }
  }

  async function verify(token: string): Promise<TokenPayload | null> {
    let payload: TokenPayload
    try {
      payload = jwt.verify(token, config.jwtSecret) as TokenPayload
    } catch {
      return null
    }
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null
    if (await isTokenRevoked(db, payload.jti)) return null
    return payload
  }

  const parseCreds = (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>
    const email = typeof b['email'] === 'string' ? b['email'].trim() : ''
    const password = typeof b['password'] === 'string' ? b['password'] : ''
    if (!email || !password) throw badRequest('Email and password are required')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw badRequest('Invalid email format')
    return { email, password, body: b }
  }

  const router = Router()

  router.post(
    '/signup',
    limiter,
    ah(async (req, res) => {
      const { email, password, body } = parseCreds(req.body)
      if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        throw badRequest(`Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters`)
      }
      const displayName = typeof body['displayName'] === 'string' ? body['displayName'].trim().slice(0, 100) : ''
      const orgName = typeof body['orgName'] === 'string' && body['orgName'].trim() ? body['orgName'].trim().slice(0, 100) : null
      const hash = await bcrypt.hash(password, rounds)

      const result = await db.tx(async (q) => {
        if (config.signup === 'closed') throw new HttpError(403, 'Signup is disabled on this server')
        if (config.signup === 'first-user-only') {
          // Serialise concurrent first signups so exactly one wins.
          await q.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
          if ((await countUsers(q)) > 0) throw new HttpError(403, 'Signup is disabled on this server; ask an admin for an account')
        }
        if (await findUserByEmail(q, email)) throw new HttpError(409, 'An account with this email already exists')
        const user = await createUser(q, { email, passwordHash: hash, displayName })
        await addIdentity(q, user.id, 'local', user.email.toLowerCase())
        const name = orgName ?? (displayName || email.split('@')[0]!)
        const org = await createOrg(q, {
          name,
          slugBase: orgName ?? email.split('@')[0]!,
          plan: config.mode === 'hosted' ? 'free' : 'selfhost',
        })
        await addMembership(q, org.id, user.id, 'owner')
        return { user, orgs: await listOrgsForUser(q, user.id) }
      })

      const session = issueSession(res, result.user.id)
      res.status(201).json({ ...session, user: publicUser(result.user), orgs: publicMemberships(result.orgs) })
    }),
  )

  router.post(
    '/login',
    limiter,
    ah(async (req, res) => {
      const { email, password } = parseCreds(req.body)
      const user = await findUserByEmail(db, email)
      // Compare even for unknown emails so response time does not reveal which emails exist.
      const valid = await bcrypt.compare(password, user?.passwordHash ?? dummyHash)
      if (!user || !user.passwordHash || !valid) throw new HttpError(401, 'Invalid credentials')
      const session = issueSession(res, user.id)
      const orgs = await listOrgsForUser(db, user.id)
      res.json({ ...session, user: publicUser(user), orgs: publicMemberships(orgs) })
    }),
  )

  router.post(
    '/logout',
    ah(async (req, res) => {
      const raw: string | undefined = req.cookies?.[COOKIE_NAME] ?? bearer(req) ?? undefined
      if (raw) {
        try {
          const p = jwt.verify(raw, config.jwtSecret) as TokenPayload
          if (p.jti) await revokeToken(db, p.jti, new Date((p.exp ?? Date.now() / 1000 + TOKEN_TTL_SEC) * 1000))
        } catch {
          // invalid or expired: nothing to revoke
        }
      }
      res.clearCookie(COOKIE_NAME, cookieOpts)
      res.json({ message: 'Logged out' })
    }),
  )

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    void (async () => {
      const cookieToken: string | undefined = req.cookies?.[COOKIE_NAME]
      const bearerToken = bearer(req)
      const token = cookieToken ?? bearerToken
      if (!token) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }
      const payload = await verify(token)
      const user = payload ? await findUserById(db, payload.sub) : null
      if (!payload || !user) {
        if (cookieToken) res.clearCookie(COOKIE_NAME, cookieOpts)
        res.status(401).json({ error: 'Invalid or expired session' })
        return
      }
      req.user = publicUser(user)
      // CSRF applies only when the browser attached the credential automatically.
      req.csrfToken = cookieToken ? payload.csrf : undefined
      next()
    })().catch(next)
  }

  function requireCsrf(req: Request, res: Response, next: NextFunction): void {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.csrfToken === undefined) {
      next()
      return
    }
    if (req.headers[CSRF_HEADER] !== req.csrfToken) {
      res.status(403).json({ error: 'CSRF token validation failed' })
      return
    }
    next()
  }

  router.get(
    '/me',
    requireAuth,
    ah(async (req, res) => {
      const user = currentUser(req)
      res.json({ user, orgs: publicMemberships(await listOrgsForUser(db, user.id)) })
    }),
  )

  return { router, requireAuth, requireCsrf }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}
