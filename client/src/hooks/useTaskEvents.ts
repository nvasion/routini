/**
 * React hook that subscribes to the `/api/tasks/stream` SSE endpoint and
 * emits typed events for the caller to consume.
 *
 * Why SSE (and not WebSocket)?
 * ────────────────────────────
 * The traffic is server → client only (status transitions + log lines).
 * SSE rides on plain HTTP so it inherits the app's cookie-based auth, and
 * `EventSource` handles reconnection with backoff and Last-Event-Id resume
 * automatically — the browser does the hard part.
 *
 * Wire contract
 * ─────────────
 * All event shapes come from `./taskEventWire.ts`, which is the client
 * mirror of `server/src/tasks/wireEvents.ts`. A filesystem contract test
 * (`tests/tasks.wireContract.test.ts`) enforces that the two stay
 * byte-for-byte identical — if the server side of the wire changes the
 * client shape follows in the same commit.
 *
 * Reconnection caveat
 * ───────────────────
 * `EventSource` transparently reconnects using the `retry:` hint the
 * server emits (see `server/src/tasks/sse.ts`) but it does NOT surface the
 * HTTP status code of a failed reconnect. A 401 (session expired) or a
 * 429 (per-user connection cap tripped) both surface as a generic `error`
 * event — callers that need to react (redirect to /login, show a banner)
 * should treat repeated `onError` calls as a signal to re-check
 * authentication out-of-band.
 *
 * Usage:
 *   useTaskEvents({
 *     onTaskStatus: (e) => updateTaskStatus(e.taskId, e.status),
 *     onRunLog: (e) => appendLog(e.runId, e.log),
 *   })
 *
 * The hook is a no-op when `EventSource` is unavailable (e.g. in a
 * JSDOM / SSR context) so callers do not have to guard.
 */

import { useEffect, useRef } from 'react'
import type {
  WireLogEntry,
  WireLogLevel,
  WireRunCreatedEvent,
  WireRunLogEvent,
  WireRunStatus,
  WireRunStatusEvent,
  WireTaskCreatedEvent,
  WireTaskDeletedEvent,
  WireTaskStatus,
  WireTaskStatusEvent,
  WireTaskType,
} from './taskEventWire'

// ---------------------------------------------------------------------------
// Public event types — re-exported wire aliases so downstream consumers
// (dashboards, log viewers, tests) can `import type { TaskStatusEvent }` from
// the hook module instead of reaching into `taskEventWire`. The wire file
// stays the single source of truth.
// ---------------------------------------------------------------------------

export type TaskType = WireTaskType
export type TaskStatus = WireTaskStatus
export type RunStatus = WireRunStatus
export type LogLevel = WireLogLevel
export type LogEntry = WireLogEntry
export type TaskCreatedEvent = WireTaskCreatedEvent
export type TaskDeletedEvent = WireTaskDeletedEvent
export type TaskStatusEvent = WireTaskStatusEvent
export type RunCreatedEvent = WireRunCreatedEvent
export type RunStatusEvent = WireRunStatusEvent
export type RunLogEvent = WireRunLogEvent

export interface UseTaskEventsCallbacks {
  onTaskCreated?: (event: TaskCreatedEvent) => void
  onTaskDeleted?: (event: TaskDeletedEvent) => void
  onTaskStatus?: (event: TaskStatusEvent) => void
  onRunCreated?: (event: RunCreatedEvent) => void
  onRunStatus?: (event: RunStatusEvent) => void
  onRunLog?: (event: RunLogEvent) => void
  /** Called when the underlying connection encounters an error. */
  onError?: (event: Event) => void
  /** Called when the connection is (re)opened. */
  onOpen?: () => void
}

