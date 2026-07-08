/**
 * Minimal, spec-compliant cookie helpers. We avoid cookie-parser / cookie so
 * this remains a zero-dependency change; the two helpers below are the only
 * cookie mechanics the auth flow needs.
 */

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (typeof header !== 'string' || header.length === 0) {
    return cookies
  }
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const name = pair.slice(0, idx).trim()
    const rawValue = pair.slice(idx + 1).trim()
    if (name.length === 0) continue
    // First cookie with a given name wins, matching Express's cookie-parser.
    if (name in cookies) continue
    try {
      cookies[name] = decodeURIComponent(rawValue)
    } catch {
      cookies[name] = rawValue
    }
  }
  return cookies
}

export interface CookieOptions {
  maxAgeSeconds?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  path?: string
}

// Allowed cookie-name characters per RFC 6265. Reject anything else so a
// caller-supplied name cannot inject additional Set-Cookie attributes.
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (typeof name !== 'string' || !COOKIE_NAME_RE.test(name)) {
    throw new Error('invalid cookie name')
  }
  if (typeof value !== 'string') {
    throw new Error('invalid cookie value')
  }
  // encodeURIComponent's output is a subset of the RFC 6265 cookie-octet set,
  // so it is always safe to place unquoted in a Set-Cookie header.
  const encoded = encodeURIComponent(value)

  const segments = [`${name}=${encoded}`]
  segments.push(`Path=${options.path ?? '/'}`)
  if (options.httpOnly) segments.push('HttpOnly')
  if (options.secure) segments.push('Secure')
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`)
  if (typeof options.maxAgeSeconds === 'number' && Number.isFinite(options.maxAgeSeconds)) {
    // Max-Age must be a non-negative integer per RFC 6265.
    const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds))
    segments.push(`Max-Age=${maxAge}`)
  }
  return segments.join('; ')
}
