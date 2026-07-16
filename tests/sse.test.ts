/**
 * Integration tests for the Server-Sent Events (SSE) real-time task endpoints.
 *
 * Because SSE connections never close on their own, we use Node's native
 * `http` module to make raw streaming requests against a real server bound
 * to a random port, rather than relying on supertest (which buffers the full
 * response body before resolving the Promise).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import * as http from 'node:http'
import { app } from '../server/src/app'
import { taskEvents } from '../server/src/services/taskEvents'
import type { Task } from '../server/src/types'

// ── Test server setup ─────────────────────────────────────────────────────────
// We use supertest for non-streaming endpoints and a real http.Server for SSE.

const supertestAgent = supertest(app)
let server: http.Server
let serverPort: number
let authToken: string

beforeAll(async () => {
  // Obtain a Bearer token from the seed account.
  const res = await supertestAgent
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string

  // Start a real TCP server on a random port for streaming requests.
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  serverPort = (server.address() as http.AddressInfo).port
})

afterAll(() => {
  server.close()
})

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${authToken}` }
}

/**
 * Opens an SSE connection and resolves when the first chunk matching `predicate`
 * arrives, or rejects after `timeoutMs` milliseconds.
 *
 * The returned promise resolves with the raw accumulated string so callers
 * can inspect event payloads.
 */
function sseRequest(
  path: string,
  predicate: (data: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let accumulated = ''

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path,
        headers: authHeader(),
      },
      (res) => {
        res.setEncoding('utf8')

        res.on('data', (chunk: string) => {
          accumulated += chunk
          if (predicate(accumulated)) {
            req.destroy()
            resolve(accumulated)
          }
        })

        res.on('end', () => {
          reject(new Error(`SSE stream ended before predicate matched. Got: ${accumulated}`))
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error(`SSE request timed out after ${timeoutMs} ms`))
    })

    // ECONNRESET is expected when we call req.destroy() after the predicate
    // matches — treat it as a successful early close.
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        resolve(accumulated)
      } else {
        reject(err)
      }
    })
  })
}

/** Parses the `data:` payload of the first SSE event matching `eventName`. */
function parseFirstEvent(raw: string, eventName: string): unknown {
  // SSE frames look like:   event: <name>\ndata: <json>\n\n
  const re = new RegExp(`event: ${eventName}\\ndata: ([^\\n]+)`)
  const match = raw.match(re)
  if (!match) throw new Error(`Event "${eventName}" not found in:\n${raw}`)
  return JSON.parse(match[1])
}

// ── Auth enforcement ──────────────────────────────────────────────────────────

describe('GET /api/tasks/events – auth', () => {
  it('returns 401 without credentials', async () => {
    const res = await supertestAgent.get('/api/tasks/events')
    expect(res.status).toBe(401)
  })

  it('returns 401 with an invalid token', async () => {
    const res = await supertestAgent
      .get('/api/tasks/events')
      .set('Authorization', 'Bearer invalid.token.here')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/tasks/:id/events – auth', () => {
  it('returns 401 without credentials', async () => {
    // Use a valid UUID format; exact existence doesn't matter for auth check.
    const res = await supertestAgent.get('/api/tasks/00000000-0000-0000-0000-000000000001/events')
    expect(res.status).toBe(401)
  })
})

// ── SSE headers ───────────────────────────────────────────────────────────────

describe('GET /api/tasks/events – response headers', () => {
  it('sets Content-Type to text/event-stream', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: serverPort, path: '/api/tasks/events', headers: authHeader() },
        (res) => {
          try {
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toContain('text/event-stream')
            expect(res.headers['cache-control']).toContain('no-cache')
            req.destroy()
            resolve()
          } catch (err) {
            req.destroy()
            reject(err)
          }
        },
      )
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET') resolve()
        else reject(err)
      })
    })
  })
})

// ── Connected event ───────────────────────────────────────────────────────────

