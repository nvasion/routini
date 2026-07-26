import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { app } from '../app.js'

// Covers the type-specific field validation added to PUT /api/tasks/:id —
// daily tasks (schedule/actionType/config) and developmental tasks
// (repoUrl/branch/agentId). Basic name/description update behavior and
// generic 404 handling are already covered by tests/tasks.test.ts; this file
// focuses on the newer validation rules so both suites stay independently
// readable.

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

async function createDaily(overrides: Record<string, unknown> = {}) {
  const res = await request
    .post('/api/tasks')
    .set(auth())
    .send({
      name: 'Daily Task',
      type: 'daily',
      schedule: '0 9 * * *',
      actionType: 'http',
      config: { url: 'https://example.com' },
      ...overrides,
    })
  return res.body.id as string
}

async function createDev(overrides: Record<string, unknown> = {}) {
  const res = await request
    .post('/api/tasks')
    .set(auth())
    .send({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      branch: 'main',
      agentId: 'claude',
      ...overrides,
    })
  return res.body.id as string
}

describe('PUT /api/tasks/:id — daily task fields', () => {
  it('updates schedule, actionType, and config together', async () => {
    const id = await createDaily()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ schedule: '0 12 * * *', actionType: 'ssh', config: { host: 'example.com' } })

    expect(res.status).toBe(200)
    expect(res.body.schedule).toBe('0 12 * * *')
    expect(res.body.actionType).toBe('ssh')
    expect(res.body.config).toEqual({ host: 'example.com' })
  })

  it('leaves schedule/actionType/config unchanged when omitted', async () => {
    const id = await createDaily({ schedule: '0 9 * * *', actionType: 'http' })

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ name: 'Renamed' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed')
    expect(res.body.schedule).toBe('0 9 * * *')
    expect(res.body.actionType).toBe('http')
  })

  it('rejects a blank schedule', async () => {
    const id = await createDaily()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ schedule: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/schedule/i)
  })

  it('rejects a non-string schedule', async () => {
    const id = await createDaily()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ schedule: 42 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/schedule/i)
  })

  it('rejects an unsupported actionType', async () => {
    const id = await createDaily()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ actionType: 'carrier-pigeon' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/actionType/i)
  })

  it('rejects a config value that is not a string', async () => {
    const id = await createDaily()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ config: { url: 'https://example.com', retries: 3 } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/config/i)
  })

  it('rejects a config value that is an array instead of an object', async () => {
    const id = await createDaily()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ config: ['not', 'an', 'object'] })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/config/i)
  })

  it('ignores developmental-only fields sent for a daily task', async () => {
    const id = await createDaily()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ repoUrl: 'https://github.com/example/repo' })

    expect(res.status).toBe(200)
    expect(res.body.repoUrl).toBeUndefined()
  })
})

describe('PUT /api/tasks/:id — developmental task fields', () => {
  it('updates repoUrl, branch, and agentId together', async () => {
    const id = await createDev()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({
        repoUrl: 'https://gitlab.com/example/other-repo',
        branch: 'feature/x',
        agentId: 'opencode',
      })

    expect(res.status).toBe(200)
    expect(res.body.repoUrl).toBe('https://gitlab.com/example/other-repo')
    expect(res.body.branch).toBe('feature/x')
    expect(res.body.agentId).toBe('opencode')
  })

  it('leaves repoUrl/branch/agentId unchanged when omitted', async () => {
    const id = await createDev({ branch: 'main', agentId: 'claude' })

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ name: 'Renamed Dev Task' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed Dev Task')
    expect(res.body.branch).toBe('main')
    expect(res.body.agentId).toBe('claude')
  })

  it('rejects a repoUrl that is not https (SSRF-unsafe scheme)', async () => {
    const id = await createDev()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ repoUrl: 'http://github.com/example/repo' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/https/i)
  })

  it('rejects a repoUrl on a host that is not an allowed git host', async () => {
    const id = await createDev()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ repoUrl: 'https://evil.internal/repo' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('rejects a repoUrl containing embedded credentials', async () => {
    const id = await createDev()

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ repoUrl: 'https://user:pass@github.com/example/repo' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/credentials/i)
  })

  it('rejects a blank branch', async () => {
    const id = await createDev()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ branch: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/branch/i)
  })

  it('rejects an unsupported agentId', async () => {
    const id = await createDev()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ agentId: 'skynet' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/agentId/i)
  })

  it('ignores daily-only fields sent for a developmental task', async () => {
    const id = await createDev()

    const res = await request.put(`/api/tasks/${id}`).set(auth()).send({ schedule: '0 9 * * *' })

    expect(res.status).toBe(200)
    expect(res.body.schedule).toBeUndefined()
  })
})

describe('PUT /api/tasks/:id — routine tasks', () => {
  it('updates name/description but ignores type-specific fields from other task types', async () => {
    const created = await request.post('/api/tasks').set(auth()).send({ name: 'A Routine', type: 'routine' })
    const id = created.body.id as string

    const res = await request
      .put(`/api/tasks/${id}`)
      .set(auth())
      .send({ description: 'Updated description', repoUrl: 'https://github.com/example/repo' })

    expect(res.status).toBe(200)
    expect(res.body.description).toBe('Updated description')
    expect(res.body.repoUrl).toBeUndefined()
  })
})
