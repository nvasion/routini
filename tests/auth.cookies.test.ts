import { describe, expect, it } from 'vitest'
import { parseCookies, serializeCookie } from '../server/src/auth/cookies.js'

describe('auth/cookies', () => {
  describe('parseCookies', () => {
    it('returns an empty object for missing input', () => {
      expect(parseCookies(undefined)).toEqual({})
      expect(parseCookies(null)).toEqual({})
      expect(parseCookies('')).toEqual({})
    })

    it('parses multiple cookies with URL-encoded values', () => {
      const parsed = parseCookies('a=1; b=hello%20world; c=x%3Dy')
      expect(parsed).toEqual({ a: '1', b: 'hello world', c: 'x=y' })
    })

    it('keeps the first occurrence of a duplicated cookie name', () => {
      expect(parseCookies('a=first; a=second')).toEqual({ a: 'first' })
    })

    it('skips malformed pairs without throwing', () => {
      expect(parseCookies('a=1; garbage; b=2')).toEqual({ a: '1', b: '2' })
    })

    it('leaves the raw value if decoding fails', () => {
      // A lone % is not a valid URL encoding — parser must not crash.
      expect(parseCookies('a=100%')).toEqual({ a: '100%' })
    })
  })

  describe('serializeCookie', () => {
    it('sets HttpOnly, SameSite, Path, and Max-Age', () => {
      const cookie = serializeCookie('routini_auth', 'abc.def.ghi', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 60,
      })
      expect(cookie).toContain('routini_auth=abc.def.ghi')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('Max-Age=60')
    })

    it('URL-encodes values that contain unsafe characters', () => {
      const cookie = serializeCookie('name', 'a b;c', { maxAgeSeconds: 1 })
      expect(cookie.startsWith('name=a%20b%3Bc')).toBe(true)
    })

    it('rejects a cookie name that could inject additional attributes', () => {
      expect(() => serializeCookie('bad name', 'x')).toThrow(/invalid cookie name/)
      expect(() => serializeCookie('a;b', 'x')).toThrow(/invalid cookie name/)
    })

    it('floors and clamps Max-Age to a non-negative integer', () => {
      expect(serializeCookie('a', 'b', { maxAgeSeconds: -5 })).toContain('Max-Age=0')
      expect(serializeCookie('a', 'b', { maxAgeSeconds: 3.9 })).toContain('Max-Age=3')
    })
  })
})