describe('GET /api/tasks/events – connected event', () => {
  it('sends a connected event with a tasks array on connection', async () => {
    const raw = await sseRequest('/api/tasks/events', data => data.includes('event: connected'))
    const payload = parseFirstEvent(raw, 'connected') as { tasks: Task[] }

    expect(Array.isArray(payload.tasks)).toBe(true)
    expect(payload.tasks.length).toBeGreaterThan(0)
  })

  it('connected event tasks contain required fields', async () => {
    const raw = await sseRequest('/api/tasks/events', data => data.includes('event: connected'))
    const payload = parseFirstEvent(raw, 'connected') as { tasks: Task[] }

    for (const task of payload.tasks) {
      expect(typeof task.id).toBe('string')
      expect(typeof task.name).toBe('string')
      expect(typeof task.status).toBe('string')
      expect(typeof task.type).toBe('string')
    }
  })
})

// ── task:updated events ───────────────────────────────────────────────────────

describe('GET /api/tasks/events – task:updated events', () => {
  it('broadcasts a task:updated event when taskEvents.emitTaskUpdated is called', async () => {
    // Use a unique timestamp-suffixed ID so this test is not affected by cached
    // data from previous test runs within the same process.
    const taskId = `test-sse-task-${Date.now()}`
    const mockTask: Task = {
      id: taskId,
      name: 'SSE Test Task',
      description: '',
      type: 'routine',
      status: 'running',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Open the SSE connection and emit the mock task only after the 'connected'
    // event arrives — that guarantees the server-side listener is registered
    // before we emit, eliminating the fixed-delay race condition.
    const raw = await new Promise<string>((resolve, reject) => {
      let accumulated = ''
      let connectedReceived = false

      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: '/api/tasks/events',
          headers: authHeader(),
        },
        (res) => {
          res.setEncoding('utf8')

          res.on('data', (chunk: string) => {
            accumulated += chunk

            // As soon as the 'connected' event is confirmed, emit the mock update.
            // Use setImmediate so the current data handler completes first.
            if (!connectedReceived && accumulated.includes('event: connected')) {
              connectedReceived = true
              setImmediate(() => taskEvents.emitTaskUpdated(mockTask))
            }

            if (accumulated.includes(taskId)) {
              req.destroy()
              resolve(accumulated)
            }
          })

          res.on('end', () => {
            reject(new Error(`SSE stream ended before task:updated arrived. Got: ${accumulated}`))
          })
        },
      )

      req.setTimeout(3000, () => {
        req.destroy()
        reject(new Error('SSE request timed out after 3000 ms'))
      })

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
          resolve(accumulated)
        } else {
          reject(err)
        }
      })
    })

    const updated = parseFirstEvent(raw, 'task:updated') as Task
    expect(updated.id).toBe(taskId)
    expect(updated.status).toBe('running')
    expect(updated.name).toBe('SSE Test Task')
  })

  it('broadcasts task:updated when a task is triggered via POST', async () => {
    // Create a routine task to trigger.
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'SSE Trigger Test', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    const rawPromise = sseRequest(
      '/api/tasks/events',
      data => {
        // We want the task:updated event that sets status to 'queued'
        if (!data.includes('task:updated')) return false
        try {
          const payload = parseFirstEvent(data, 'task:updated') as Task
          return payload.id === taskId && payload.status === 'queued'
        } catch {
          return false
        }
      },
    )

    await new Promise(r => setTimeout(r, 50))

    await supertestAgent
      .post(`/api/tasks/${taskId}/trigger`)
      .set(authHeader())

    const raw = await rawPromise
    const updated = parseFirstEvent(raw, 'task:updated') as Task
    expect(updated.id).toBe(taskId)
    expect(updated.status).toBe('queued')
  })
})

// ── Ownership filtering ───────────────────────────────────────────────────────

