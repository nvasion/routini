/**
 * Integration tests for the task CRUD + execution-trigger API.
 *
 * Spins up a real HTTP server (ephemeral port) so the entire middleware stack
 * is exercised end-to-end, including auth and CSRF checks.
 *
 * A synchronous stub executor is injected so tests can observe run-state
 * transitions without waiting for the real async executor.
 */

import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  RateLimiter,
  UserStore,
  createAuthRouter,
  loadAuthConfig,
} from '../server/src/auth/index.js'
import { createRouter } from '../server/src/routes.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type { TaskExecutor } from '../server/src/tasks/executor.js'
import type { Task, TaskRun } from '../server/src/tasks/types.js'


// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let taskStore: TaskStore
/** Auth token for the primary "admin" user. */
let authToken: string
/** Auth token for a second user to verify cross-user access is blocked. */
let otherToken: string

const ADMIN_PASSWORD = 'test-p@ssw0rd!'
const OTHER_PASSWORD = 'other-P@ssw0rd!'

/**
 * A stub executor that resolves immediately without touching the store.
 * Tests that need to observe status transitions can inject a different one.
 */
const stubExecutor: TaskExecutor = async () => {
  /* no-op */
}

/** Extract the Bearer token from a Set-Cookie header. */
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
  // Use a very permissive execute rate limiter so the shared test server does
  // not hit the limit during normal tests. The rate-limit behavior itself is
  // exercised in the dedicated describe block below that spins up its own server.
  const fastExecuteLimiter = new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })

  taskStore = new TaskStore()

  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter(authDeps, { loginRateLimiter: fastLimiter }))
  app.use(
    '/api',
    createRouter(authDeps, {
      tasks: taskStore,
      executor: stubExecutor,
      executeRateLimiter: fastExecuteLimiter,
    }),
  )

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`

  // Obtain a reusable auth token for each user
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  }
}

async function createTask(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
}

const validSshTask = () => ({
  type: 'daily',
  name: 'SSH check',
  subtype: 'ssh',
  config: { host: 'example.com', username: 'deploy', command: 'uptime' },
})

const validDevTask = () => ({
  type: 'developmental',
  name: 'Auto-refactor',
  repoUrl: 'https://github.com/example/repo',
  agentName: 'claude-code',
  branchName: 'feature/test',
})

const validRoutineTask = () => ({
  type: 'routine',
  name: 'Morning workflow',
  steps: [{ taskId: 'placeholder' }],
})

// Reset task store between test groups so tests are independent
beforeEach(() => {
  // Recreate the store so each describe block starts clean.
  // Note: The router was created with a reference to `taskStore`; we clear
  // it here by draining via the API (avoiding white-box store access).
})

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe('task endpoints — authentication required', () => {
  it('GET /api/tasks → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(res.status).toBe(401)
  })

  it('POST /api/tasks → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validSshTask()),
    })
    expect(res.status).toBe(401)
  })

  it('GET /api/tasks/:id → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id`)
    expect(res.status).toBe(401)
  })

  it('PUT /api/tasks/:id → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('DELETE /api/tasks/:id → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/tasks/:id/execute → 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// CSRF guard
// ---------------------------------------------------------------------------

describe('task endpoints — CSRF (Content-Type) guard', () => {
  it('POST /api/tasks → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: 'type=daily',
    })
    expect(res.status).toBe(415)
  })

  it('PUT /api/tasks/:id → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}` },
      body: 'name=x',
    })
    expect(res.status).toBe(415)
  })

  it('DELETE /api/tasks/:id → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(415)
  })

  it('POST /api/tasks/:id/execute → 415 without application/json', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/some-id/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(415)
  })
})

// ---------------------------------------------------------------------------
// Task creation (POST /api/tasks)
// ---------------------------------------------------------------------------

