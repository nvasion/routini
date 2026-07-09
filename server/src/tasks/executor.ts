/**
 * Task execution engine.
 *
 * The default (simulated) executor lives here so smoke tests can exercise
 * the queued → running → succeeded state machine without any real work.
 * Type-specific executors — daily (`daily/executor.ts`), developmental
 * (`docker.ts`) — plug in through the `TaskExecutor` interface.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Retry policy (PRD: "Failed tasks retry up to three times with
 * exponential backoff")
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `launchExecution` wraps the executor in a bounded retry loop with
 * exponential backoff. Every attempt gets a fresh `TaskRun` (the store
 * creates a new run object between attempts) so operators can see each
 * try as a discrete row rather than a merged single-run history.
 *
 * The retry count and base delay are configurable per call so tests can
 * exercise the loop without waiting real-time backoffs, and the daily
 * handler can pass a lower ceiling for HTTP-only tasks if it wants to.
 * Callers that do not want retry semantics pass `maxAttempts: 1`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Event bus
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `TaskRunEventBus` is a small in-process pub/sub for run status changes.
 * The current API layer polls the store; a future SSE / WebSocket layer
 * will subscribe to the bus and stream updates in real time. Wiring
 * events now means the migration is a router change, not an executor
 * refactor.
 */

import { EventEmitter } from 'node:events'
import type { Task, TaskRun } from './types.js'
import type { TaskStore } from './store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A TaskExecutor receives a frozen snapshot of the task and its newly-created
 * run, plus the store to write status updates into. It should resolve when the
 * execution completes (succeeded or failed). Errors thrown by the executor are
 * caught by `launchExecution` and written to the run as a failure.
 */
export type TaskExecutor = (task: Task, run: TaskRun, store: TaskStore) => Promise<void>

/** Event payloads emitted by the run bus. */
export interface TaskRunEvent {
  type: 'attempt-start' | 'attempt-succeeded' | 'attempt-failed' | 'run-abandoned'
  taskId: string
  runId: string
  attempt: number
  maxAttempts: number
  /** Sanitised error message when `type === 'attempt-failed'` or `'run-abandoned'`. */
  errorMessage?: string
}

/**
 * Pub/sub for run status transitions. Kept as its own class (rather than a
 * bare EventEmitter) so consumers can rely on a typed `emit`/`on` shape
 * without leaking every EventEmitter method into the public API.
 */
export class TaskRunEventBus {
  private readonly emitter = new EventEmitter()

