/**
 * SSE / real-time task status update tests.
 *
 * The tests spin up a real HTTP server (ephemeral port) so the entire stack
 * — auth, routing, sub-router mounting, and the SSE handler — is exercised
 * end-to-end. We speak the wire protocol directly via `fetch` because
 * Node's built-in `EventSource` isn't universally available and shipping
 * an `eventsource` polyfill just for tests is more moving parts than we
 * need.
 *
 * Isolation
 * ─────────
 * Every event-delivery test builds its own server (via `beforeEach`) so
 * timers, subscriptions, and store state cannot bleed across tests. Auth
 * / lifecycle / connection-cap tests use a single shared server because
 * they only need side-effect-free reads.
 *
 * Coverage
 * ────────
 * - Auth: 401 with no cookie / bearer.
 * - Content-Type: response is `text/event-stream`.
 * - Delivery: events for the caller's tasks arrive on the stream.
 * - Isolation: events for another user's tasks are NOT delivered.
 * - Deleted tasks: `task-deleted` events are only forwarded for tasks the
 *   caller had previously seen (blocks enumeration).
 * - Log streaming: `run-log` events appear in order.
 * - Cleanup: client disconnect removes the bus subscription.
 * - Rate cap: per-user concurrent connections are limited.
 */

import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  RateLimiter,
  UserStore,
  createAuthRouter,
  loadAuthConfig,
} from '../server/src/auth/index.js'
import { createRouter } from '../server/src/routes.js'
import { TaskRunEventBus, TaskStore } from '../server/src/tasks/index.js'
import type { TaskExecutor } from '../server/src/tasks/executor.js'
import type { CreateDailyTaskInput } from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD = 'test-p@ssw0rd!'
const OTHER_PASSWORD = 'other-P@ssw0rd!'

/** Executor that never touches the store — tests drive state transitions directly. */
const noopExecutor: TaskExecutor = async () => {}

interface TestServer {
  server: Server
  baseUrl: string
  taskStore: TaskStore
  runBus: TaskRunEventBus
  adminToken: string
  adminUserId: string
  otherToken: string
  otherUserId: string
}

/**
 * Bring up a fresh server + store + bus so subscribers don't bleed across
 * tests and heartbeats don't outlive tests.
 */
async function bootTestServer(overrides: {
  heartbeatMs?: number
  maxConnectionsPerUser?: number
  maxBufferedBytes?: number
} = {}): Promise<TestServer> {
  process.env.NODE_ENV = 'test'

  const users = new UserStore()
  const adminUser = await users.createUser('admin', ADMIN_PASSWORD)
  const otherUser = await users.createUser('other', OTHER_PASSWORD)

  const authConfig = loadAuthConfig()
  const authDeps = { config: authConfig, users }
  const permissiveLimiter = new RateLimiter({
    maxAttempts: 10_000,
    windowSeconds: 60,
  })

  const runBus = new TaskRunEventBus()
  const taskStore = new TaskStore({ bus: runBus })

  const app = express()
  app.use(express.json())
  app.use(
    '/api/auth',
    createAuthRouter(authDeps, { loginRateLimiter: permissiveLimiter }),
  )
  app.use(
    '/api',
    createRouter(authDeps, {
      tasks: taskStore,
      runBus,
      executor: noopExecutor,
      executeRateLimiter: permissiveLimiter,
      sseOptions: {
        heartbeatMs: overrides.heartbeatMs ?? 15_000,
        maxConnectionsPerUser: overrides.maxConnectionsPerUser ?? 4,
        maxBufferedBytes: overrides.maxBufferedBytes ?? 1024 * 1024,
      },
    }),
  )

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const adminToken = await login(baseUrl, 'admin', ADMIN_PASSWORD)
  const otherToken = await login(baseUrl, 'other', OTHER_PASSWORD)

  return {
    server,
    baseUrl,
    taskStore,
    runBus,
    adminToken,
    adminUserId: adminUser.id,
    otherToken,
    otherUserId: otherUser.id,
  }
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`)
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('no set-cookie in login response')
  return extractToken(setCookie)
}

function extractToken(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  const [, rawValue] = pair.split('=')
  return decodeURIComponent(rawValue)
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

// ---------------------------------------------------------------------------
// Stream reader helper
// ---------------------------------------------------------------------------

/** Open an SSE connection and return the response + an abort controller. */
async function openStream(
  baseUrl: string,
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/api/tasks/stream`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      ...extraHeaders,
    },
    signal: controller.signal,
  })
  return { response, controller }
}