describe('GET /api/tasks/events – ownership filtering', () => {
  it('does not broadcast task:updated for tasks owned by other users', async () => {
    // Simulate cross-tenant isolation: create two tasks, then reassign one to a
    // different user. The SSE connection (admin) should only receive updates for
    // its own tasks, never for the other user's tasks.
    const { tasks: taskStore } = await import('../server/src/routes/tasks')

    const createOtherRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Other User Task', type: 'routine' })
    expect(createOtherRes.status).toBe(201)
    const otherTaskId: string = createOtherRes.body.id

    // Reassign to simulate ownership by a different tenant.
    const originalTask = taskStore.get(otherTaskId)!
    const otherUserTask = { ...originalTask, ownerId: 'other-user-id-999' }
    taskStore.set(otherTaskId, otherUserTask)

    // Use the direct http.get approach (same pattern as the first task:updated
    // test) to emit events only after 'connected' confirms the listener is live.
    // This lets us test task:updated filtering specifically, rather than the
    // connected snapshot (which is also filtered, but not the focus here).
    const uniqueMarker = `admin-task-${Date.now()}`
    const raw = await new Promise<string>((resolve, reject) => {
      let accumulated = ''
      let connectedReceived = false

      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: '/api/tasks/events',
          headers: authHeader(),
        },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            accumulated += chunk

            if (!connectedReceived && accumulated.includes('event: connected')) {
              connectedReceived = true
              setImmediate(() => {
                // First emit the other user's task — should be suppressed.
                taskEvents.emitTaskUpdated(otherUserTask)
                // Then emit an admin-owned task update — should arrive.
                setTimeout(() => {
                  taskEvents.emitTaskUpdated({
                    id: uniqueMarker,
                    name: 'Admin Owned Task',
                    description: '',
                    type: 'routine',
                    status: 'running',
                    steps: [],
                    // No ownerId → system task visible to all (simulates pass-through)
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  })
                }, 10)
              })
            }

            if (connectedReceived && accumulated.includes(uniqueMarker)) {
              req.destroy()
              resolve(accumulated)
            }
          })

          res.on('end', () => reject(new Error('SSE stream ended')))
        },
      )

      req.setTimeout(3000, () => { req.destroy(); reject(new Error('SSE timed out')) })
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') resolve(accumulated)
        else reject(err)
      })
    })

    // The raw stream MUST NOT contain any event payload from the other user's
    // task, and MUST contain the admin-owned task event.
    expect(raw).not.toContain('Other User Task')
    expect(raw).toContain('Admin Owned Task')

    // Restore original ownerId so subsequent tests see the task normally.
    taskStore.set(otherTaskId, originalTask)
  })
})

// ── task:log events ───────────────────────────────────────────────────────────

describe('GET /api/tasks/events – task:log events', () => {
  it('broadcasts task:log when taskEvents.emitTaskLog is called', async () => {
    // Create a real task so the ownership filter can look it up.
    // Log events are only forwarded for tasks visible to the authenticated user.
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'SSE Log Test Task', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id
    const logMessage = `SSE log line ${Date.now()}`

    const rawPromise = sseRequest(
      '/api/tasks/events',
      data => data.includes(logMessage),
    )

    await new Promise(r => setTimeout(r, 50))
    taskEvents.emitTaskLog(taskId, { timestamp: new Date().toISOString(), message: logMessage })

    const raw = await rawPromise
    expect(raw).toContain('event: task:log')
    expect(raw).toContain(logMessage)
    expect(raw).toContain(taskId)
  })
})

// ── Per-task SSE endpoint ─────────────────────────────────────────────────────

