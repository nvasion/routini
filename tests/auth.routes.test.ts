import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  RateLimiter,
  UserStore,
  createAuthRouter,
  loadAuthConfig,
} from '../server/src/auth/index.js'
import { createRouter } from '../server/src/routes.js'

/**
 * Integration tests that spin up the real Express app against an ephemeral
 * port. This avoids adding a supertest dependency while still exercising the
 * middleware stack end-to-end (including JSON parsing and cookie handling).
 */

let server: Server
let baseUrl = ''
let users: UserStore

const KNOWN_PASSWORD = 'p@ssw0rd-known'

beforeAll(async () => {
  // Ensure the config helper doesn't demand a real secret in "production".
  process.env.NODE_ENV = 'test'

  users = new UserStore()
  await users.createUser('alice', KNOWN_PASSWORD)

  const config = loadAuthConfig()
  const deps = { config, users }

  const app = express()
  app.use(express.json())
  // Inject a permissive limiter — these tests exercise many logins per second
  // for the same account, which the production defaults would (correctly) trip.
  const testLimiter = new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })
  app.use('/api/auth', createAuthRouter(deps, { loginRateLimiter: testLimiter }))
  app.use('/api', createRouter(deps))

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

async function login(username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return res
}

function extractAuthCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error('missing Set-Cookie header')
  const first = setCookie.split(';')[0]
  const [name, value] = first.split('=')
  if (name !== AUTH_COOKIE_NAME) {
    throw new Error(`unexpected cookie ${name}`)
  }
  return value
}

describe('POST /api/auth/login', () => {
  it('issues a JWT cookie on valid credentials', async () => {
    const res = await login('alice', KNOWN_PASSWORD)
    expect(res.status).toBe(200)

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain(AUTH_COOKIE_NAME)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')

    const body = (await res.json()) as { user: { username: string }; expiresInSeconds: number }
    expect(body.user.username).toBe('alice')
    expect(body.expiresInSeconds).toBeGreaterThan(0)
  })

  it('returns 401 for the wrong password without revealing which field failed', async () => {
    const res = await login('alice', 'wrong-password')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid credentials')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 401 for an unknown user with the same message as bad password', async () => {
    const res = await login('nobody', KNOWN_PASSWORD)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid credentials')
  })

  it('returns 400 for missing or malformed credentials', async () => {
    const cases = [
      {},
      { username: 'alice' },
      { username: '', password: KNOWN_PASSWORD },
      { username: 'alice', password: '' },
      { username: 123, password: KNOWN_PASSWORD },
      { username: 'alice', password: 'x'.repeat(1024) },
    ]
    for (const body of cases) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })
})

describe('POST /api/auth/logout', () => {
  it('clears the auth cookie', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain(AUTH_COOKIE_NAME)
    expect(setCookie).toContain('Max-Age=0')
  })

  it('invalidates the token server-side so a stolen cookie stops working', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const token = decodeURIComponent(extractAuthCookie(loginRes.headers.get('set-cookie')))

    // Confirm the token works before logout.
    const before = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(before.status).toBe(200)

    // Log out with the same token, then re-use it — must be rejected.
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    expect(logoutRes.status).toBe(200)

    const after = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(after.status).toBe(401)
  })

  it('does not leak other sessions when one is revoked', async () => {
    const first = await login('alice', KNOWN_PASSWORD)
    const firstToken = decodeURIComponent(extractAuthCookie(first.headers.get('set-cookie')))

    const second = await login('alice', KNOWN_PASSWORD)
    const secondToken = decodeURIComponent(extractAuthCookie(second.headers.get('set-cookie')))
    expect(secondToken).not.toBe(firstToken)

    // Revoke only the first session.
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${firstToken}`,
        'Content-Type': 'application/json',
      },
    })
    expect(logoutRes.status).toBe(200)

    // Second session must still work.
    const stillGood = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${secondToken}` },
    })
    expect(stillGood.status).toBe(200)
  })

  it('rejects a logout without application/json Content-Type as a CSRF guard', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'anything=value',
    })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('content-type')
  })
})

describe('GET /api/auth/me', () => {
  it('returns 401 without a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`)
    expect(res.status).toBe(401)
  })

  it('accepts a Bearer token', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const token = extractAuthCookie(loginRes.headers.get('set-cookie'))
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { username: string } }
    expect(body.user.username).toBe('alice')
  })

  it('accepts the auth cookie', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const setCookie = loginRes.headers.get('set-cookie')!
    const cookiePair = setCookie.split(';')[0]
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookiePair },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a tampered token', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const token = decodeURIComponent(extractAuthCookie(loginRes.headers.get('set-cookie')))
    const [h, p, s] = token.split('.')
    const tampered = `${h}.${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tampered}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('protected /api/items', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/items`)
    expect(res.status).toBe(401)
  })

  it('allows authenticated requests', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const token = decodeURIComponent(extractAuthCookie(loginRes.headers.get('set-cookie')))
    const res = await fetch(`${baseUrl}/api/items`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('leaves /api/version publicly accessible', async () => {
    const res = await fetch(`${baseUrl}/api/version`)
    expect(res.status).toBe(200)
  })
})

describe('GET /api/auth/session', () => {
  it('returns null user when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: unknown }
    expect(body.user).toBeNull()
  })

  it('returns the current user when authenticated', async () => {
    const loginRes = await login('alice', KNOWN_PASSWORD)
    const token = decodeURIComponent(extractAuthCookie(loginRes.headers.get('set-cookie')))
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { username: string } | null }
    expect(body.user?.username).toBe('alice')
  })
})

describe('login rate limiting', () => {
  it('returns 429 with Retry-After after too many failed attempts', async () => {
    // Isolate this suite from the permissive shared limiter above.
    const rlUsers = new UserStore()
    await rlUsers.createUser('bob', 'right-password')
    const rlConfig = loadAuthConfig()
    const rlApp = express()
    rlApp.use(express.json())
    rlApp.use(
      '/api/auth',
      createAuthRouter(
        { config: rlConfig, users: rlUsers },
        {
          loginRateLimiter: new RateLimiter({ maxAttempts: 3, windowSeconds: 60 }),
        },
      ),
    )

    const rlServer = rlApp.listen(0)
    try {
      await new Promise<void>((resolve) =>
        rlServer.on('listening', () => resolve()),
      )
      const port = (rlServer.address() as AddressInfo).port
      const url = `http://127.0.0.1:${port}/api/auth/login`

      // Three bad attempts are allowed …
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'wrong' }),
        })
        expect(res.status).toBe(401)
      }

      // … the fourth trips the limiter.
      const throttled = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'wrong' }),
      })
      expect(throttled.status).toBe(429)
      const retryAfter = throttled.headers.get('retry-after')
      expect(retryAfter).not.toBeNull()
      expect(Number.parseInt(retryAfter ?? '0', 10)).toBeGreaterThan(0)
      const body = (await throttled.json()) as { error: string }
      expect(body.error.toLowerCase()).toContain('too many')
    } finally {
      await new Promise<void>((resolve) => rlServer.close(() => resolve()))
    }
  })
})
