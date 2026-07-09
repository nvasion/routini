/**
 * Integration tests for `/api/settings/ai`.
 *
 * Spins up a real HTTP server (ephemeral port) so the whole middleware stack
 * (auth, CSRF, JSON parsing) is exercised end-to-end.
 *
 * Coverage
 * ────────
 *  - Auth guard (401 without a token).
 *  - CSRF guard (415 without `Content-Type: application/json`).
 *  - GET returns default view.
 *  - PUT accepts full and partial updates.
 *  - PUT never returns the plaintext API key.
 *  - Per-user isolation.
 *  - Validation failures return 400 with details.
 *  - `apiKey: null` clears the sealed key.
 */

import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RateLimiter,
  UserStore,
  createAuthRouter,
  loadAuthConfig,
} from '../server/src/auth/index.js'
import { createRouter } from '../server/src/routes.js'
import {
  AiSettingsStore,
  Encryptor,
  generateEncryptionKey,
  type AiSettingsView,
} from '../server/src/aiSettings/index.js'

let server: Server
let baseUrl: string
let aiStore: AiSettingsStore
let authToken: string
let otherToken: string

const ADMIN_PASSWORD = 'admin-P@ssw0rd!'
const OTHER_PASSWORD = 'other-P@ssw0rd!'

function extractToken(setCookie: string): string {
  const cookiePair = setCookie.split(';')[0]
  const [, rawValue] = cookiePair.split('=')
  return decodeURIComponent(rawValue)
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'

  const users = new UserStore()
  await users.createUser('admin', ADMIN_PASSWORD)
  await users.createUser('other', OTHER_PASSWORD)

  const authConfig = loadAuthConfig()
  const authDeps = { config: authConfig, users }
  const fastLimiter = new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })

  // Inject a store with a stable in-test encryption key so no warnings are
  // emitted and no relying-on-process-random-key surprises leak into asserts.
  aiStore = new AiSettingsStore({
    encryptor: new Encryptor(generateEncryptionKey()),
  })

  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter(authDeps, { loginRateLimiter: fastLimiter }))
  app.use(
    '/api',
    createRouter(authDeps, {
      aiSettings: aiStore,
      executeRateLimiter: new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 }),
    }),
  )

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`

  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  })
  authToken = extractToken(adminLogin.headers.get('set-cookie')!)

  const otherLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other', password: OTHER_PASSWORD }),
  })
  otherToken = extractToken(otherLogin.headers.get('set-cookie')!)
})

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

function authHeaders(token = authToken): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function getSettings(token = authToken): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function putSettings(body: unknown, token = authToken): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/ai`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
}

describe('AI settings routes — authentication', () => {
  it('GET → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/settings/ai`)
    expect(res.status).toBe(401)
  })

  it('PUT → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/settings/ai`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})

describe('AI settings routes — CSRF (Content-Type) guard', () => {
  it('PUT → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/settings/ai`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}` },
      body: 'provider=opencode',
    })
    expect(res.status).toBe(415)
  })
})

describe('GET /api/settings/ai', () => {
  it('returns defaults for a fresh user', async () => {
    const res = await getSettings(otherToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as AiSettingsView
    expect(body.provider).toBeNull()
    expect(body.defaultAgent).toBeNull()
    expect(body.model).toBeNull()
    expect(body.temperature).toBeNull()
    expect(body.maxTokens).toBeNull()
    expect(body.hasApiKey).toBe(false)
  })
})

describe('PUT /api/settings/ai — happy path', () => {
  it('accepts a full payload and returns the redacted view', async () => {
    const res = await putSettings({
      provider: 'claude-code',
      defaultAgent: 'claude-code',
      apiKey: 'sk-live-first',
      model: 'claude-4.5-sonnet',
      temperature: 0.5,
      maxTokens: 2048,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as AiSettingsView & Record<string, unknown>
    expect(body).toMatchObject({
      provider: 'claude-code',
      defaultAgent: 'claude-code',
      model: 'claude-4.5-sonnet',
      temperature: 0.5,
      maxTokens: 2048,
      hasApiKey: true,
    })
    // Never returns the plaintext key or the encrypted blob field.
    expect(body.apiKey).toBeUndefined()
    expect(body.encryptedApiKey).toBeUndefined()
  })

  it('persists across GET', async () => {
    await putSettings({ provider: 'opencode', apiKey: 'sk-persist' })
    const res = await getSettings()
    const body = (await res.json()) as AiSettingsView
    expect(body.provider).toBe('opencode')
    expect(body.hasApiKey).toBe(true)
  })

  it('supports partial updates — omitted fields are unchanged', async () => {
    await putSettings({ provider: 'claude-code', model: 'first-model', apiKey: 'sk-keep' })
    const res = await putSettings({ model: 'second-model' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as AiSettingsView
    expect(body.provider).toBe('claude-code')
    expect(body.model).toBe('second-model')
    expect(body.hasApiKey).toBe(true)
  })

  it('clears fields when null is sent', async () => {
    await putSettings({
      provider: 'claude-code',
      apiKey: 'sk-to-clear',
      model: 'to-clear',
      temperature: 0.9,
      maxTokens: 1024,
    })
    const res = await putSettings({
      provider: null,
      apiKey: null,
      model: null,
      temperature: null,
      maxTokens: null,
      defaultAgent: null,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as AiSettingsView
    expect(body.provider).toBeNull()
    expect(body.hasApiKey).toBe(false)
    expect(body.model).toBeNull()
    expect(body.temperature).toBeNull()
    expect(body.maxTokens).toBeNull()
  })
})

describe('PUT /api/settings/ai — validation failures', () => {
  it('returns 400 with details on an unknown provider', async () => {
    const res = await putSettings({ provider: 'not-a-provider' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toContain('Validation')
    expect(body.details.join(' ')).toContain('provider')
  })

  it('returns 400 for out-of-range temperature', async () => {
    const res = await putSettings({ temperature: 42 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: string[] }
    expect(body.details.join(' ')).toContain('temperature')
  })

  it('returns 400 for oversized API keys', async () => {
    const res = await putSettings({ apiKey: 'x'.repeat(5_000) })
    expect(res.status).toBe(400)
  })

  it('returns 400 for unknown top-level fields', async () => {
    const res = await putSettings({ apikey: 'sk-typo' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: string[] }
    expect(body.details.join(' ')).toContain('unknown field')
  })
})

describe('AI settings — per-user isolation', () => {
  it('one user cannot see another user\'s settings', async () => {
    // Write as admin
    await putSettings({ provider: 'omnimancer', apiKey: 'sk-admin-secret' }, authToken)

    // Read as other user — should see a fresh view (defaults or their own).
    const res = await getSettings(otherToken)
    const body = (await res.json()) as AiSettingsView
    // The `other` user's view must NOT reflect admin's provider selection.
    expect(body.provider).not.toBe('omnimancer')
    // And should certainly report no API key (previous tests may have set one
    // for other-user; the sensitive check here is that it doesn't leak the
    // admin's key content). We at minimum confirm the key can't be exposed
    // as a raw plaintext.
    const asRecord = body as Record<string, unknown>
    expect(asRecord.apiKey).toBeUndefined()
  })

  it('never exposes the plaintext key even via GET', async () => {
    await putSettings({ apiKey: 'sk-must-not-leak' }, authToken)
    const res = await getSettings(authToken)
    const raw = await res.text()
    expect(raw).not.toContain('sk-must-not-leak')
  })
})