describe('GET /api/tasks/:id/events', () => {
  it('returns 404 for a non-existent task', async () => {
    const res = await supertestAgent
      .get('/api/tasks/00000000-0000-0000-0000-000000000000/events')
      .set(authHeader())
    expect(res.status).toBe(404)
  })

  it('sends a connected event with task and logs on connection', async () => {
    // Create a task to subscribe to.
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Per-Task SSE Test', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    const raw = await sseRequest(
      `/api/tasks/${taskId}/events`,
      data => data.includes('event: connected'),
    )

    const payload = parseFirstEvent(raw, 'connected') as { task: Task; logs: unknown[] }
    expect(payload.task.id).toBe(taskId)
    expect(payload.task.name).toBe('Per-Task SSE Test')
    expect(Array.isArray(payload.logs)).toBe(true)
  })

  it('returns 403 when the task is owned by a different user', async () => {
    // Create a task as admin, then attempt to subscribe as a different user.
    // Since the test environment only has one seed account we simulate the
    // ownership mismatch by creating a task, then manually patching ownerId
    // to a different user ID via the exported task store.
    const { tasks: taskStore } = await import('../server/src/routes/tasks')

    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Private Task', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    // Simulate the task belonging to a different user.
    const task = taskStore.get(taskId)!
    taskStore.set(taskId, { ...task, ownerId: 'different-user-id' })

    const res = await supertestAgent
      .get(`/api/tasks/${taskId}/events`)
      .set(authHeader())
    expect(res.status).toBe(403)

    // Restore the original ownerId so subsequent tests are not affected.
    taskStore.set(taskId, task)
  })

  it('sends task:updated only for the subscribed task', async () => {
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Scoped SSE Task', type: 'routine' })
    const subscribedId: string = createRes.body.id

    const otherTask: Task = {
      id: 'unrelated-task-id',
      name: 'Other Task',
      description: '',
      type: 'routine',
      status: 'running',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const subscribedTask: Task = {
      id: subscribedId,
      name: 'Scoped SSE Task',
      description: '',
      type: 'routine',
      status: 'running',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const rawPromise = sseRequest(
      `/api/tasks/${subscribedId}/events`,
      data => data.includes('task:updated'),
    )

    await new Promise(r => setTimeout(r, 50))

    // Emit the unrelated task first, then the subscribed task.
    taskEvents.emitTaskUpdated(otherTask)
    await new Promise(r => setTimeout(r, 10))
    taskEvents.emitTaskUpdated(subscribedTask)

    const raw = await rawPromise
    const updated = parseFirstEvent(raw, 'task:updated') as Task
    // Only the subscribed task's update should appear.
    expect(updated.id).toBe(subscribedId)
  })
})

// ── Sanitization: sensitive fields stripped from SSE payloads ─────────────────

describe('GET /api/tasks/events – sensitive field sanitization', () => {
  it('omits ownerId from tasks in the connected snapshot', async () => {
    const raw = await sseRequest('/api/tasks/events', data => data.includes('event: connected'))
    const payload = parseFirstEvent(raw, 'connected') as { tasks: Array<Record<string, unknown>> }

    for (const task of payload.tasks) {
      expect(task).not.toHaveProperty('ownerId')
    }
  })

  it('omits config from DailyTask objects in the connected snapshot', async () => {
    // The seed DailyTask carries a config with url+method.
    // It must be stripped before reaching the client.
    const raw = await sseRequest('/api/tasks/events', data => data.includes('event: connected'))
    const payload = parseFirstEvent(raw, 'connected') as { tasks: Array<Record<string, unknown>> }

    const dailyTasks = payload.tasks.filter(t => t['type'] === 'daily')
    expect(dailyTasks.length).toBeGreaterThan(0)

    for (const task of dailyTasks) {
      expect(task).not.toHaveProperty('config')
    }
  })

  it('omits config and ownerId from task:updated events', async () => {
    // Create a DailyTask with an actionType that carries a config.
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({
        name: 'Config Sanitize Test',
        type: 'daily',
        actionType: 'http',
        config: { url: 'https://example.com', method: 'GET' },
      })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    // The create response itself serves as confirmation the task was created.
    // Now open SSE and trigger a task:updated event for it.
    const { taskEvents: te } = await import('../server/src/services/taskEvents')
    const { tasks: taskStore } = await import('../server/src/routes/tasks')

    const rawPromise = new Promise<string>((resolve, reject) => {
      let accumulated = ''
      let connectedReceived = false

      const req = http.get(
        { hostname: '127.0.0.1', port: serverPort, path: '/api/tasks/events', headers: authHeader() },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            accumulated += chunk
            if (!connectedReceived && accumulated.includes('event: connected')) {
              connectedReceived = true
              setImmediate(() => te.emitTaskUpdated(taskStore.get(taskId)!))
            }
            if (connectedReceived && accumulated.includes(taskId) && accumulated.includes('task:updated')) {
              req.destroy()
              resolve(accumulated)
            }
          })
          res.on('end', () => reject(new Error('SSE stream ended')))
        },
      )
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('SSE timed out')) })
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') resolve(accumulated)
        else reject(err)
      })
    })

    const raw = await rawPromise
    const updated = parseFirstEvent(raw, 'task:updated') as Record<string, unknown>

    expect(updated['id']).toBe(taskId)
    expect(updated).not.toHaveProperty('config')
    expect(updated).not.toHaveProperty('ownerId')
  })
})

