import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'

const request = supertest(app)

// ── Auth helper ───────────────────────────────────────────────────
// All task endpoints require a valid Bearer token. Obtain one from the
// seed account before the test suite runs.

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

// ── GET /api/tasks ───────────────────────────────────────────────

describe('GET /api/tasks', () => {
  it('returns all tasks with a count', async () => {
    const res = await request.get('/api/tasks').set(auth())
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.tasks)).toBe(true)
    expect(typeof res.body.count).toBe('number')
    expect(res.body.count).toBe(res.body.tasks.length)
  })

  it('returns only daily tasks when filtered by type=daily', async () => {
    const res = await request.get('/api/tasks?type=daily').set(auth())
    expect(res.status).toBe(200)
    res.body.tasks.forEach((t: { type: string }) => {
      expect(t.type).toBe('daily')
    })
  })

  it('returns only idle tasks when filtered by status=idle', async () => {
    const res = await request.get('/api/tasks?status=idle').set(auth())
    expect(res.status).toBe(200)
    res.body.tasks.forEach((t: { status: string }) => {
      expect(t.status).toBe('idle')
    })
  })

  it('returns 400 for an invalid type filter', async () => {
    const res = await request.get('/api/tasks?type=badtype').set(auth())
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 for an invalid status filter', async () => {
    const res = await request.get('/api/tasks?status=badstatus').set(auth())
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/api/tasks')
    expect(res.status).toBe(401)
  })
})

// ── POST /api/tasks ──────────────────────────────────────────────

describe('POST /api/tasks', () => {
  it('creates a daily task with all required fields', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Test Daily Task',
      description: 'A test daily task',
      type: 'daily',
      schedule: '0 8 * * *',
      actionType: 'http',
      config: { url: 'https://example.com' },
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Test Daily Task')
    expect(res.body.type).toBe('daily')
    expect(res.body.status).toBe('idle')
    expect(typeof res.body.id).toBe('string')
    expect(res.body.id.length).toBeGreaterThan(0)
    expect(res.body.schedule).toBe('0 8 * * *')
  })

  it('creates a developmental task', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Test Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      branch: 'feature/test',
      agentId: 'claude',
    })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe('developmental')
    expect(res.body.repoUrl).toBe('https://github.com/example/repo')
    expect(res.body.branch).toBe('feature/test')
  })

  it('creates a routine task', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Test Routine',
      type: 'routine',
    })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe('routine')
    expect(Array.isArray(res.body.steps)).toBe(true)
  })

  it('trims whitespace from the name', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: '   Padded Name   ',
      type: 'routine',
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Padded Name')
  })

  it('returns 400 when name is missing', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({ type: 'daily' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/name/i)
  })

  it('returns 400 when name is blank', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({ name: '   ', type: 'daily' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/name/i)
  })

  it('returns 400 when type is missing', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({ name: 'No Type Task' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/type/i)
  })

  it('returns 400 for an invalid task type', async () => {
    const res = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Bad Type Task', type: 'invalid' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('returns 400 when developmental task is missing repoUrl', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Dev Without Repo',
      type: 'developmental',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/repoUrl/i)
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.post('/api/tasks').send({ name: 'No Auth', type: 'routine' })
    expect(res.status).toBe(401)
  })
})

// ── GET /api/tasks/:id ───────────────────────────────────────────

describe('GET /api/tasks/:id', () => {
  it('returns the task for a valid id', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Findable Task', type: 'routine' })
    const id = created.body.id as string

    const res = await request.get(`/api/tasks/${id}`).set(auth())
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
    expect(res.body.name).toBe('Findable Task')
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get('/api/tasks/00000000-0000-0000-0000-000000000000')
      .set(auth())
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})

// ── PUT /api/tasks/:id ───────────────────────────────────────────

describe('PUT /api/tasks/:id', () => {
  it('updates the task name', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Old Name', type: 'routine' })
    const id = created.body.id as string

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ name: 'New Name' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('New Name')
    expect(res.body.id).toBe(id)
  })

  it('updates updatedAt on every PUT', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Update Timer', type: 'routine' })
    const originalUpdatedAt = created.body.updatedAt as string

    await new Promise(r => setTimeout(r, 2)) // ensure clock advances

    const res = await request
      .put(`/api/tasks/${created.body.id}`)
      .set(auth())
      .send({ name: 'Updated' })
    expect(res.body.updatedAt).not.toBe(originalUpdatedAt)
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .put('/api/tasks/00000000-0000-0000-0000-000000000000')
      .set(auth())
      .send({ name: 'Ghost Update' })
    expect(res.status).toBe(404)
  })

  it('ignores a blank name and keeps the existing one', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Keep Me', type: 'routine' })
    const id = created.body.id as string

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ name: '' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Keep Me')
  })
})

