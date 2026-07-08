/**
 * Public entry point for the auth module. Consumers should import from here
 * rather than reaching into individual files so we retain the freedom to
 * reorganize internals.
 */

export {
  AUTH_COOKIE_NAME,
  DEFAULT_ADMIN_SENTINEL_PASSWORD,
  DEFAULT_LOGIN_MAX_ATTEMPTS,
  DEFAULT_LOGIN_WINDOW_SECONDS,
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  loadAuthConfig,
} from './config.js'
export type { AuthConfig } from './config.js'
export { parseCookies, serializeCookie } from './cookies.js'
export type { CookieOptions } from './cookies.js'
export { csrfProtect, hasJsonContentType } from './csrf.js'
export type { CsrfProtectOptions } from './csrf.js'
export { authenticate, requireAuth } from './middleware.js'
export type { AuthDependencies, AuthenticationResult } from './middleware.js'
export { RateLimiter, clientIpFromRequest } from './rateLimit.js'
export type { RateLimitDecision, RateLimiterOptions } from './rateLimit.js'
export { createAuthRouter } from './routes.js'
export type { AuthRouterOptions } from './routes.js'
export { hashPassword, PasswordError, verifyPassword } from './passwords.js'
export { issueToken, TokenError, verifyToken } from './tokens.js'
export type { IssueOptions, JwtPayload, VerifyOptions } from './tokens.js'
export { UserStore, normalizeUsernameForKeying } from './userStore.js'
export type { User, UserStoreOptions } from './userStore.js'