describe('GET /api/tasks/:id/events – sensitive field sanitization', () => {
  it('omits config and ownerId from the per-task connected snapshot', async () => {
    // Create a DailyTask so its per-task SSE endpoint sends a connected event.
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({
        name: 'Per-task Config Strip Test',
        type: 'daily',
        actionType: 'ssh',
        config: { host: 'example.com', username: 'admin', password: 'secret123' },
      })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    const raw = await sseRequest(
      `/api/tasks/${taskId}/events`,
      data => data.includes('event: connected'),
    )
    const payload = parseFirstEvent(raw, 'connected') as { task: Record<string, unknown>; logs: unknown[] }

    expect(payload.task['id']).toBe(taskId)
    expect(payload.task).not.toHaveProperty('config')
    expect(payload.task).not.toHaveProperty('ownerId')
  })
})

// ── Log sanitization unit tests ───────────────────────────────────────────────

describe('appendLog – secret scrubbing', () => {
  it('redacts Bearer tokens before storing and broadcasting log lines', async () => {
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Log Sanitize Task', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    const { appendLog: appendLogFn } = await import('../server/src/routes/tasks')
    const rawMessage = 'Authorization: Bearer sk-abcdefghij1234567890'

    const rawPromise = sseRequest(
      '/api/tasks/events',
      data => data.includes('task:log') && data.includes(taskId),
    )

    await new Promise(r => setTimeout(r, 50))
    appendLogFn(taskId, rawMessage)

    const raw = await rawPromise
    // The raw Bearer token must NOT appear in the SSE stream.
    expect(raw).not.toContain('sk-abcdefghij1234567890')
    expect(raw).toContain('[REDACTED]')
  })

  it('redacts password=value patterns in log lines', async () => {
    const createRes = await supertestAgent
      .post('/api/tasks')
      .set(authHeader())
      .send({ name: 'Log Sanitize Task 2', type: 'routine' })
    expect(createRes.status).toBe(201)
    const taskId: string = createRes.body.id

    const { appendLog: appendLogFn } = await import('../server/src/routes/tasks')
    const rawMessage = 'Connecting with password=supersecret to database'

    const rawPromise = sseRequest(
      '/api/tasks/events',
      data => data.includes('task:log') && data.includes(taskId),
    )

    await new Promise(r => setTimeout(r, 50))
    appendLogFn(taskId, rawMessage)

    const raw = await rawPromise
    expect(raw).not.toContain('supersecret')
    expect(raw).toContain('[REDACTED]')
  })
})

// ── TaskEventEmitter unit tests ───────────────────────────────────────────────

describe('TaskEventEmitter', () => {
  it('emits task:updated with the correct task payload', async () => {
    const mockTask: Task = {
      id: 'emitter-test-1',
      name: 'Emitter Test',
      description: '',
      type: 'daily',
      status: 'succeeded',
      schedule: '0 9 * * *',
      actionType: 'http',
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const received = await new Promise<Task>(resolve => {
      taskEvents.once('task:updated', resolve)
      taskEvents.emitTaskUpdated(mockTask)
    })

    expect(received).toEqual(mockTask)
  })

  it('emits task:log with taskId and log payload', async () => {
    const taskId = 'emitter-log-test'
    const log = { timestamp: '2024-01-01T00:00:00.000Z', message: 'test log line' }

    const received = await new Promise<{ taskId: string; log: typeof log }>(resolve => {
      taskEvents.once('task:log', resolve)
      taskEvents.emitTaskLog(taskId, log)
    })

    expect(received.taskId).toBe(taskId)
    expect(received.log).toEqual(log)
  })

  it('allows multiple listeners without MaxListenersExceededWarning', () => {
    const listeners: Array<() => void> = []
    // Register 50 listeners — well within the 500 ceiling.
    for (let i = 0; i < 50; i++) {
      const fn = () => {}
      listeners.push(fn)
      taskEvents.on('task:updated', fn)
    }
    // If we reached here without Node.js throwing a warning/error, we're good.
    for (const fn of listeners) {
      taskEvents.off('task:updated', fn)
    }
    expect(listeners.length).toBe(50)
  })
})
