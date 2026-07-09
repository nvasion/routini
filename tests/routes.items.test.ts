/**
 * Integration tests for the demo Items CRUD API.
 *
 * Routes under test (all mounted under /api, protected by requireAuth):
 *   GET    /api/items          — list all items
 *   GET    /api/items/:id      — get item by numeric id
 *   POST   /api/items          — create a new item (CSRF-protected)
 *   DELETE /api/items/:id      — delete an item (CSRF-protected)
 *
 * A real HTTP server is spun up on an ephemeral port so the entire middleware
 * stack (auth, CSRF, JSON parsing, error handling) is exercised end-to-end.
 *
 * Coverage includes:
 *   - Authentication guard (401 without a token)
 *   - CSRF guard (415 for state-changing requests without application/json)
 *   - Happy paths for all four operations
 *   - Input validation edge cases (invalid id, oversized name, etc.)
 *   - 404 for non-existent resources
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

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let authToken: string

const ALICE_PASSWORD = 'alice-P@ssw0rd!'

function extractToken(setCookie: string): string {
  const cookiePair = setCookie.split(';')[0]
  const [, rawValue] = cookiePair.split('=')
  return decodeURIComponent(rawValue)
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'

  const users = new UserStore()
  await users.createUser('alice', ALICE_PASSWORD)

  const authConfig = loadAuthConfig()
  const authDeps = { config: authConfig, users }
  const fastLimiter = new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })

  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter(authDeps, { loginRateLimiter: fastLimiter }))
  app.use(
    '/api',
    createRouter(authDeps, {
      executeRateLimiter: new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 }),
    }),
  )

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: ALICE_PASSWORD }),
  })
  authToken = extractToken(loginRes.headers.get('set-cookie')!)
})

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Item {
  id: number
  name: string
  createdAt: string
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  }
}

async function getItems(): Promise<Response> {
  return fetch(`${baseUrl}/api/items`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })
}

async function getItem(id: number | string): Promise<Response> {
  return fetch(`${baseUrl}/api/items/${id}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })
}

async function createItem(name: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/items`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  })
}

async function deleteItem(id: number | string): Promise<Response> {
  return fetch(`${baseUrl}/api/items/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe('items endpoints — authentication required', () => {
  it('GET /api/items → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/items`)
    expect(res.status).toBe(401)
  })

  it('GET /api/items/:id → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/items/1`)
    expect(res.status).toBe(401)
  })

  it('POST /api/items → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Item' }),
    })
    expect(res.status).toBe(401)
  })

  it('DELETE /api/items/:id → 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/items/1`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// CSRF guard
// ---------------------------------------------------------------------------

describe('items endpoints — CSRF (Content-Type) guard', () => {
  it('POST /api/items → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: 'name=Test',
    })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('content-type')
  })

  it('DELETE /api/items/:id → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/items/1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('content-type')
  })
})

// ---------------------------------------------------------------------------
// GET /api/items — list
// ---------------------------------------------------------------------------

describe('GET /api/items', () => {
  it('returns 200 with an items array and a numeric count', async () => {
    const res = await getItems()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Item[]; count: number }
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.count).toBe('number')
    expect(body.count).toBe(body.items.length)
  })

  it('includes default seed items on first call', async () => {
    const res = await getItems()
    const { items } = (await res.json()) as { items: Item[] }
    // The router is initialized with 2 default items
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(items.some((i) => i.name === 'First Item')).toBe(true)
    expect(items.some((i) => i.name === 'Second Item')).toBe(true)
  })

  it('each item has id, name, and ISO createdAt', async () => {
    const res = await getItems()
    const { items } = (await res.json()) as { items: Item[] }
    for (const item of items) {
      expect(typeof item.id).toBe('number')
      expect(typeof item.name).toBe('string')
      expect(Number.isNaN(new Date(item.createdAt).getTime())).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/items/:id — single item
// ---------------------------------------------------------------------------

describe('GET /api/items/:id', () => {
  it('returns the correct item for a known id', async () => {
    const res = await getItem(1)
    expect(res.status).toBe(200)
    const item = (await res.json()) as Item
    expect(item.id).toBe(1)
    expect(item.name).toBe('First Item')
    expect(item.createdAt).toBeTruthy()
  })

  it('returns 404 for a non-existent numeric id', async () => {
    const res = await getItem(999_999)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('not found')
  })

  it('returns 400 for a non-numeric id', async () => {
    const res = await getItem('abc')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid')
  })

  it('returns 400 for id=0 (non-positive)', async () => {
    const res = await getItem(0)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid')
  })

  it('returns 400 for a negative id', async () => {
    const res = await getItem(-5)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid')
  })
})

// ---------------------------------------------------------------------------
// POST /api/items — create
// ---------------------------------------------------------------------------

describe('POST /api/items', () => {
  it('creates an item and returns 201 with the new item', async () => {
    const res = await createItem('My New Item')
    expect(res.status).toBe(201)
    const item = (await res.json()) as Item
    expect(typeof item.id).toBe('number')
    expect(item.name).toBe('My New Item')
    expect(Number.isNaN(new Date(item.createdAt).getTime())).toBe(false)
  })

  it('trims surrounding whitespace from the name', async () => {
    const res = await createItem('  Padded Name  ')
    expect(res.status).toBe(201)
    const item = (await res.json()) as Item
    expect(item.name).toBe('Padded Name')
  })

  it('returns 400 when name is missing from the body', async () => {
    const res = await fetch(`${baseUrl}/api/items`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('name')
  })

  it('returns 400 when name is an empty string', async () => {
    const res = await createItem('')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('name')
  })

  it('returns 400 when name is whitespace-only', async () => {
    const res = await createItem('   ')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('name')
  })

  it('returns 400 when name is not a string (numeric)', async () => {
    const res = await createItem(42)
    expect(res.status).toBe(400)
  })

  it('returns 400 when name exceeds 200 characters', async () => {
    const res = await createItem('x'.repeat(201))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('too long')
  })

  it('accepts a name of exactly 200 characters', async () => {
    const res = await createItem('a'.repeat(200))
    expect(res.status).toBe(201)
  })

  it('assigns incrementing ids to successive items', async () => {
    const first = await createItem('First sequential')
    const second = await createItem('Second sequential')

    const firstItem = (await first.json()) as Item
    const secondItem = (await second.json()) as Item

    expect(secondItem.id).toBe(firstItem.id + 1)
  })

  it('the created item is retrievable via GET /api/items/:id', async () => {
    const createRes = await createItem('Retrievable item')
    const created = (await createRes.json()) as Item

    const getRes = await getItem(created.id)
    expect(getRes.status).toBe(200)
    const retrieved = (await getRes.json()) as Item
    expect(retrieved.id).toBe(created.id)
    expect(retrieved.name).toBe('Retrievable item')
  })

  it('the created item appears in the list returned by GET /api/items', async () => {
    const uniqueName = `Listed-item-${Date.now()}`
    await createItem(uniqueName)

    const listRes = await getItems()
    const { items } = (await listRes.json()) as { items: Item[] }
    expect(items.some((i) => i.name === uniqueName)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/items/:id — delete
// ---------------------------------------------------------------------------

describe('DELETE /api/items/:id', () => {
  it('deletes an existing item and returns 200 with a confirmation', async () => {
    // Create an item we can safely delete
    const createRes = await createItem('To be deleted')
    const created = (await createRes.json()) as Item

    const res = await deleteItem(created.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string; id: number }
    expect(body.id).toBe(created.id)
    expect(body.message.toLowerCase()).toContain('deleted')
  })

  it('the deleted item is no longer retrievable via GET', async () => {
    const createRes = await createItem('Ephemeral item')
    const created = (await createRes.json()) as Item

    await deleteItem(created.id)

    const getRes = await getItem(created.id)
    expect(getRes.status).toBe(404)
  })

  it('the deleted item no longer appears in GET /api/items', async () => {
    const uniqueName = `Delete-me-${Date.now()}`
    const createRes = await createItem(uniqueName)
    const created = (await createRes.json()) as Item

    await deleteItem(created.id)

    const listRes = await getItems()
    const { items } = (await listRes.json()) as { items: Item[] }
    expect(items.some((i) => i.id === created.id)).toBe(false)
  })

  it('returns 404 for a non-existent item id', async () => {
    const res = await deleteItem(888_888)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('not found')
  })

  it('returns 400 for a non-numeric id', async () => {
    const res = await fetch(`${baseUrl}/api/items/xyz`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid')
  })

  it('returns 400 for id=0', async () => {
    const res = await deleteItem(0)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('invalid')
  })

  it('is idempotent in the sense that the second delete returns 404', async () => {
    const createRes = await createItem('Delete twice')
    const created = (await createRes.json()) as Item

    const first = await deleteItem(created.id)
    expect(first.status).toBe(200)

    const second = await deleteItem(created.id)
    expect(second.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// End-to-end lifecycle
// ---------------------------------------------------------------------------

describe('items — full create/retrieve/delete lifecycle', () => {
  it('creates, retrieves, deletes, and confirms the item is gone', async () => {
    // 1. Create
    const createRes = await createItem('Lifecycle test item')
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Item
    expect(created.name).toBe('Lifecycle test item')

    // 2. Retrieve by id
    const getRes = await getItem(created.id)
    expect(getRes.status).toBe(200)
    const retrieved = (await getRes.json()) as Item
    expect(retrieved.id).toBe(created.id)

    // 3. Confirm it's in the list
    const listRes = await getItems()
    const { items } = (await listRes.json()) as { items: Item[] }
    expect(items.some((i) => i.id === created.id)).toBe(true)

    // 4. Delete
    const deleteRes = await deleteItem(created.id)
    expect(deleteRes.status).toBe(200)

    // 5. Confirm it's gone
    const afterGet = await getItem(created.id)
    expect(afterGet.status).toBe(404)

    const afterList = await getItems()
    const { items: afterItems } = (await afterList.json()) as { items: Item[] }
    expect(afterItems.some((i) => i.id === created.id)).toBe(false)
  })
})
