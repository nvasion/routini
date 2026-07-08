import { describe, expect, it, vi } from 'vitest'
import { csrfProtect, hasJsonContentType } from '../server/src/auth/csrf.js'

/**
 * Unit tests for the CSRF middleware. We avoid spinning up a full Express app
 * here — the middleware only touches `req.method`, `req.headers`, and the
 * response — and cover the flow with plain fakes. Integration coverage (401
 * on a real Express instance) lives in tests/auth.routes.test.ts.
 */

interface FakeReq {
  method: string
  headers: Record<string, string>
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

describe('hasJsonContentType', () => {
  it('accepts the bare media type', () => {
    expect(hasJsonContentType('application/json')).toBe(true)
  })

  it('accepts a media type with parameters', () => {
    expect(hasJsonContentType('application/json; charset=utf-8')).toBe(true)
    expect(hasJsonContentType('APPLICATION/JSON;charset=UTF-8')).toBe(true)
  })

  it('rejects other media types', () => {
    expect(hasJsonContentType('text/plain')).toBe(false)
    expect(hasJsonContentType('application/x-www-form-urlencoded')).toBe(false)
    expect(hasJsonContentType('multipart/form-data; boundary=x')).toBe(false)
    // Sneaky lookalikes must not slip through.
    expect(hasJsonContentType('application/jsonx')).toBe(false)
    expect(hasJsonContentType('xapplication/json')).toBe(false)
  })

  it('rejects missing / non-string headers', () => {
    expect(hasJsonContentType(undefined)).toBe(false)
    expect(hasJsonContentType(null)).toBe(false)
    expect(hasJsonContentType('')).toBe(false)
    expect(hasJsonContentType(42)).toBe(false)
  })
})

describe('csrfProtect middleware', () => {
  it('allows safe methods through without inspecting Content-Type', () => {
    const mw = csrfProtect()
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const req = { method, headers: {} } as FakeReq
      const res = makeRes()
      const next = vi.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mw(req as any, res as any, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.statusCode).toBe(200)
    }
  })

  it('allows state-changing methods with application/json', () => {
    const mw = csrfProtect()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = { method, headers: { 'content-type': 'application/json' } } as FakeReq
      const res = makeRes()
      const next = vi.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mw(req as any, res as any, next)
      expect(next).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects state-changing methods without application/json with 415', () => {
    const mw = csrfProtect()
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    } as FakeReq
    const res = makeRes()
    const next = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(415)
    expect((res.body as { error: string }).error.toLowerCase()).toContain('content-type')
  })

  it('rejects state-changing methods with a missing Content-Type', () => {
    const mw = csrfProtect()
    const req = { method: 'DELETE', headers: {} } as FakeReq
    const res = makeRes()
    const next = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(415)
  })

  it('honors a custom unsafeMethods override', () => {
    const mw = csrfProtect({ unsafeMethods: ['GET'] })
    const req = { method: 'GET', headers: {} } as FakeReq
    const res = makeRes()
    const next = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(415)

    // POSTs are now considered safe under this override.
    const postReq = { method: 'POST', headers: {} } as FakeReq
    const postRes = makeRes()
    const postNext = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(postReq as any, postRes as any, postNext)
    expect(postNext).toHaveBeenCalledTimes(1)
  })
})
