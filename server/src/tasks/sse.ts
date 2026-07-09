/**
 * Server-Sent Events (SSE) endpoint for real-time task status updates.
 *
 * Chosen over WebSockets because:
 *   - The traffic is server → client only (status transitions and log lines).
 *   - SSE rides on plain HTTP, so it inherits helmet headers, the existing
 *     CORS allowlist, and cookie-based auth without a second transport.
 *   - The browser `EventSource` API handles reconnection with backoff and
 *     Last-Event-Id resume automatically, keeping the client trivial.
 *
 * Transport pluggability
 * ──────────────────────
 * The handler subscribes to a `TaskEventSubscriber` — an interface, not the
 * in-process `TaskRunEventBus` class. That means a distributed adapter
 * (Redis Pub/Sub, NATS, …) that implements the same shape drops in
 * unchanged: this file never needs to know which pod produced an event.
 * See `events.ts` for the interface and a Redis adapter sketch.
 *
 * Ownership model
 * ───────────────
 * Every subscriber is scoped to the authenticated user (auth is enforced by
 * the parent router's `requireAuth` middleware). At delivery time the
 * handler looks up the task in the store and only sends events for tasks
 * the caller owns — cross-user leakage is impossible even if a rogue
 * publisher emits without a `userId`.
 *
 * Deleted-task events are a special case: after `deleteTask` runs the task
 * is gone so we cannot check ownership. To close that gap the handler
 * remembers which task ids the caller has seen and only forwards
 * `task-deleted` for ids in that set — a leaked delete would otherwise
 * confirm to a snooping client that a specific task id existed.
 *
 * Backpressure and resource limits
 * ────────────────────────────────
 * A per-connection queue caps in-flight bytes. If a slow client falls
 * further than `maxBufferedBytes` behind, the connection is closed with
 * a `stream-overrun` control event. Idle connections receive an SSE
 * comment heartbeat every `heartbeatMs` so proxies do not silently drop
 * the socket.
 */

import { Router, type Request, type Response } from 'express'
import type { TaskEventSubscriber, TaskRunEvent } from './events.js'
import type { TaskStore } from './store.js'
import type { WireEvent } from './wireEvents.js'

// ---------------------------------------------------------------------------
// Constants and options
// ---------------------------------------------------------------------------

/** Heartbeat frequency in ms. 15s stays well under standard 30s proxy idle timeouts. */
const DEFAULT_HEARTBEAT_MS = 15_000
/** Cap on in-flight bytes per client. 1 MiB keeps a burst of logs comfortable. */
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024
/**
 * Cap concurrent SSE connections per user to prevent a single account
 * hoarding sockets. 4 is enough for a normal browser (tab + backup tab
 * during dev-tools reloads) without enabling a DoS.
 */
const DEFAULT_MAX_CONNECTIONS_PER_USER = 4
/**
 * SSE reconnect hint in ms. The browser's default is ~3s; setting this
 * explicitly on connect lets us tune server-wide reconnect load (e.g.
 * back off during a rolling deploy) without a client change. 5s is a
 * middle ground that matches the PRD's "status updates within 5s" NFR.
 */
const DEFAULT_RETRY_MS = 5_000

export interface SseRouterOptions {
  /** Interval (ms) between heartbeat comments. Defaults to 15s. */
  heartbeatMs?: number
  /** Per-connection in-flight byte ceiling. Defaults to 1 MiB. */
  maxBufferedBytes?: number
  /** Per-user concurrent connection cap. Defaults to 4. */
  maxConnectionsPerUser?: number
  /** Reconnect hint (ms) sent as the SSE `retry:` field on connect. Defaults to 5000. */
  retryMs?: number
}

// ---------------------------------------------------------------------------
// Wire event helper
// ---------------------------------------------------------------------------

