/**
 * Task execution engine.
 *
 * This module is intentionally thin. Real execution (SSH via ssh2, Docker
 * container lifecycle, AI agent invocation) will be implemented by later PRD
 * tasks that plug in concrete handlers per task type.
 *
 * The default export simulates a task run: queued → running → succeeded,
 * updating the store so callers can observe status transitions via the API.
 * It is deliberately asynchronous (using `setImmediate`) so the HTTP response
 * is returned to the client before the state machine ticks.
 */

import type { Task, TaskRun } from './types.js'
import type { TaskStore } from './store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A TaskExecutor receives a frozen snapshot of the task and its newly-created
 * run, plus the store to write status updates into. It should resolve when the
 * execution completes (succeeded or failed). Errors thrown by the executor are
 * caught in the route handler and written to the run as a failure.
 */
export type TaskExecutor = (task: Task, run: TaskRun, store: TaskStore) => Promise<void>

// ---------------------------------------------------------------------------
// Default (stub) executor
// ---------------------------------------------------------------------------

/**
 * Simulated executor: transitions the run through queued → running → succeeded
 * without performing any real work. Replace or supplement this with real
 * handlers (Docker, SSH, etc.) once those services are implemented.
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
// Executor runner — called by route handlers
// ---------------------------------------------------------------------------

/**
 * Kick off task execution asynchronously. The function returns immediately
 * (before execution completes) so the HTTP response can be sent with the
 * initial `queued` run.
 *
 * On failure the executor updates the run status to `failed` and records the
 * error message in the run — callers can poll GET /api/tasks/:id/runs to
 * observe the final state.
 */
export function launchExecution(
  task: Task,
  run: TaskRun,
  store: TaskStore,
  executor: TaskExecutor = defaultExecutor,
): void {
  setImmediate(() => {
    executor(task, run, store).catch((err: unknown) => {
      // Log the full error server-side for operator visibility, but surface
      // only a generic message to clients to prevent internal details (stack
      // traces, file paths, library versions) from leaking via the API.
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[executor] task=${task.id} run=${run.id} failed:`, detail)
      store.updateRun(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Task execution failed. Check server logs for details.',
      })
      store.updateTaskStatus(task.id, 'failed')
    })
  })
}