  on(listener: (event: TaskRunEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  emit(event: TaskRunEvent): void {
    this.emitter.emit('event', event)
  }
}

/** Process-wide default bus. Callers can inject their own for isolation. */
export const defaultRunBus = new TaskRunEventBus()

// ---------------------------------------------------------------------------
// Dispatcher — routes by task type
// ---------------------------------------------------------------------------

/** Map of task type → concrete executor. */
export interface ExecutorMap {
  daily?: TaskExecutor
  developmental?: TaskExecutor
  routine?: TaskExecutor
}

/**
 * Build a `TaskExecutor` that dispatches on `task.type` to the
 * type-specific executor. Missing entries fall back to `defaultExecutor`
 * so an incomplete map still gives sensible behavior (used by tests that
 * only wire one type).
 */
export function createDispatchExecutor(map: ExecutorMap): TaskExecutor {
  return async (task, run, store) => {
    const specific = map[task.type]
    if (!specific) {
      return defaultExecutor(task, run, store)
    }
    return specific(task, run, store)
  }
}

// ---------------------------------------------------------------------------
// Default (stub) executor
// ---------------------------------------------------------------------------

/**
 * Simulated executor: transitions the run through queued → running → succeeded
 * without performing any real work. Kept as a fallback so tests that don't
 * care about the specific task type still see status transitions.
 */
export const defaultExecutor: TaskExecutor = async (
  task: Task,
  run: TaskRun,
  store: TaskStore,
): Promise<void> => {
  // Tick 1: queued → running
  await nextTick()
  store.appendRunLog(run.id, {
    timestamp: new Date().toISOString(),
    message: `Starting ${task.type} task "${task.name}"`,
    level: 'info',
  })
  store.updateRun(run.id, { status: 'running' })
  store.updateTaskStatus(task.id, 'running')

  // Tick 2: running → succeeded
  await nextTick()
  store.appendRunLog(run.id, {
    timestamp: new Date().toISOString(),
    message: `Task "${task.name}" completed successfully`,
    level: 'info',
  })
  store.updateRun(run.id, {
    status: 'succeeded',
    completedAt: new Date().toISOString(),
  })
  store.updateTaskStatus(task.id, 'succeeded')
}

/** Resolves on the next event-loop iteration via `setImmediate`. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** Max total attempts including the first. Default 3, minimum 1. */
  maxAttempts?: number
  /** Base backoff in ms. Attempt N sleeps `baseBackoffMs * 2^(N-1)`. Default 500ms. */
  baseBackoffMs?: number
  /**
   * Delay function — tests inject a synchronous stub so backoff waits
   * don't slow down the suite. Defaults to `setTimeout` promisified.
   */
  delay?: (ms: number) => Promise<void>
  /** Event bus to publish run transitions on. Defaults to `defaultRunBus`. */
  bus?: TaskRunEventBus
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_BACKOFF_MS = 500

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Executor runner — called by route handlers
// ---------------------------------------------------------------------------

/**
 * Kick off task execution asynchronously with bounded retries. Returns
 * immediately so the HTTP response can be sent with the initial `queued`
 * run.
 *
 * Retry model:
 *   - Attempt 1 uses the original `run` object handed in by the router.
 *     This is the run whose id the HTTP response echoes back, so the
 *     first status update the client sees maps onto the run they polled.
 *   - Attempts 2..N create a fresh run per attempt so operators can see
 *     each try in the runs list. The task status field always reflects
 *     the most recent attempt.
 *   - Backoff between attempts is exponential: `base * 2^(attempt-1)`.
 *   - A failure on the *final* attempt marks the task 'failed'; a
 *     failure on an earlier attempt logs the error and moves on.
 *
 * All error messages persisted to the run are already sanitised by the
 * type-specific executor; this wrapper only adds attempt accounting.
 */
export function launchExecution(
  task: Task,
  run: TaskRun,
  store: TaskStore,
  executor: TaskExecutor = defaultExecutor,
  options: LaunchOptions = {},
): void {
  const maxAttempts = clampMaxAttempts(options.maxAttempts)
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const delay = options.delay ?? realDelay
  const bus = options.bus ?? defaultRunBus

  setImmediate(() => {
    void executeWithRetry(task, run, store, executor, {
      maxAttempts,
      baseBackoffMs,
      delay,
      bus,
    })
  })
}

async function executeWithRetry(
  task: Task,
  firstRun: TaskRun,
  store: TaskStore,
  executor: TaskExecutor,
  options: Required<Omit<LaunchOptions, 'maxAttempts' | 'baseBackoffMs' | 'delay' | 'bus'>> & {
    maxAttempts: number
    baseBackoffMs: number
    delay: (ms: number) => Promise<void>
    bus: TaskRunEventBus
  },
): Promise<void> {
  let currentRun: TaskRun = firstRun
  let lastError: string | undefined

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    options.bus.emit({
      type: 'attempt-start',
      taskId: task.id,
      runId: currentRun.id,
      attempt,
      maxAttempts: options.maxAttempts,
    })

    try {
      await executor(task, currentRun, store)
      options.bus.emit({
        type: 'attempt-succeeded',
        taskId: task.id,
        runId: currentRun.id,
        attempt,
        maxAttempts: options.maxAttempts,
      })
      return
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      lastError = detail
      // Persist the failure on the run that just failed so operators see
      // each attempt's error, not just the last one.
      store.updateRun(currentRun.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Task execution failed. Check server logs for details.',
      })
      // Reserve the full error for the server log; the API surface stays
      // generic so internal detail (stack traces, library versions, file
      // paths) cannot leak to clients.
      // eslint-disable-next-line no-console
      console.error(
        `[executor] task=${task.id} run=${currentRun.id} attempt=${attempt}/${options.maxAttempts} failed:`,
        detail,
      )
      options.bus.emit({
        type: 'attempt-failed',
        taskId: task.id,
        runId: currentRun.id,
        attempt,
        maxAttempts: options.maxAttempts,
        errorMessage: detail,
      })

      if (attempt >= options.maxAttempts) break

      // Exponential backoff before the next attempt.
      const wait = options.baseBackoffMs * 2 ** (attempt - 1)
      await options.delay(wait)

      // Start a fresh run for the next attempt so each try is visible.
      const nextRun = store.createRun(task.id)
      if (!nextRun) {
        // Task was deleted mid-retry — abandon quietly.
        options.bus.emit({
          type: 'run-abandoned',
          taskId: task.id,
          runId: currentRun.id,
          attempt,
          maxAttempts: options.maxAttempts,
          errorMessage: 'task deleted before retry could start',
        })
        return
      }
      currentRun = nextRun
      store.updateTaskStatus(task.id, 'queued')
    }
  }

  // All attempts failed — reflect on the parent task.
  store.updateTaskStatus(task.id, 'failed')
  options.bus.emit({
    type: 'run-abandoned',
    taskId: task.id,
    runId: currentRun.id,
    attempt: options.maxAttempts,
    maxAttempts: options.maxAttempts,
    errorMessage: lastError,
  })
}

/** Coerce a caller-supplied maxAttempts into a safe positive integer. */
function clampMaxAttempts(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ATTEMPTS
  if (!Number.isFinite(raw)) return DEFAULT_MAX_ATTEMPTS
  const rounded = Math.floor(raw)
  if (rounded < 1) return 1
  // Guardrail: refuse silly-large values so a caller misconfiguration
  // can't create thousands of runs on a persistent failure.
  if (rounded > 10) return 10
  return rounded
}