/**
 * Convert an internal bus event to a wire event or `null` if the event type
 * is internal (attempt-level events aren't forwarded to clients directly —
 * they surface as `run-status` transitions and `run-log` entries which the
 * store already emits).
 *
 * Any error message is passed through as-is because the store only ever
 * writes the sanitized message (see `executor.ts` and `daily/sanitizeError.ts`),
 * never a raw stack. Attempt-level events, which carry the raw error string,
 * are dropped here rather than downgraded — see the default case.
 */
function toWireEvent(event: TaskRunEvent): WireEvent | null {
  switch (event.type) {
    case 'task-created':
      return { type: 'task-created', taskId: event.taskId, taskType: event.taskType }
    case 'task-deleted':
      return { type: 'task-deleted', taskId: event.taskId }
    case 'task-status':
      return { type: 'task-status', taskId: event.taskId, status: event.status }
    case 'run-created':
      return { type: 'run-created', taskId: event.taskId, runId: event.runId }
    case 'run-status':
      return {
        type: 'run-status',
        taskId: event.taskId,
        runId: event.runId,
        status: event.status,
        ...(event.completedAt !== undefined && { completedAt: event.completedAt }),
        ...(event.error !== undefined && { error: event.error }),
      }
    case 'run-log':
      return {
        type: 'run-log',
        taskId: event.taskId,
        runId: event.runId,
        log: {
          timestamp: event.log.timestamp,
          message: event.log.message,
          level: event.log.level,
        },
      }
    default:
      // attempt-* and run-abandoned are executor internals — the store's
      // task-status/run-status events already cover the observable state.
      return null
  }
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

/**
 * Format a wire event as an SSE frame.
 * The `event:` field lets `EventSource.addEventListener(type, ...)` dispatch
 * per-type on the client without parsing a JSON envelope. The `data:` line
 * carries the same event as JSON so structured fields survive the wire.
 */
function formatSseFrame(event: WireEvent): string {
  // JSON.stringify never emits raw newlines, so a single data: line is safe;
  // this avoids the manual line-splitting the SSE spec otherwise requires.
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Track concurrent connections per user. Kept per-router-instance so isolated
 * test servers do not share state, but per-user within a router so the cap
 * spans a user's many tabs / devices.
 */
function connectionTracker(limit: number) {
  const counts = new Map<string, number>()
  return {
    tryAcquire(userId: string): boolean {
      const current = counts.get(userId) ?? 0
      if (current >= limit) return false
      counts.set(userId, current + 1)
      return true
    },
    release(userId: string): void {
      const current = counts.get(userId) ?? 0
      if (current <= 1) counts.delete(userId)
      else counts.set(userId, current - 1)
    },
  }
}

/**
 * Build the SSE router. The parent must already enforce `requireAuth` — this
 * router assumes `req.user` is populated.
 *
 * `bus` is typed as `TaskEventSubscriber` (not the concrete class) so a
 * distributed adapter can be substituted without touching this file.
 */
export function createTaskEventsRouter(
  store: TaskStore,
  bus: TaskEventSubscriber,
  options: SseRouterOptions = {},
): Router {
  const router = Router()
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  const maxConnectionsPerUser =
    options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const tracker = connectionTracker(maxConnectionsPerUser)

  router.get('/', (req: Request, res: Response) => {
    const userId = req.user!.id

    if (!tracker.tryAcquire(userId)) {
      res.status(429).json({
        error: 'Too many concurrent event streams for this user',
      })
      return
    }

    // ─────────────────────────────────────────────────────────────────
    // Connection setup
    // ─────────────────────────────────────────────────────────────────
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // Explicit: instruct proxies (nginx) not to buffer. Without this an
    // intermediate proxy may hold events until the response closes.
    res.setHeader('X-Accel-Buffering', 'no')
    // The default express response encoding is fine; SSE is text/event-stream
    // in UTF-8.
    res.flushHeaders?.()

    // Tell the browser how long to wait before reconnecting after a drop.
    // Setting this explicitly (rather than relying on the browser default)
    // lets us tune reconnect load during deploys and keeps the behaviour
    // consistent across EventSource implementations.
    res.write(`retry: ${retryMs}\n\n`)
    // Initial "connected" comment so clients can detect readiness without
    // waiting for the first real event. Comments start with `:` and are
    // ignored by EventSource except to reset the reconnect timer.
    res.write(': connected\n\n')

    // Track which task ids this user has legitimately seen so we can safely
    // forward `task-deleted` events (see rationale at top of file).
    const seenTaskIds = new Set<string>()
    // Prime with the current known tasks so a delete emitted immediately
    // after connect is still forwarded.
    for (const task of store.listTasks(undefined, userId)) {
      seenTaskIds.add(task.id)
    }

    // ─────────────────────────────────────────────────────────────────
    // Delivery
    // ─────────────────────────────────────────────────────────────────
    let bufferedBytes = 0
    let closed = false

    const closeConnection = (reason: string) => {
      if (closed) return
      closed = true
      clearInterval(heartbeatInterval)
      unsubscribe()
      tracker.release(userId)
      try {
        // Send a final control comment so operators inspecting a captured
        // stream can see why the connection ended. Wrapped in a try/catch
        // because res may already be broken.
        res.write(`: closed ${reason}\n\n`)
      } catch {
        // socket may already be dead — nothing more to do
      }
      try {
        res.end()
      } catch {
        // ignore — connection already gone
      }
    }

    const writeFrame = (frame: string): void => {
      if (closed) return
      // Node's res.write returns false when the internal buffer is full.
      // We treat that as backpressure and shed load if the queue is too
      // deep so a slow client cannot exhaust server memory.
      bufferedBytes += Buffer.byteLength(frame, 'utf8')
      if (bufferedBytes > maxBufferedBytes) {
        closeConnection('stream-overrun')
        return
      }
      const ok = res.write(frame, (err) => {
        if (err) {
          // Write errors mean the socket is dead — clean up.
          closeConnection('write-error')
        }
      })
      // When the socket drains, forgive the buffered accounting. We use
      // the 'drain' listener at the response level so this stays accurate.
      if (!ok) {
        res.once('drain', () => {
          bufferedBytes = 0
        })
      } else {
        // Fast path: writes that fit in the socket buffer clear immediately.
        bufferedBytes = 0
      }
    }

    // Subscribe to the bus. Because the transport swallows listener errors
    // we can assume this handler will always be invoked for every event.
    const unsubscribe = bus.on((event) => {
      // Look up ownership through the store to keep the event surface
      // itself trust-agnostic. Deleted-task events use the seen-set fallback.
      if (event.type === 'task-deleted') {
        if (!seenTaskIds.has(event.taskId)) return
        seenTaskIds.delete(event.taskId)
      } else {
        const owningTask = store.getTask(event.taskId)
        if (!owningTask || owningTask.userId !== userId) return
        // Remember the id so a subsequent delete for the same task passes
        // the seen-set gate.
        seenTaskIds.add(event.taskId)
      }

      const wire = toWireEvent(event)
      if (!wire) return
      writeFrame(formatSseFrame(wire))
    })

    // ─────────────────────────────────────────────────────────────────
    // Heartbeat
    // ─────────────────────────────────────────────────────────────────
    // Send a comment every heartbeatMs so long-lived TCP connections stay
    // alive through NAT and proxy idle timeouts. `unref` prevents the timer
    // from keeping the event loop alive during test teardown.
    const heartbeatInterval = setInterval(() => {
      if (closed) return
      try {
        res.write(': keepalive\n\n')
      } catch {
        closeConnection('heartbeat-write-failed')
      }
    }, heartbeatMs)
    heartbeatInterval.unref?.()

    // ─────────────────────────────────────────────────────────────────
    // Cleanup on disconnect
    // ─────────────────────────────────────────────────────────────────
    req.on('close', () => closeConnection('client-closed'))
    req.on('aborted', () => closeConnection('client-aborted'))
    res.on('close', () => closeConnection('response-closed'))
    res.on('error', () => closeConnection('response-error'))
  })

  return router
}