interface ParsedFrame {
  event?: string
  data?: string
  comments: string[]
}

function parseFrame(text: string): ParsedFrame {
  const frame: ParsedFrame = { comments: [] }
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) {
      frame.comments.push(line.slice(1).trim())
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const field = line.slice(0, idx)
    const value = line.slice(idx + 1).replace(/^ /, '')
    if (field === 'event') frame.event = value
    else if (field === 'data') frame.data = (frame.data ?? '') + value
  }
  return frame
}

/**
 * A live SSE reader that lets tests emit events and then drain frames
 * without racing test setup against the initial `: connected` comment.
 */
class StreamReader {
  private buffer = ''
  private readonly decoder = new TextDecoder()
  private done = false

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {}

  /**
   * Read frames until `matcher` returns a defined value, up to `timeoutMs`.
   * Returns the matcher's non-undefined return; throws on timeout.
   */
  async readUntil<T>(
    matcher: (frame: ParsedFrame) => T | undefined,
    timeoutMs = 4000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary !== -1) {
        const frameText = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        const parsed = parseFrame(frameText)
        const outcome = matcher(parsed)
        if (outcome !== undefined) return outcome
        continue
      }
      const chunk = await this.readOnce(Math.max(0, deadline - Date.now()))
      if (chunk === null) throw new Error('readUntil timed out')
      if (chunk === 'closed') throw new Error('stream closed before match')
      this.buffer += chunk
    }
    throw new Error('readUntil timed out')
  }

  private async readOnce(waitMs: number): Promise<string | null | 'closed'> {
    if (this.done) return 'closed'
    const readPromise = this.reader.read()
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), waitMs).unref?.(),
    )
    const result = await Promise.race([readPromise, timeoutPromise])
    if (result === null) return null
    if (result.done) {
      this.done = true
      return 'closed'
    }
    return this.decoder.decode(result.value, { stream: true })
  }

  async close(): Promise<void> {
    try {
      this.controller.abort()
    } catch {
      /* ignore */
    }
    try {
      await this.reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open a stream, wait until the initial `connected` comment is received
 * (so we know the server-side subscription is registered), and return a
 * reader ready for further frames.
 */
async function openConnectedStream(
  baseUrl: string,
  token: string,
): Promise<{ reader: StreamReader; response: Response }> {
  const { response, controller } = await openStream(baseUrl, token)
  if (response.status !== 200) {
    controller.abort()
    throw new Error(`stream open failed: HTTP ${response.status}`)
  }
  const streamReader = new StreamReader(
    response.body!.getReader(),
    controller,
  )
  await streamReader.readUntil((frame) =>
    frame.comments.includes('connected') ? true : undefined,
  )
  return { reader: streamReader, response }
}

function ownerlessDaily(userId: string): CreateDailyTaskInput {
  return {
    type: 'daily',
    userId,
    name: 'SSH check',
    subtype: 'ssh',
    config: { host: 'example.com', username: 'deploy', command: 'uptime' },
  }
}

// ---------------------------------------------------------------------------
// Auth guard (shared server — no state changes involved)
// ---------------------------------------------------------------------------

describe('GET /api/tasks/stream — authentication', () => {
  let ts: TestServer
  beforeAll(async () => {
    ts = await bootTestServer()
  })
  afterAll(async () => {
    await closeServer(ts.server)
  })

  it('rejects requests without an auth token', async () => {
    const res = await fetch(`${ts.baseUrl}/api/tasks/stream`, {
      headers: { Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(401)
    await res.arrayBuffer()
  })

  it('rejects requests with an invalid bearer token', async () => {
    const res = await fetch(`${ts.baseUrl}/api/tasks/stream`, {
      headers: {
        Authorization: 'Bearer not-a-real-token',
        Accept: 'text/event-stream',
      },
    })
    expect(res.status).toBe(401)
    await res.arrayBuffer()
  })

  it('accepts a cookie-based auth session', async () => {
    const res = await fetch(`${ts.baseUrl}/api/tasks/stream`, {
      headers: {
        Cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(ts.adminToken)}`,
        Accept: 'text/event-stream',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    await res.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// Connection lifecycle (fresh server so heartbeat/subscriber assertions are
// deterministic)
// ---------------------------------------------------------------------------

describe('GET /api/tasks/stream — connection lifecycle', () => {
  let ts: TestServer
  beforeEach(async () => {
    ts = await bootTestServer({ heartbeatMs: 60 })
  })
  afterEach(async () => {
    await closeServer(ts.server)
  })

  it('sends the SSE content-type and cache-control headers', async () => {
    const { response, controller } = await openStream(ts.baseUrl, ts.adminToken)
    try {
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
      expect(response.headers.get('cache-control')).toMatch(/no-cache/)
      expect(response.headers.get('x-accel-buffering')).toBe('no')
    } finally {
      controller.abort()
      await response.body?.cancel().catch(() => undefined)
    }
  })

  it('emits an initial connected comment', async () => {
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)
    // openConnectedStream throws if we never see `connected`; getting here
    // proves the comment was received.
    await reader.close()
  })

  it('emits a heartbeat comment on the configured interval', async () => {
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)
    const heartbeat = await reader.readUntil((frame) =>
      frame.comments.includes('keepalive') ? 'keepalive' : undefined,
    )
    expect(heartbeat).toBe('keepalive')
    await reader.close()
  })

  it('cleans up bus subscribers when the client disconnects', async () => {
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)
    expect(ts.runBus.listenerCount()).toBeGreaterThanOrEqual(1)

    await reader.close()

    // Poll briefly for the count to fall back to zero — the close event
    // fires asynchronously.
    for (let i = 0; i < 50; i++) {
      if (ts.runBus.listenerCount() === 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(ts.runBus.listenerCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Event delivery + ownership isolation (fresh server per test)
// ---------------------------------------------------------------------------

describe('GET /api/tasks/stream — event delivery', () => {
  let ts: TestServer
  beforeEach(async () => {
    ts = await bootTestServer()
  })
  afterEach(async () => {
    await closeServer(ts.server)
  })

  it("delivers status transitions for the caller's own tasks", async () => {
    const task = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    ts.taskStore.updateTaskStatus(task.id, 'running')

    const event = await reader.readUntil((frame) => {
      if (frame.event === 'task-status' && frame.data) {
        return JSON.parse(frame.data) as {
          type: string
          taskId: string
          status: string
        }
      }
      return undefined
    })
    expect(event).toEqual({
      type: 'task-status',
      taskId: task.id,
      status: 'running',
    })
    await reader.close()
  })

  it("does NOT deliver events for another user's tasks", async () => {
    const otherTask = ts.taskStore.createDailyTask(ownerlessDaily(ts.otherUserId))
    const adminTask = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))

    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    ts.taskStore.updateTaskStatus(otherTask.id, 'running')
    ts.taskStore.updateTaskStatus(adminTask.id, 'running')

    const event = await reader.readUntil((frame) => {
      if (frame.event === 'task-status' && frame.data) {
        return JSON.parse(frame.data) as { taskId: string }
      }
      return undefined
    })
    // The FIRST task-status frame must be the admin's — the other user's
    // event should have been filtered out at the SSE boundary.
    expect(event.taskId).toBe(adminTask.id)
    await reader.close()
  })

  it('streams appended run logs to the caller in order', async () => {
    const task = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))
    const run = ts.taskStore.createRun(task.id)!

    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    ts.taskStore.appendRunLog(run.id, {
      timestamp: '2025-01-01T00:00:00.000Z',
      message: 'first',
      level: 'info',
    })
    ts.taskStore.appendRunLog(run.id, {
      timestamp: '2025-01-01T00:00:01.000Z',
      message: 'second',
      level: 'warn',
    })

    const seen: Array<{ message: string; level: string; timestamp: string }> = []
    await reader.readUntil((frame) => {
      if (frame.event === 'run-log' && frame.data) {
        const parsed = JSON.parse(frame.data) as {
          log: { message: string; level: string; timestamp: string }
        }
        seen.push(parsed.log)
        if (seen.length === 2) return seen
      }
      return undefined
    })

    expect(seen).toEqual([
      {
        message: 'first',
        level: 'info',
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        message: 'second',
        level: 'warn',
        timestamp: '2025-01-01T00:00:01.000Z',
      },
    ])
    await reader.close()
  })

  it('does not forward task-deleted events for tasks never seen by the caller', async () => {
    const otherTask = ts.taskStore.createDailyTask(ownerlessDaily(ts.otherUserId))
    const adminTask = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))

    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    // Delete the other user's task — must NOT reach admin.
    ts.taskStore.deleteTask(otherTask.id)
    // Change admin's task — MUST reach admin.
    ts.taskStore.updateTaskStatus(adminTask.id, 'running')

    const event = await reader.readUntil((frame) => {
      if (frame.event === 'task-deleted') {
        throw new Error(
          `unexpected task-deleted leaked: ${frame.data ?? ''}`,
        )
      }
      if (frame.event === 'task-status' && frame.data) {
        return JSON.parse(frame.data) as { taskId: string }
      }
      return undefined
    })
    expect(event.taskId).toBe(adminTask.id)
    await reader.close()
  })

  it('forwards task-deleted events for tasks the caller had previously seen', async () => {
    const task = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    ts.taskStore.updateTaskStatus(task.id, 'running')
    ts.taskStore.deleteTask(task.id)

    let sawStatus = false
    const event = await reader.readUntil((frame) => {
      if (frame.event === 'task-status') sawStatus = true
      if (frame.event === 'task-deleted' && frame.data) {
        return JSON.parse(frame.data) as { type: string; taskId: string }
      }
      return undefined
    })
    expect(sawStatus).toBe(true)
    expect(event.type).toBe('task-deleted')
    expect(event.taskId).toBe(task.id)
    await reader.close()
  })

  it('forwards task-created for owned tasks even without a prior sighting', async () => {
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    const created = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))

    const event = await reader.readUntil((frame) => {
      if (frame.event === 'task-created' && frame.data) {
        return JSON.parse(frame.data) as { taskId: string; taskType: string }
      }
      return undefined
    })
    expect(event.taskId).toBe(created.id)
    expect(event.taskType).toBe('daily')
    await reader.close()
  })

  it('does not forward internal attempt-* events emitted by the executor', async () => {
    const task = ts.taskStore.createDailyTask(ownerlessDaily(ts.adminUserId))
    const run = ts.taskStore.createRun(task.id)!
    const { reader } = await openConnectedStream(ts.baseUrl, ts.adminToken)

    // Emit an attempt-start directly — should NOT reach the wire because
    // the SSE handler only forwards store-level events.
    ts.runBus.emit({
      type: 'attempt-start',
      taskId: task.id,
      runId: run.id,
      attempt: 1,
      maxAttempts: 3,
    })
    // Then emit a run-status via the store as a canary — should reach.
    ts.taskStore.updateRun(run.id, { status: 'running' })

    const event = await reader.readUntil((frame) => {
      if (frame.event === 'attempt-start') {
        throw new Error('attempt-start leaked to the wire')
      }
      if (frame.event === 'run-status' && frame.data) {
        return JSON.parse(frame.data) as { status: string }
      }
      return undefined
    })
    expect(event.status).toBe('running')
    await reader.close()
  })
})

// ---------------------------------------------------------------------------
// Per-user concurrent connection cap
// ---------------------------------------------------------------------------

describe('GET /api/tasks/stream — per-user connection cap', () => {
  let ts: TestServer
  beforeEach(async () => {
    ts = await bootTestServer({ maxConnectionsPerUser: 2 })
  })
  afterEach(async () => {
    await closeServer(ts.server)
  })

  it('rejects a third concurrent stream from the same user with 429', async () => {
    const first = await openStream(ts.baseUrl, ts.adminToken)
    const second = await openStream(ts.baseUrl, ts.adminToken)
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)

    const third = await fetch(`${ts.baseUrl}/api/tasks/stream`, {
      headers: {
        Authorization: `Bearer ${ts.adminToken}`,
        Accept: 'text/event-stream',
      },
    })
    expect(third.status).toBe(429)
    const body = (await third.json()) as { error: string }
    expect(body.error).toMatch(/too many/i)

    // A different user is not affected by admin's cap.
    const otherStream = await openStream(ts.baseUrl, ts.otherToken)
    expect(otherStream.response.status).toBe(200)

    first.controller.abort()
    await first.response.body?.cancel().catch(() => undefined)
    second.controller.abort()
    await second.response.body?.cancel().catch(() => undefined)
    otherStream.controller.abort()
    await otherStream.response.body?.cancel().catch(() => undefined)
  })
})
