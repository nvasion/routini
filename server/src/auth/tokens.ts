import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal HS256 JWT implementation using node:crypto.
 *
 * We avoid pulling in a third-party JWT library because the surface area we need
 * (sign/verify with HS256 + expiration) is small, and a single audited helper
 * is preferable to a large dependency graph.
 */

export interface JwtPayload {
  /** Subject — the user id. */
  sub: string
  /** Issued-at, seconds since epoch. */
  iat: number
  /** Expiration, seconds since epoch. */
  exp: number
  /**
   * Optional token id. Populated when the caller requested server-side session
   * revocation — the auth middleware pairs this against a per-user allowlist,
   * so logging out (or forced revocation) can invalidate a live token.
   */
  jti?: string
}

export interface IssueOptions {
  /** User id to place in `sub`. */
  subject: string
  /** Seconds until the token expires. */
  expiresInSeconds: number
  /** Secret used to sign the token. */
  secret: string
  /** Optional clock override, primarily for tests. */
  now?: () => number
  /**
   * Optional token id (`jti`). When present, the middleware requires this id
   * to still be registered in the user store — this is how we support real
   * server-side logout on top of stateless JWTs.
   */
  tokenId?: string
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenError'
  }
}

const HEADER = { alg: 'HS256', typ: 'JWT' }
const HEADER_ENCODED = base64UrlEncode(Buffer.from(JSON.stringify(HEADER)))

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(normalized, 'base64')
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest())
}

function nowSeconds(clock?: () => number): number {
  return Math.floor((clock?.() ?? Date.now()) / 1000)
}

export function issueToken(options: IssueOptions): string {
  if (!options.secret) {
    throw new TokenError('secret is required to issue a token')
  }
  if (!options.subject) {
    throw new TokenError('subject is required to issue a token')
  }
  if (!Number.isFinite(options.expiresInSeconds) || options.expiresInSeconds <= 0) {
    throw new TokenError('expiresInSeconds must be a positive finite number')
  }

  const iat = nowSeconds(options.now)
  const payload: JwtPayload = {
    sub: options.subject,
    iat,
    exp: iat + options.expiresInSeconds,
  }
  if (options.tokenId !== undefined) {
    if (typeof options.tokenId !== 'string' || options.tokenId.length === 0) {
      throw new TokenError('tokenId must be a non-empty string when provided')
    }
    payload.jti = options.tokenId
  }

  const payloadEncoded = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
  const signingInput = `${HEADER_ENCODED}.${payloadEncoded}`
  const signature = sign(signingInput, options.secret)
  return `${signingInput}.${signature}`
}

export interface VerifyOptions {
  secret: string
  now?: () => number
}

export function verifyToken(token: string, options: VerifyOptions): JwtPayload {
  if (!options.secret) {
    throw new TokenError('secret is required to verify a token')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TokenError('token is required')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new TokenError('malformed token')
  }
  const [headerEncoded, payloadEncoded, signatureEncoded] = parts

  // Constant-time comparison of the signature to prevent timing attacks.
  const expectedSignature = sign(`${headerEncoded}.${payloadEncoded}`, options.secret)
  const providedBytes = Buffer.from(signatureEncoded)
  const expectedBytes = Buffer.from(expectedSignature)
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    throw new TokenError('invalid signature')
  }

  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(base64UrlDecode(headerEncoded).toString('utf8'))
    payload = JSON.parse(base64UrlDecode(payloadEncoded).toString('utf8'))
  } catch {
    throw new TokenError('malformed token payload')
  }

  if (
    !header ||
    typeof header !== 'object' ||
    (header as { alg?: unknown }).alg !== 'HS256'
  ) {
    throw new TokenError('unsupported token algorithm')
  }

  if (!isJwtPayload(payload)) {
    throw new TokenError('malformed token payload')
  }

  if (payload.exp <= nowSeconds(options.now)) {
    throw new TokenError('token expired')
  }

  return payload
}

function isJwtPayload(value: unknown): value is JwtPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (
    typeof v.sub !== 'string' ||
    v.sub.length === 0 ||
    typeof v.iat !== 'number' ||
    typeof v.exp !== 'number'
  ) {
    return false
  }
  // jti is optional but, if present, must be a non-empty string.
  if (v.jti !== undefined && (typeof v.jti !== 'string' || v.jti.length === 0)) {
    return false
  }
  return true
}