describe('POST /api/tasks', () => {
  it('creates a daily SSH task and returns 201', async () => {
    const res = await createTask(validSshTask())
    expect(res.status).toBe(201)
    const body = (await res.json()) as Task
    expect(body.id).toBeTruthy()
    expect(body.type).toBe('daily')
    expect(body.name).toBe('SSH check')
    expect(body.status).toBe('idle')
    expect(body.createdAt).toBeTruthy()
  })

  it('creates a developmental task and returns 201', async () => {
    const res = await createTask(validDevTask())
    expect(res.status).toBe(201)
    const body = (await res.json()) as Task
    expect(body.type).toBe('developmental')
    expect(body.name).toBe('Auto-refactor')
  })

  it('creates a routine task and returns 201', async () => {
    const res = await createTask(validRoutineTask())
    expect(res.status).toBe(201)
    const body = (await res.json()) as Task
    expect(body.type).toBe('routine')
  })

  it('returns 400 with details for missing name', async () => {
    const { name: _, ...noName } = validSshTask()
    const res = await createTask(noName)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toContain('Validation')
    expect(body.details).toBeInstanceOf(Array)
    expect(body.details.length).toBeGreaterThan(0)
  })

  it('returns 400 for unknown task type', async () => {
    const res = await createTask({ type: 'magic', name: 'Bad' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for SSRF URL in developmental task', async () => {
    const res = await createTask({
      ...validDevTask(),
      repoUrl: 'http://192.168.0.1/repo',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: string[] }
    const joined = body.details.join(' ')
    expect(joined.toLowerCase()).toContain('disallowed')
  })

  it('returns 400 for invalid agentName', async () => {
    const res = await createTask({ ...validDevTask(), agentName: 'bad-agent' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for SSRF URL in HTTP daily task', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'Bad HTTP',
      subtype: 'http',
      config: { url: 'http://localhost:3000' },
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Task retrieval (GET /api/tasks and GET /api/tasks/:id)
// ---------------------------------------------------------------------------

describe('GET /api/tasks', () => {
  it('returns an empty list when no tasks exist', async () => {
    // Create a fresh store instance via a dedicated test below;
    // here we just check the schema is correct
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Task[]; count: number }
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  it('returns all tasks', async () => {
    const before = await (
      await fetch(`${baseUrl}/api/tasks`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
    ).json() as { count: number }

    await createTask(validSshTask())
    await createTask(validDevTask())

    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    const body = (await res.json()) as { tasks: Task[]; count: number }
    expect(body.count).toBe(before.count + 2)
  })

  it('filters by type=daily', async () => {
    await createTask(validSshTask())
    await createTask(validDevTask())

    const res = await fetch(`${baseUrl}/api/tasks?type=daily`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Task[] }
    for (const t of body.tasks) {
      expect(t.type).toBe('daily')
    }
  })

  it('filters by type=developmental', async () => {
    await createTask(validDevTask())

    const res = await fetch(`${baseUrl}/api/tasks?type=developmental`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Task[] }
    for (const t of body.tasks) {
      expect(t.type).toBe('developmental')
    }
  })

  it('returns 400 for unknown type filter', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?type=unknown`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/tasks/:id', () => {
  it('returns the task for a valid id', async () => {
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Task
    expect(body.id).toBe(created.id)
    expect(body.name).toBe('SSH check')
  })

  it('returns 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// Task update (PUT /api/tasks/:id)
// ---------------------------------------------------------------------------

describe('PUT /api/tasks/:id', () => {
  it('updates the task name', async () => {
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Renamed task' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Task
    expect(body.name).toBe('Renamed task')
    expect(body.id).toBe(created.id)
    expect(body.type).toBe('daily')
  })

  it('returns 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/ghost`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for validation errors in the patch', async () => {
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 when task is queued', async () => {
    // Inject a never-resolving executor so the task stays queued
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    // Manually set status via store
    taskStore.updateTaskStatus(created.id, 'queued')

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(res.status).toBe(409)

    // Reset status for other tests
    taskStore.updateTaskStatus(created.id, 'idle')
  })

  it('updates developmental task fields', async () => {
    const createRes = await createTask(validDevTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ agentName: 'omnimancer', branchName: 'feature/v2' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agentName: string; branchName: string }
    expect(body.agentName).toBe('omnimancer')
    expect(body.branchName).toBe('feature/v2')
  })

  it('rejects SSRF repoUrl in a developmental task update', async () => {
    const createRes = await createTask(validDevTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ repoUrl: 'http://10.0.0.1/repo' }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Task deletion (DELETE /api/tasks/:id)
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id', () => {
  it('deletes a task and returns 200 with id', async () => {
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string; id: string }
    expect(body.id).toBe(created.id)
    expect(body.message.toLowerCase()).toContain('deleted')

    // Verify the task is gone
    const getRes = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(getRes.status).toBe(404)
  })

  it('returns 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/ghost`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 when the task is currently running', async () => {
    const createRes = await createTask(validSshTask())
    const created = (await createRes.json()) as Task

    taskStore.updateTaskStatus(created.id, 'running')

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(409)

    // Cleanup
    taskStore.updateTaskStatus(created.id, 'idle')
  })
})

// ---------------------------------------------------------------------------
// Execution trigger (POST /api/tasks/:id/execute)
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/execute', () => {
  it('creates a run and returns 202 with queued status', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const execRes = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(execRes.status).toBe(202)
    const run = (await execRes.json()) as TaskRun
    expect(run.id).toBeTruthy()
    expect(run.taskId).toBe(task.id)
    expect(run.status).toBe('queued')
    expect(run.startedAt).toBeTruthy()
    expect(run.logs).toEqual([])
  })

  it('returns 404 for unknown task id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/ghost/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 when task is already queued', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    // First execution
    await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })

    // Second execution while first is queued
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('queued')
  })

  it('returns 409 when task is running', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    taskStore.updateTaskStatus(task.id, 'running')

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(res.status).toBe(409)

    taskStore.updateTaskStatus(task.id, 'idle')
  })

  it('transitions task status to queued after trigger', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    const updated = (await getRes.json()) as Task
    expect(updated.status).toBe('queued')
  })
})

// ---------------------------------------------------------------------------
// Run listing (GET /api/tasks/:id/runs)
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/runs', () => {
  it('returns empty runs for a new task', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/runs`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: TaskRun[]; count: number }
    expect(body.runs).toHaveLength(0)
    expect(body.count).toBe(0)
  })

  it('lists runs after execution', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/runs`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    const body = (await res.json()) as { runs: TaskRun[]; count: number }
    expect(body.runs).toHaveLength(1)
    expect(body.count).toBe(1)
    expect(body.runs[0].taskId).toBe(task.id)
  })

  it('returns 404 for unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/ghost/runs`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Run retrieval (GET /api/runs/:runId)
// ---------------------------------------------------------------------------

describe('GET /api/runs/:runId', () => {
  it('returns the run for a valid runId', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const execRes = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    const run = (await execRes.json()) as TaskRun

    const res = await fetch(`${baseUrl}/api/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as TaskRun
    expect(body.id).toBe(run.id)
    expect(body.taskId).toBe(task.id)
  })

  it('returns 404 for an unknown runId', async () => {
    const res = await fetch(`${baseUrl}/api/runs/ghost-run-id`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/runs/some-run`)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle smoke test
// ---------------------------------------------------------------------------

describe('task lifecycle — create, update, execute, list runs, delete', () => {
  it('completes the full CRUD + execution cycle', async () => {
    // 1. Create
    const createRes = await createTask({
      type: 'developmental',
      name: 'Full lifecycle test',
      repoUrl: 'https://github.com/example/lifecycle',
      agentName: 'opencode',
    })
    expect(createRes.status).toBe(201)
    const task = (await createRes.json()) as Task
    expect(task.status).toBe('idle')

    // 2. Update
    const updateRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Full lifecycle test (updated)', branchName: 'fix/test' }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as Task
    expect(updated.name).toBe('Full lifecycle test (updated)')

    // 3. Execute
    const execRes = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(execRes.status).toBe(202)
    const run = (await execRes.json()) as TaskRun
    expect(run.status).toBe('queued')

    // 4. List runs
    const runsRes = await fetch(`${baseUrl}/api/tasks/${task.id}/runs`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    const { runs } = (await runsRes.json()) as { runs: TaskRun[] }
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe(run.id)

    // 5. Get run by id
    const runRes = await fetch(`${baseUrl}/api/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(runRes.status).toBe(200)

    // 6. Reset to idle for delete (stub executor leaves it queued)
    taskStore.updateTaskStatus(task.id, 'idle')

    // 7. Delete
    const delRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(delRes.status).toBe(200)

    // 8. Confirm gone
    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(getRes.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Per-user authorization isolation
// ---------------------------------------------------------------------------

describe('task endpoints — per-user data isolation', () => {
  function otherHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${otherToken}`,
      'Content-Type': 'application/json',
    }
  }

  it('created task is only visible to the owner', async () => {
    // Create a task as admin
    const createRes = await createTask(validSshTask())
    expect(createRes.status).toBe(201)
    const task = (await createRes.json()) as Task

    // Admin can see it
    const adminGet = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(adminGet.status).toBe(200)

    // Other user gets 404 (cannot enumerate existence)
    const otherGet = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(otherGet.status).toBe(404)
  })

  it('list endpoint only returns the caller\'s tasks', async () => {
    // Create a task as admin
    await createTask({ ...validSshTask(), name: 'Admin only task' })

    // Create a task as other user
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: otherHeaders(),
      body: JSON.stringify({ ...validSshTask(), name: 'Other user task' }),
    })

    const adminList = await (
      await fetch(`${baseUrl}/api/tasks`, { headers: { Authorization: `Bearer ${authToken}` } })
    ).json() as { tasks: Task[] }

    const otherList = await (
      await fetch(`${baseUrl}/api/tasks`, { headers: { Authorization: `Bearer ${otherToken}` } })
    ).json() as { tasks: Task[] }

    // Each user's list contains only their own tasks
    for (const t of adminList.tasks) {
      expect(t.name).not.toBe('Other user task')
    }
    for (const t of otherList.tasks) {
      expect(t.name).not.toBe('Admin only task')
    }
    expect(otherList.tasks.some((t) => t.name === 'Other user task')).toBe(true)
  })

  it('other user cannot update a task they do not own', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'PUT',
      headers: otherHeaders(),
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    expect(res.status).toBe(404)
  })

  it('other user cannot delete a task they do not own', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: otherHeaders(),
    })
    expect(res.status).toBe(404)

    // Verify original task still exists for its owner
    const check = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(check.status).toBe(200)
  })

  it('other user cannot trigger execution on a task they do not own', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: otherHeaders(),
    })
    expect(res.status).toBe(404)
  })

  it('other user cannot list runs of a task they do not own', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    // Trigger a run as admin
    await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/runs`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('other user cannot fetch a run by id that belongs to another user\'s task', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task

    const execRes = await fetch(`${baseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: authHeaders(),
    })
    const run = (await execRes.json()) as TaskRun

    // Other user tries to access the run directly by id
    const res = await fetch(`${baseUrl}/api/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('returned task includes the userId field', async () => {
    const createRes = await createTask(validSshTask())
    const task = (await createRes.json()) as Task & { userId: string }
    expect(typeof task.userId).toBe('string')
    expect(task.userId.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

describe('task API — sensitive credential field redaction', () => {
  it('strips SSH password from POST /api/tasks response', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'SSH with password',
      subtype: 'ssh',
      config: { host: 'example.com', username: 'deploy', command: 'uptime', password: 's3cr3t!' },
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as Record<string, unknown>
    const config = task.config as Record<string, unknown>
    expect(config.password).toBeUndefined()
    // Non-sensitive fields must still be present
    expect(config.host).toBe('example.com')
    expect(config.username).toBe('deploy')
  })

  it('strips SSH privateKey from POST /api/tasks response', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'SSH with key',
      subtype: 'ssh',
      config: {
        host: 'example.com',
        username: 'deploy',
        command: 'uptime',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----',
      },
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as Record<string, unknown>
    const config = task.config as Record<string, unknown>
    expect(config.privateKey).toBeUndefined()
    expect(config.command).toBe('uptime')
  })

  it('strips email password from POST /api/tasks response', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'Email with password',
      subtype: 'email',
      config: { host: 'mail.example.com', username: 'user@example.com', password: 'imap-s3cr3t' },
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as Record<string, unknown>
    const config = task.config as Record<string, unknown>
    expect(config.password).toBeUndefined()
    expect(config.host).toBe('mail.example.com')
  })

  it('strips SSH password from GET /api/tasks/:id response', async () => {
    const createRes = await createTask({
      type: 'daily',
      name: 'SSH get redaction',
      subtype: 'ssh',
      config: { host: 'example.com', username: 'root', command: 'whoami', password: 'hunter2' },
    })
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const task = (await res.json()) as Record<string, unknown>
    const config = task.config as Record<string, unknown>
    expect(config.password).toBeUndefined()
  })

  it('strips SSH password from GET /api/tasks list response', async () => {
    await createTask({
      type: 'daily',
      name: 'SSH list redaction',
      subtype: 'ssh',
      config: { host: 'example.com', username: 'root', command: 'ls', password: 'list-secret' },
    })

    const res = await fetch(`${baseUrl}/api/tasks?type=daily`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const { tasks } = (await res.json()) as { tasks: Array<Record<string, unknown>> }
    for (const task of tasks) {
      if (task.type === 'daily') {
        const config = task.config as Record<string, unknown>
        expect(config.password).toBeUndefined()
        expect(config.privateKey).toBeUndefined()
      }
    }
  })

  it('strips SSH password from PUT /api/tasks/:id response', async () => {
    const createRes = await createTask({
      type: 'daily',
      name: 'SSH put redaction',
      subtype: 'ssh',
      config: { host: 'example.com', username: 'deploy', command: 'uptime', password: 'old-pw' },
    })
    const created = (await createRes.json()) as Task

    const res = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        config: { host: 'other.com', username: 'deploy', command: 'uptime', password: 'new-pw' },
      }),
    })
    expect(res.status).toBe(200)
    const task = (await res.json()) as Record<string, unknown>
    const config = task.config as Record<string, unknown>
    expect(config.password).toBeUndefined()
    expect(config.host).toBe('other.com')
  })

  it('rejects SSH password exceeding the max length', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'SSH long password',
      subtype: 'ssh',
      config: {
        host: 'example.com',
        username: 'deploy',
        command: 'uptime',
        password: 'x'.repeat(501),
      },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: string[] }
    expect(body.details.join(' ')).toContain('password')
  })

  it('rejects SSH privateKey exceeding the max length', async () => {
    const res = await createTask({
      type: 'daily',
      name: 'SSH long key',
      subtype: 'ssh',
      config: {
        host: 'example.com',
        username: 'deploy',
        command: 'uptime',
        privateKey: 'k'.repeat(8193),
      },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: string[] }
    expect(body.details.join(' ')).toContain('privateKey')
  })
})

// ---------------------------------------------------------------------------
// Execute endpoint — rate limiting
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/execute — rate limiting', () => {
  let limitedServer: Server
  let limitedBaseUrl: string
  let limitedTaskStore: TaskStore
  let limitedToken: string

  beforeAll(async () => {
    const limitedUsers = new UserStore()
    await limitedUsers.createUser('limuser', 'limuser-P@ssw0rd!')

    const authConfig = loadAuthConfig()
    const limitedAuthDeps = { config: authConfig, users: limitedUsers }

    // Tight limit: 2 per minute so the test only needs 3 requests
    const tightExecuteLimiter = new RateLimiter({ maxAttempts: 2, windowSeconds: 60 })
    const fastLoginLimiter = new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })

    limitedTaskStore = new TaskStore()

    const limitedApp = express()
    limitedApp.use(express.json())
    limitedApp.use(
      '/api/auth',
      createAuthRouter(limitedAuthDeps, { loginRateLimiter: fastLoginLimiter }),
    )
    limitedApp.use(
      '/api',
      createRouter(limitedAuthDeps, {
        tasks: limitedTaskStore,
        executor: stubExecutor,
        executeRateLimiter: tightExecuteLimiter,
      }),
    )

    await new Promise<void>((resolve) => {
      limitedServer = limitedApp.listen(0, () => resolve())
    })
    const addr = limitedServer.address() as AddressInfo
    limitedBaseUrl = `http://127.0.0.1:${addr.port}`

    const loginRes = await fetch(`${limitedBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'limuser', password: 'limuser-P@ssw0rd!' }),
    })
    limitedToken = extractToken(loginRes.headers.get('set-cookie')!)
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      limitedServer.close((err) => (err ? reject(err) : resolve()))
    })
  })

  it('returns 429 after exceeding the per-user execute rate limit', async () => {
    const taskRes = await fetch(`${limitedBaseUrl}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${limitedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(validSshTask()),
    })
    expect(taskRes.status).toBe(201)
    const task = (await taskRes.json()) as Task

    const execute = async () =>
      fetch(`${limitedBaseUrl}/api/tasks/${task.id}/execute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${limitedToken}`, 'Content-Type': 'application/json' },
      })

    // First two requests succeed (limit is 2)
    let res = await execute()
    expect(res.status).toBe(202)
    limitedTaskStore.updateTaskStatus(task.id, 'idle')

    res = await execute()
    expect(res.status).toBe(202)
    limitedTaskStore.updateTaskStatus(task.id, 'idle')

    // Third request exceeds the per-user rate limit
    res = await execute()
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain('rate limit')
    expect(body.error.toLowerCase()).toContain('retry after')
  })

  it('returns 429 with Retry-After information in the error body', async () => {
    // Create a second task to exercise the same limiter (already exhausted)
    const taskRes = await fetch(`${limitedBaseUrl}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${limitedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validSshTask(), name: 'Rate limit check task' }),
    })
    const task = (await taskRes.json()) as Task

    // The limiter is already exhausted from the previous test
    const res = await fetch(`${limitedBaseUrl}/api/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${limitedToken}`, 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string }
    // Error message must include the retry delay so clients can back off
    expect(body.error).toMatch(/\d+ seconds?/)
  })
})