export interface UseTaskEventsOptions extends UseTaskEventsCallbacks {
  /** Endpoint URL. Defaults to `/api/tasks/stream`. */
  url?: string
  /** When false, the hook does not open the connection. Defaults to true. */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Internal wiring
// ---------------------------------------------------------------------------

/** Shape guarantee: every wire event exposes at least `type` and `taskId`. */
interface WireBase {
  type: string
  taskId: string
}

/**
 * Parse an SSE `MessageEvent` payload and dispatch to `handler` if defined.
 * The generic is bounded to `WireBase` so a caller cannot accidentally pass
 * a handler expecting an unrelated shape.
 *
 * JSON parse errors are logged and swallowed: a single malformed frame
 * must NOT kill the subscription.
 *
 * Exported for direct unit testing — the React hook below is the only
 * production caller.
 */
export function dispatchEvent<E extends WireBase>(
  handler: ((event: E) => void) | undefined,
  event: { data: string; type: string },
): void {
  if (!handler) return
  try {
    const payload = JSON.parse(event.data) as E
    handler(payload)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[useTaskEvents] failed to parse event', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to task events for as long as the component is mounted. The
 * connection is opened on mount and closed on unmount; callbacks are stored
 * in a ref so consumers can pass fresh closures each render without
 * churning the underlying EventSource.
 *
 * `EventSource` availability is checked at effect-setup time — SSR / JSDOM
 * contexts silently skip the connection so tests do not have to mock it.
 */
export function useTaskEvents(options: UseTaskEventsOptions = {}): void {
  const { url = '/api/tasks/stream', enabled = true } = options
  const callbacksRef = useRef<UseTaskEventsCallbacks>(options)

  // Keep the latest callbacks available to the listener closures without
  // re-opening the socket every render.
  useEffect(() => {
    callbacksRef.current = options
  })

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return
    }

    // `withCredentials: true` is required so the auth cookie is sent on
    // cross-origin dev setups (client 5173, server 3001). Vite's proxy makes
    // this same-origin at runtime, but future deployments may not.
    const source = new EventSource(url, { withCredentials: true })

    const onTaskCreated = (e: MessageEvent) =>
      dispatchEvent<TaskCreatedEvent>(callbacksRef.current.onTaskCreated, e)
    const onTaskDeleted = (e: MessageEvent) =>
      dispatchEvent<TaskDeletedEvent>(callbacksRef.current.onTaskDeleted, e)
    const onTaskStatus = (e: MessageEvent) =>
      dispatchEvent<TaskStatusEvent>(callbacksRef.current.onTaskStatus, e)
    const onRunCreated = (e: MessageEvent) =>
      dispatchEvent<RunCreatedEvent>(callbacksRef.current.onRunCreated, e)
    const onRunStatus = (e: MessageEvent) =>
      dispatchEvent<RunStatusEvent>(callbacksRef.current.onRunStatus, e)
    const onRunLog = (e: MessageEvent) =>
      dispatchEvent<RunLogEvent>(callbacksRef.current.onRunLog, e)
    const onOpen = () => callbacksRef.current.onOpen?.()
    const onErrorHandler = (e: Event) => callbacksRef.current.onError?.(e)

    source.addEventListener('task-created', onTaskCreated as EventListener)
    source.addEventListener('task-deleted', onTaskDeleted as EventListener)
    source.addEventListener('task-status', onTaskStatus as EventListener)
    source.addEventListener('run-created', onRunCreated as EventListener)
    source.addEventListener('run-status', onRunStatus as EventListener)
    source.addEventListener('run-log', onRunLog as EventListener)
    source.addEventListener('open', onOpen)
    source.addEventListener('error', onErrorHandler)

    return () => {
      source.removeEventListener('task-created', onTaskCreated as EventListener)
      source.removeEventListener('task-deleted', onTaskDeleted as EventListener)
      source.removeEventListener('task-status', onTaskStatus as EventListener)
      source.removeEventListener('run-created', onRunCreated as EventListener)
      source.removeEventListener('run-status', onRunStatus as EventListener)
      source.removeEventListener('run-log', onRunLog as EventListener)
      source.removeEventListener('open', onOpen)
      source.removeEventListener('error', onErrorHandler)
      source.close()
    }
  }, [url, enabled])
}
