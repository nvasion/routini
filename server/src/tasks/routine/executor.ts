/**
 * Routine task executor.
 *
 * Executes a RoutineTask by running its steps sequentially. Each step
 * references another task (daily or developmental) that is executed inline
 * using the injected sub-executor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Step execution model
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. For each step in `routine.steps` (in order):
 *    a. If the step carries a `condition`, evaluate it against the context of
 *       the most recently *executed* step. If the condition is false, log
 *       "skipped" and continue to the next step without updating the context.
 *    b. Look up the referenced task. Reject it if it is not found, does not
 *       belong to the same user (authorization guard), or is itself a routine
 *       (prevents infinite recursion).
 *    c. Create a fresh TaskRun for the sub-task so the step's execution is
 *       visible in the sub-task's run history.
 *    d. Delegate execution to `subExecutor`. If the sub-executor throws *or*
 *       the resulting sub-run status is not `'succeeded'`, throw a
 *       `RoutineStepError`; the outer `launchExecution` retry loop will then
 *       handle marking the routine run/task as failed and scheduling retries.
 *    e. Update the context (`previousResult`) with the sub-run's final status.
 * 2. After all steps pass, mark the routine run as `'succeeded'`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Error handling contract
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This executor does NOT mark the routine run/task as `'failed'` on errors —
 * that is the responsibility of the outer `launchExecution` wrapper (which also
 * handles retries). The executor only marks the run as `'running'` on start and
 * `'succeeded'` on full completion.
 *
 * However, if a sub-executor leaves a sub-run in an intermediate state (queued
 * or running) after throwing, this executor sets it to `'failed'` before
 * re-throwing so there are no orphaned in-flight runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Authorization
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Steps are validated to reference tasks owned by the *same user* as the
 * routine. A step referencing another user's task is rejected with the same
 * "not found" error message to prevent task-ID enumeration.
 */

import type { Task, RoutineTask, TaskRun } from '../types.js'
import type { TaskStore } from '../store.js'
import type { TaskExecutor } from '../executor.js'
import { evaluateCondition, type StepContext } from './condition.js'

// ---------------------------------------------------------------------------
// Exported error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a routine step fails. The step number is embedded in the message
 * so operators can locate the failing step in server logs. The message is
 * intentionally kept generic in the outer retry loop's API-visible run record
 * so internal details (task IDs, error internals) do not leak to clients.
 */
export class RoutineStepError extends Error {
  constructor(
    public readonly stepNumber: number,
    detail: string,
  ) {
    super(`[routine] Step ${stepNumber}: ${detail}`)
    this.name = 'RoutineStepError'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `TaskExecutor` that runs a RoutineTask's steps sequentially.
 *
 * @param subExecutor  Executor used for each step's referenced task. In
 *   production this is the same `createDispatchExecutor({ daily, developmental
 *   })` used for individual tasks. Tests may inject a stub. The sub-executor
 *   MUST NOT handle routine tasks — the step-lookup guard already prevents
 *   nested routines, but passing the full dispatch executor (with routine
 *   handling) would cause infinite recursion if that guard were ever bypassed.
 */
export function createRoutineExecutor(subExecutor: TaskExecutor): TaskExecutor {
  return async (task: Task, run: TaskRun, store: TaskStore): Promise<void> => {
    if (task.type !== 'routine') {
      throw new Error(`[routine] Expected routine task, got "${task.type}"`)
    }

    const routine = task as RoutineTask

    // ── Routine start ────────────────────────────────────────────────────────
    appendLog(store, run.id, 'info',
      `Starting routine "${routine.name}" (${routine.steps.length} step(s))`,
    )
    store.updateRun(run.id, { status: 'running' })
    store.updateTaskStatus(task.id, 'running')

    let ctx: StepContext = { previous: undefined }

    for (let i = 0; i < routine.steps.length; i++) {
      const step = routine.steps[i]
      const stepNum = i + 1

      // ── Condition gate ─────────────────────────────────────────────────────
      if (step.condition !== undefined) {
        const shouldRun = evaluateCondition(step.condition, ctx)
        if (!shouldRun) {
          appendLog(store, run.id, 'info',
            `Step ${stepNum}: condition not met — skipping`,
          )
          // Do NOT update ctx.previous — the next step's condition still sees
          // the last *executed* step's result.
          continue
        }
      }

      // ── Task lookup + authorization ────────────────────────────────────────
      const subTask = store.getTask(step.taskId)

      // Return "not found" for both missing and cross-user tasks so callers
      // cannot enumerate other users' task IDs from error messages.
      if (!subTask || subTask.userId !== routine.userId) {
        throw new RoutineStepError(
          stepNum,
          `Referenced task not found or not accessible`,
        )
      }
      // Block nested routines — we do not support them and they would cause
      // infinite recursion if the sub-executor were ever swapped in with
      // routine handling.
      if (subTask.type === 'routine') {
        throw new RoutineStepError(
          stepNum,
          `Nested routines are not supported (task "${subTask.name}")`,
        )
      }

      // ── Sub-run creation ───────────────────────────────────────────────────
      appendLog(store, run.id, 'info',
        `Step ${stepNum}: executing "${subTask.name}" (${subTask.type})`,
      )

      const subRun = store.createRun(step.taskId)
      if (!subRun) {
        // Task was deleted between the lookup above and createRun — treat as
        // if the task never existed.
        throw new RoutineStepError(
          stepNum,
          `Referenced task not found or not accessible`,
        )
      }

      // ── Sub-task execution ─────────────────────────────────────────────────
      try {
        store.updateTaskStatus(step.taskId, 'running')
        await subExecutor(subTask, subRun, store)
      } catch (err) {
        // Guard: ensure the sub-run is not left in a transient state so the
        // store does not contain dangling in-flight runs.
        const latestSubRun = store.getRun(subRun.id)
        if (
          latestSubRun &&
          latestSubRun.status !== 'failed' &&
          latestSubRun.status !== 'succeeded'
        ) {
          store.updateRun(subRun.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: 'Step execution failed. Check server logs for details.',
          })
          store.updateTaskStatus(step.taskId, 'failed')
        }

        // Update context so a subsequent step can react to this failure.
        ctx = { previous: { status: 'failed' } }

        const msg = err instanceof Error ? err.message : String(err)
        throw new RoutineStepError(stepNum, `Task "${subTask.name}" threw: ${msg}`)
      }

      // Read the definitive status from the store — the sub-executor owns it.
      const finalSubRun = store.getRun(subRun.id)
      const subStatus = finalSubRun?.status ?? 'failed'

      appendLog(
        store,
        run.id,
        subStatus === 'succeeded' ? 'info' : 'warn',
        `Step ${stepNum}: "${subTask.name}" finished with status "${subStatus}"`,
      )

      ctx = { previous: { status: subStatus } }

      if (subStatus !== 'succeeded') {
        throw new RoutineStepError(
          stepNum,
          `Task "${subTask.name}" ended with status "${subStatus}"`,
        )
      }
    }

    // ── All steps succeeded ──────────────────────────────────────────────────
    appendLog(store, run.id, 'info',
      `Routine "${routine.name}" completed all ${routine.steps.length} step(s) successfully`,
    )
    store.updateRun(run.id, {
      status: 'succeeded',
      completedAt: new Date().toISOString(),
    })
    store.updateTaskStatus(task.id, 'succeeded')
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function appendLog(
  store: TaskStore,
  runId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  store.appendRunLog(runId, {
    timestamp: new Date().toISOString(),
    level,
    message,
  })
}
