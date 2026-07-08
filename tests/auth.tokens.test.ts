import { describe, expect, it } from 'vitest'
import { TokenError, issueToken, verifyToken } from '../server/src/auth/tokens.js'

const SECRET = 'test-secret-for-jwt-signing-1234567890'

describe('auth/tokens', () => {
  it('round-trips subject + expiration', () => {
    const token = issueToken({ subject: 'user-1', expiresInSeconds: 60, secret: SECRET })
    const payload = verifyToken(token, { secret: SECRET })
    expect(payload.sub).toBe('user-1')
    expect(payload.exp - payload.iat).toBe(60)
  })

  it('rejects an unsigned token', () => {
    // Header + payload with an empty signature.
    const tampered = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.'
    expect(() => verifyToken(tampered, { secret: SECRET })).toThrow(TokenError)
  })

  it('rejects a token signed with a different secret', () => {
    const token = issueToken({ subject: 'user-1', expiresInSeconds: 60, secret: SECRET })
    expect(() => verifyToken(token, { secret: 'other-secret' })).toThrow(/invalid signature/)
  })

  it('rejects a token whose payload has been tampered with', () => {
    const token = issueToken({ subject: 'user-1', expiresInSeconds: 60, secret: SECRET })
    const parts = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', iat: 0, exp: 9999999999 }))
      .toString('base64')
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`
    expect(() => verifyToken(tampered, { secret: SECRET })).toThrow(/invalid signature/)
  })

  it('rejects an expired token', () => {
    const t0 = 1_000_000_000_000
    const token = issueToken({
      subject: 'user-1',
      expiresInSeconds: 1,
      secret: SECRET,
      now: () => t0,
    })
    expect(() =>
      verifyToken(token, { secret: SECRET, now: () => t0 + 5000 }),
    ).toThrow(/expired/)
  })

  it('rejects malformed tokens', () => {
    expect(() => verifyToken('', { secret: SECRET })).toThrow(TokenError)
    expect(() => verifyToken('a.b', { secret: SECRET })).toThrow(/malformed/)
    expect(() => verifyToken('a.b.c.d', { secret: SECRET })).toThrow(/malformed/)
  })

  it('requires secret and subject when issuing', () => {
    expect(() => issueToken({ subject: 'x', expiresInSeconds: 60, secret: '' })).toThrow(
      /secret/,
    )
    expect(() => issueToken({ subject: '', expiresInSeconds: 60, secret: SECRET })).toThrow(
      /subject/,
    )
    expect(() =>
      issueToken({ subject: 'x', expiresInSeconds: 0, secret: SECRET }),
    ).toThrow(/expiresInSeconds/)
  })

  it('round-trips an optional session id (jti) claim', () => {
    const token = issueToken({
      subject: 'user-1',
      expiresInSeconds: 60,
      secret: SECRET,
      tokenId: 'sess-abc',
    })
    const payload = verifyToken(token, { secret: SECRET })
    expect(payload.jti).toBe('sess-abc')
  })

  it('rejects an empty tokenId when issuing', () => {
    expect(() =>
      issueToken({ subject: 'x', expiresInSeconds: 60, secret: SECRET, tokenId: '' }),
    ).toThrow(/tokenId/)
  })
})
