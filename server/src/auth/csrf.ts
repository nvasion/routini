import type { NextFunction, Request, Response } from 'express'

/**
 * CSRF protection for state-changing endpoints authenticated via cookies.
 *
 * The auth cookie is `SameSite=Lax`, which alone blocks most cross-site
 * form-submit attacks against POST/PUT/PATCH/DELETE endpoints. To close the
 * remaining gap (some browsers, older configurations, and defense-in-depth),
 * this middleware requires state-changing requests to declare
 * `Content-Type: application/json`:
 *
 *   - HTML forms cannot submit `application/json` — they are limited to
 *     `application/x-www-form-urlencoded`, `multipart/form-data`, or
 *     `text/plain`, per the HTML spec. That eliminates the classic
 *     "hidden form auto-submits" CSRF payload.
 *   - Cross-origin fetches with `Content-Type: application/json` trigger a
 *     CORS preflight, so an attacker's site cannot smuggle one through
 *     unless our server explicitly allows their origin — which our CORS
 *     configuration does not.
 *
 * The result is a lightweight, header-only CSRF defense that works with the
 * existing HttpOnly cookie flow and does not require a per-request token.
 * A per-token scheme (e.g. `X-CSRF-Token` double-submit) can be layered on
 * top later without changing the wire format for legitimate clients.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const REQUIRED_CONTENT_TYPE = 'application/json'

export interface CsrfProtectOptions {
  /** Override methods considered state-changing. Defaults to POST/PUT/PATCH/DELETE. */
  unsafeMethods?: Iterable<string>
}

/**
 * Returns an Express middleware that rejects state-changing requests whose
 * `Content-Type` is not `application/json`. Safe methods (GET, HEAD, OPTIONS)
 * pass through untouched.
 */
export function csrfProtect(options: CsrfProtectOptions = {}) {
  const methods = new Set(
    [...(options.unsafeMethods ?? UNSAFE_METHODS)].map((m) => m.toUpperCase()),
  )
  return function csrfProtectMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!methods.has(req.method.toUpperCase())) {
      next()
      return
    }
    if (!hasJsonContentType(req.headers['content-type'])) {
      // 415 is the RFC-accurate response for "wrong Content-Type"; using it
      // (rather than 400) lets legitimate clients disambiguate this from a
      // malformed body and adjust their headers.
      res.status(415).json({
        error: 'Content-Type must be application/json',
      })
      return
    }
    next()
  }
}

/**
 * Case-insensitively check whether a Content-Type header (which may include
 * parameters like `; charset=utf-8`) starts with `application/json`. Kept as a
 * standalone helper so both the middleware and tests can exercise the same
 * parsing rules.
 */
export function hasJsonContentType(header: unknown): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const semi = header.indexOf(';')
  const mediaType = (semi === -1 ? header : header.slice(0, semi)).trim().toLowerCase()
  return mediaType === REQUIRED_CONTENT_TYPE
}
