import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { app } from '../app.js'

// ── Tests for PUT /api/tasks/:id type-specific validation ────────────────────
//
// Covers the daily (schedule/actionType/config) and developmental
// (repoUrl/branch/agentId) field validation added to the PUT handler, plus
// the write-only guarantee on DailyTask.config in the PUT response.

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

async function createTask(body: Record<string, unknown>) {
  const res = await request.post('/api/tasks').set(auth()).send(body)
  expect(res.status).toBe(201)
  return res.body as { id: string }
}

// ── Daily task validation ─────────────────────────────────────────────────────

describe('PUT /api/tasks/:id — daily task validation', () => {
  it('updates schedule, actionType, and config together', async () => {
    const created = await createTask({
      name: 'Health Check',
      type: 'daily',
      schedule: '0 9 * * *',
      actionType: 'http',
      config: { url: 'https://example.com/health' },
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({
        schedule: '0 10 * * *',
        actionType: 'ssh',
        config: { host: 'example.com', username: 'deploy', command: 'uptime' },
      })

    expect(res.status).toBe(200)
    expect(res.body.schedule).toBe('0 10 * * *')
    expect(res.body.actionType).toBe('ssh')
  })

  it('rejects an unknown actionType with 400', async () => {
    const created = await createTask({ name: 'HC', type: 'daily', actionType: 'http' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ actionType: 'ftp' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/actionType/i)
  })

  it('rejects an empty schedule string with 400', async () => {
    const created = await createTask({ name: 'HC', type: 'daily', actionType: 'http' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ schedule: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/schedule/i)
  })

  it('rejects a config key that is not valid for the actionType', async () => {
    const created = await createTask({
      name: 'HC',
      type: 'daily',
      actionType: 'http',
      config: { url: 'https://example.com' },
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ config: { url: 'https://example.com', host: 'not-allowed-for-http' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid config key/i)
    expect(res.body.error).toMatch(/host/)
  })

  it('validates config keys against a newly-supplied actionType in the same request', async () => {
    const created = await createTask({
      name: 'HC',
      type: 'daily',
      actionType: 'http',
      config: { url: 'https://example.com' },
    })

    // Switching actionType to "ssh" in the same request means the config must
    // satisfy the ssh key set, not the previous http key set.
    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ actionType: 'ssh', config: { url: 'https://example.com' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid config key/i)
  })

  it('rejects a non-object config with 400', async () => {
    const created = await createTask({ name: 'HC', type: 'daily', actionType: 'http' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ config: 'not-an-object' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/config must be an object/i)
  })

  it('rejects config with non-string values', async () => {
    const created = await createTask({ name: 'HC', type: 'daily', actionType: 'http' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ config: { url: 'https://example.com', timeout: 5000 } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must be strings/i)
    expect(res.body.error).toMatch(/timeout/)
  })

  it('rejects developmental-only fields on a daily task', async () => {
    const created = await createTask({ name: 'HC', type: 'daily', actionType: 'http' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ repoUrl: 'https://github.com/example/repo' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not valid for a daily task/i)
    expect(res.body.error).toMatch(/repoUrl/)
  })

  it('never echoes back config values — only key presence — in the response', async () => {
    const created = await createTask({
      name: 'HC',
      type: 'daily',
      actionType: 'ssh',
      config: { host: 'old-host.example.com', username: 'olduser', command: 'echo old' },
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ config: { host: 'secret-internal-host.example.com', username: 'admin', command: 'whoami' } })

    expect(res.status).toBe(200)
    expect(res.body.config).toEqual({ host: true, username: true, command: true })
    // The raw values must never appear anywhere in the serialized response.
    const raw = JSON.stringify(res.body)
    expect(raw).not.toMatch(/secret-internal-host/)
    expect(raw).not.toMatch(/whoami/)
  })
})

// ── Developmental task validation ─────────────────────────────────────────────

describe('PUT /api/tasks/:id — developmental task validation', () => {
  it('updates repoUrl, branch, and agentId together', async () => {
    const created = await createTask({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      branch: 'main',
      agentId: 'claude',
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({
        repoUrl: 'https://github.com/example/other-repo',
        branch: 'feature/x',
        agentId: 'opencode',
      })

    expect(res.status).toBe(200)
    expect(res.body.repoUrl).toBe('https://github.com/example/other-repo')
    expect(res.body.branch).toBe('feature/x')
    expect(res.body.agentId).toBe('opencode')
  })

  it('rejects a repoUrl on a disallowed host with 400', async () => {
    const created = await createTask({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      agentId: 'claude',
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ repoUrl: 'https://internal.local/secret-repo' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/repoUrl/i)
  })

  it('rejects an unsupported agentId with 400', async () => {
    const created = await createTask({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      agentId: 'claude',
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ agentId: 'not-a-real-agent' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/agentId/i)
  })

  it('rejects an empty branch with 400', async () => {
    const created = await createTask({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      agentId: 'claude',
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ branch: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/branch/i)
  })

  it('rejects daily-only fields on a developmental task', async () => {
    const created = await createTask({
      name: 'Dev Task',
      type: 'developmental',
      repoUrl: 'https://github.com/example/repo',
      agentId: 'claude',
    })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ schedule: '0 9 * * *' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not valid for a developmental task/i)
    expect(res.body.error).toMatch(/schedule/)
  })
})

// ── Routine task validation ───────────────────────────────────────────────────

describe('PUT /api/tasks/:id — routine task field guards', () => {
  it('rejects daily/developmental-only fields on a routine task', async () => {
    const created = await createTask({ name: 'Routine', type: 'routine' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ agentId: 'claude' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not valid for a routine task/i)
  })

  it('still allows plain name/description updates on a routine task', async () => {
    const created = await createTask({ name: 'Routine', type: 'routine' })

    const res = await request
      .put(`/api/tasks/${created.id}`)
      .set(auth())
      .send({ name: 'Renamed Routine' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed Routine')
  })
})
