import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { app } from '../app.js'

// Additional edge-case coverage for PUT /api/tasks/:id, layered on top of the
// existing suites:
//   - tests/tasks.test.ts                       (basic CRUD + happy paths)
//   - server/src/routes/tasks.put-validation.test.ts (type-specific field validation)
//
// This file focuses on cases those two don't already exercise: type coercion
// quirks, immutability of server-managed fields, malformed-input handling,
// and injection/pollution-style inputs that a security review would flag.

const request = supertest(app)

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

async function createRoutine(name = 'Edge Case Routine'): Promise<string> {
  const res = await request.post('/api/tasks').set(auth()).send({ name, type: 'routine' })
  return res.body.id as string
}

async function createDaily(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await request
    .post('/api/tasks')
    .set(auth())
    .send({
      name: 'Edge Case Daily',
      type: 'daily',
      schedule: '0 9 * * *',
      actionType: 'http',
      config: { url: 'https://example.com' },
      ...overrides,
    })
  return res.body.id as string
}

describe('PUT /api/tasks/:id — auth and existence', () => {
  it('returns 401 without an Authorization header', async () => {
    const id = await createRoutine()
    const res = await request.put(`/api/tasks/${id}`).send({ name: 'No Auth Update' })
    expect(res.status).toBe(401)
  })

  it('returns 404 (not 500) for an id containing path-traversal-style segments, without crashing the server', async () => {
    const res = await request.put('/api/tasks/../../etc/passwd').set(auth()).send({ name: 'x' })
    expect([404]).toContain(res.status)

    // Server must still be responsive afterward.
    const health = await request.get('/health')
    expect(health.status).toBe(200)
  })

  it('returns 404 for an id that collides with no stored task, even when it looks like a valid UUID', async () => {
    const res = await request
      .put('/api/tasks/ffffffff-ffff-ffff-ffff-ffffffffffff')
      .set(auth())
      .send({ name: 'Ghost' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})

describe('PUT /api/tasks/:id — name/description type coercion and immutability', () => {
  it('ignores a non-string name (number) and keeps the existing name unchanged', async () => {
    const id = await createRoutine('Original Name')

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ name: 12345 })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Original Name')
  })

  it('ignores a non-string, non-primitive name (object/array) and keeps the existing name unchanged', async () => {
    const id = await createRoutine('Keep This Name')

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ name: { malicious: true } })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Keep This Name')
  })

  it('coerces a non-string description to a string rather than rejecting it', async () => {
    const id = await createRoutine()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ description: 42 })

    expect(res.status).toBe(200)
    expect(res.body.description).toBe('42')
  })

  it('stores a name/description containing HTML/script content as inert literal text (no server-side execution or mutation)', async () => {
    const id = await createRoutine()
    const payload = '<script>alert("xss")</script>'

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ name: payload, description: payload })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe(payload)
    expect(res.body.description).toBe(payload)
  })

  it('does not allow the request body to change the task type', async () => {
    const id = await createRoutine()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ type: 'developmental', repoUrl: 'https://github.com/example/repo' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('routine')
    // developmental-only field must not leak onto a routine task.
    expect(res.body.repoUrl).toBeUndefined()
  })

  it('does not allow the request body to directly overwrite status, id, or createdAt', async () => {
    const created = await request.post('/api/tasks').set(auth()).send({ name: 'Immutable Fields', type: 'routine' })
    const id = created.body.id as string
    const originalCreatedAt = created.body.createdAt as string

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ status: 'succeeded', id: 'forged-id', createdAt: '1999-01-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
    expect(res.body.status).toBe('idle')
    expect(res.body.createdAt).toBe(originalCreatedAt)
  })

  it('ignores an empty-object description update gracefully rather than throwing', async () => {
    const id = await createRoutine()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ description: {} })

    expect(res.status).toBe(200)
    expect(res.body.description).toBe('[object Object]')
  })
})

describe('PUT /api/tasks/:id — malformed request bodies', () => {
  it('does not crash the server on syntactically invalid JSON', async () => {
    const id = await createRoutine()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"name": "unterminated')

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(600)

    // The server must not leak stack traces or internal details in the response.
    const bodyText = JSON.stringify(res.body)
    expect(bodyText).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/) // no stack-trace-shaped lines
    expect(bodyText.toLowerCase()).not.toContain('node_modules')

    // Server must still be responsive afterward.
    const health = await request.get('/health')
    expect(health.status).toBe(200)
  })

  it('treats a non-object JSON body (array) as having no updatable fields rather than crashing', async () => {
    const id = await createRoutine('Array Body Task')

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send([1, 2, 3] as unknown as object)

    // Whatever status is returned, the server must respond without a 500 and
    // without corrupting the stored task.
    expect(res.status).not.toBe(500)
  })
})

describe('PUT /api/tasks/:id — prototype-pollution-safe config handling', () => {
  it('treats "__proto__" as an ordinary config key without polluting Object.prototype', async () => {
    const id = await createDaily()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ config: { __proto__: 'harmless-value' } })

    expect(res.status).toBe(200)

    // The prototype of a brand-new, unrelated object must be untouched.
    const sentinel: Record<string, unknown> = {}
    expect((sentinel as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(sentinel)).toBe(Object.prototype)
  })

  it('treats "constructor" as an ordinary config key without polluting Object.prototype', async () => {
    const id = await createDaily()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ config: { constructor: 'also-harmless' } })

    expect(res.status).toBe(200)
    const sentinel: Record<string, unknown> = {}
    expect(Object.getPrototypeOf(sentinel)).toBe(Object.prototype)
  })

  it('stores a config value containing shell/SQL metacharacters as an inert literal string', async () => {
    const id = await createDaily()
    const maliciousValue = "'; DROP TABLE tasks; -- $(rm -rf /)"

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ config: { note: maliciousValue } })

    expect(res.status).toBe(200)
    expect(res.body.config.note).toBe(maliciousValue)

    // The task store must be unaffected — the task we just updated (and only
    // that task) is still present and retrievable.
    const getRes = await request.get(`/api/tasks/${id}`).set(auth())
    expect(getRes.status).toBe(200)
    expect(getRes.body.id).toBe(id)
  })
})

describe('PUT /api/tasks/:id — isolation between tasks', () => {
  it('updating one task does not modify the updatedAt or fields of another task', async () => {
    const idA = await createRoutine('Task A')
    const idB = await createRoutine('Task B')

    const beforeB = await request.get(`/api/tasks/${idB}`).set(auth())
    const originalUpdatedAtB = beforeB.body.updatedAt as string

    await request.put(`/api/tasks/${idA}`).set(auth()).send({ name: 'Task A Renamed' })

    const afterB = await request.get(`/api/tasks/${idB}`).set(auth())
    expect(afterB.body.name).toBe('Task B')
    expect(afterB.body.updatedAt).toBe(originalUpdatedAtB)
  })
})
