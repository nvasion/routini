import type { NextFunction, Request, Response } from 'express'
import { AUTH_COOKIE_NAME, type AuthConfig } from './config.js'
import { parseCookies } from './cookies.js'
import { TokenError, verifyToken, type JwtPayload } from './tokens.js'
import type { User, UserStore } from './userStore.js'

declare module 'express-serve-static-core' {
  // Attach the authenticated user (and the underlying token payload) to the
  // request in a type-safe way. Downstream handlers can read `req.user`
  // without an unsafe cast; the logout route needs `req.authToken` to know
  // which session id to revoke.
  interface Request {
    user?: User
    authToken?: JwtPayload
  }
}

export interface AuthDependencies {
  config: AuthConfig
  users: UserStore
}

export interface AuthenticationResult {
  user: User
  payload: JwtPayload
}

export function requireAuth(deps: AuthDependencies) {
  return function requireAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const result = authenticate(req, deps)
    if (!result) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = result.user
    req.authToken = result.payload
    next()
  }
}

/**
 * Returns the authenticated user + token payload for a request, or null if no
 * valid token was presented. Never throws — callers should treat null as
 * "not authenticated".
 *
 * When the token contains a `jti` claim, this function additionally requires
 * the id to still be registered as an active session for the user. That's how
 * logout invalidates a live JWT server-side.
 */
export function authenticate(
  req: Request,
  deps: AuthDependencies,
): AuthenticationResult | null {
  const token = extractToken(req)
  if (!token) return null

  try {
    const payload = verifyToken(token, { secret: deps.config.jwtSecret })
    const user = deps.users.findById(payload.sub)
    if (!user) return null
    // If the token was issued with a session id, honor server-side revocation.
    // Tokens without a jti (older/machine tokens) still work by signature alone.
    if (payload.jti && !deps.users.isSessionActive(user.id, payload.jti)) {
      return null
    }
    return { user, payload }
  } catch (err) {
    if (err instanceof TokenError) return null
    // Any other error is unexpected; surface it via console.warn without the
    // token contents so we don't log a bearer credential.
    console.warn('auth middleware: unexpected verifyToken error', {
      name: (err as Error).name,
    })
    return null
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match) return match[1].trim()
  }
  const cookies = parseCookies(req.headers['cookie'])
  const cookieToken = cookies[AUTH_COOKIE_NAME]
  return cookieToken && cookieToken.length > 0 ? cookieToken : null
}