// ── DELETE /api/tasks/:id ────────────────────────────────────────

describe('DELETE /api/tasks/:id', () => {
  it('deletes an existing task', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Delete Me', type: 'routine' })
    const id = created.body.id as string

    const del = await request.delete(`/api/tasks/${id}`).set(auth())
    expect(del.status).toBe(200)
    expect(del.body.id).toBe(id)

    // Confirm it's gone
    const get = await request.get(`/api/tasks/${id}`).set(auth())
    expect(get.status).toBe(404)
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .delete('/api/tasks/00000000-0000-0000-0000-000000000000')
      .set(auth())
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})

// ── POST /api/tasks/:id/trigger ──────────────────────────────────

describe('POST /api/tasks/:id/trigger', () => {
  it('queues an idle task', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Triggerable', type: 'routine' })
    const id = created.body.id as string

    const res = await request.post(`/api/tasks/${id}/trigger`).set(auth())
    expect(res.status).toBe(200)
    expect(res.body.task.status).toBe('queued')
    expect(res.body.task.id).toBe(id)
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .post('/api/tasks/00000000-0000-0000-0000-000000000000/trigger')
      .set(auth())
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })

  it('succeeds (200) when triggering a task that is already queued', async () => {
    // Only 'running' tasks are rejected with 409; a 'queued' task can be
    // re-triggered and its status is reset to 'queued' again.
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Double-Trigger Routine', type: 'routine' })
    const id = created.body.id as string

    // First trigger: idle → queued
    await request.post(`/api/tasks/${id}/trigger`).set(auth())

    // Second trigger: queued → queued (still allowed, not running)
    const second = await request.post(`/api/tasks/${id}/trigger`).set(auth())
    expect(second.status).toBe(200)
    expect(second.body.task.status).toBe('queued')
  })

  it('response body includes both task and message fields', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Trigger Shape Check', type: 'routine' })
    const id = created.body.id as string

    const res = await request.post(`/api/tasks/${id}/trigger`).set(auth())
    expect(res.status).toBe(200)
    expect(typeof res.body.message).toBe('string')
    expect(res.body.task).toBeDefined()
    expect(res.body.task.id).toBe(id)
  })
})

// ── GET /api/tasks – combined filters ────────────────────────────

describe('GET /api/tasks – combined type and status filters', () => {
  it('filters by both type=routine and status=idle simultaneously', async () => {
    // Create a routine task (starts idle) and a developmental task.
    await Promise.all([
      request.post('/api/tasks').set(auth()).send({ name: 'Combined Filter Routine', type: 'routine' }),
      request.post('/api/tasks').set(auth()).send({
        name: 'Combined Filter Dev',
        type: 'developmental',
        repoUrl: 'https://github.com/example/repo',
        agentId: 'claude',
      }),
    ])

    const res = await request.get('/api/tasks?type=routine&status=idle').set(auth())
    expect(res.status).toBe(200)
    // All returned tasks must match BOTH criteria
    for (const t of res.body.tasks as Array<{ type: string; status: string }>) {
      expect(t.type).toBe('routine')
      expect(t.status).toBe('idle')
    }
    // The developmental task must not appear
    const names = (res.body.tasks as Array<{ name: string }>).map(t => t.name)
    expect(names).not.toContain('Combined Filter Dev')
  })

  it('returns an empty list when no tasks match both type and status', async () => {
    // No tasks start as 'succeeded'; combining with type=daily should yield 0.
    const res = await request.get('/api/tasks?type=daily&status=succeeded').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.tasks).toHaveLength(0)
    expect(res.body.count).toBe(0)
  })
})

// ── DELETE /api/tasks/:id – response body ────────────────────────

describe('DELETE /api/tasks/:id – response body shape', () => {
  it('response includes id and message fields', async () => {
    const created = await request
      .post('/api/tasks')
      .set(auth())
      .send({ name: 'Delete Shape Test', type: 'routine' })
    const id = created.body.id as string

    const res = await request.delete(`/api/tasks/${id}`).set(auth())
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
    expect(typeof res.body.message).toBe('string')
    expect(res.body.message.length).toBeGreaterThan(0)
  })
})
