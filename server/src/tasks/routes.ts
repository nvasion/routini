/**
 * Task CRUD and execution-trigger routes.
 *
 * All endpoints are mounted under /api/tasks (via the parent router in
 * routes.ts) and require an authenticated user. State-changing methods
 * (POST, PUT, DELETE) additionally require Content-Type: application/json
 * (CSRF guard applied at the router level for all mutating endpoints).
 *
 * Route summary
 * ─────────────
 * GET    /api/tasks              List all tasks (optional ?type= filter)
 * POST   /api/tasks              Create a task
 * GET    /api/tasks/:id          Get a single task
 * PUT    /api/tasks/:id          Partial-update a task
 * DELETE /api/tasks/:id          Delete a task and its runs
 * POST   /api/tasks/:id/execute  Trigger execution → returns a TaskRun
 * GET    /api/tasks/:id/runs     List all runs for a task
 * GET    /api/runs/:runId        Get a single run (with logs)
 *
 * Authorization
 * ─────────────
 * Every endpoint that accesses a specific task verifies that the authenticated
 * user owns that task (task.userId === req.user.id). Tasks that don't exist
 * and tasks owned by another user both return 404 so callers cannot enumerate
 * other users' task IDs.
 */

import { Router, type Request, type Response } from 'express'
import { csrfProtect, RateLimiter } from '../auth/index.js'
import type { TaskStore } from './store.js'
import {
  VALID_TASK_TYPES,
  type CreateDailyTaskInput,
  type CreateDevelopmentalTaskInput,
  type CreateRoutineTaskInput,
  type Task,
  type TaskType,
} from './types.js'
import { validateCreateTask, validateUpdateTask } from './validation.js'
import { launchExecution, type TaskExecutor } from './executor.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a consistent error response body. All error responses from this module
 * use this shape so clients have a single format to parse.
 */
function errorResponse(
  message: string,
  details?: string[],
): { error: string; details?: string[] } {
  return details !== undefined ? { error: message, details } : { error: message }
}

/**
 * Remove write-only credential fields from a task before sending it to the
 * client. SSH tasks carry an optional `password` and `privateKey`; email tasks
 * carry an optional `password`. These are stored internally so executors can
 * use them, but MUST NOT appear in API responses.
 *
 * This function creates a new task object and config object — the original
 * is left untouched in the store.
 */
function sanitizeTask(task: Task): Task {
  if (task.type !== 'daily') return task

  // Strip credential fields regardless of subtype — future subtypes may add
  // them too, and a defensive strip is cheaper than a missed field.
  // We cast through `unknown` to satisfy strict TS checks on the union type.
  const rawConfig = task.config as unknown as Record<string, unknown>
  const { password: _pw, privateKey: _pk, ...safeConfig } = rawConfig

  return {
    ...task,
    config: safeConfig as unknown as typeof task.config,
  }
}

// ---------------------------------------------------------------------------
// Router options
// ---------------------------------------------------------------------------

export interface TaskRouterOptions {
  /**
   * Inject a custom executor, e.g. a synchronous stub in unit tests.
   * Defaults to `defaultExecutor` (simulated async execution).
   */
  executor?: TaskExecutor
  /**
   * Rate limiter for POST /:id/execute, keyed on the authenticated user ID.
   * Defaults to 20 triggers per minute per user to prevent DoS via task
   * flooding. Inject a permissive limiter in tests to avoid hitting the limit.
   *
   * Example (tests):
   *   new RateLimiter({ maxAttempts: 10_000, windowSeconds: 60 })
   */
  executeRateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Tasks router (/api/tasks)
// ---------------------------------------------------------------------------

export function createTasksRouter(
  store: TaskStore,
  options: TaskRouterOptions = {},
): Router {
  const router = Router()
  const csrf = csrfProtect()

  // Per-user rate limiter for the execute endpoint. Defaults to 20 per minute.
  const executeRateLimiter =
    options.executeRateLimiter ??
    new RateLimiter({ maxAttempts: 20, windowSeconds: 60 })

  // -------------------------------------------------------------------------
  // GET /tasks — list tasks owned by the authenticated user
  // -------------------------------------------------------------------------

  router.get('/', (req: Request, res: Response) => {
    const userId = req.user!.id
    const rawType = req.query.type

    if (rawType !== undefined) {
      if (typeof rawType !== 'string' || !VALID_TASK_TYPES.includes(rawType as TaskType)) {
        res.status(400).json(
          errorResponse(`Invalid type filter. Must be one of: ${VALID_TASK_TYPES.join(', ')}`),
        )
        return
      }
    }

    const tasks = store.listTasks(rawType as TaskType | undefined, userId)
    res.json({ tasks: tasks.map(sanitizeTask), count: tasks.length })
  })

  // -------------------------------------------------------------------------
  // POST /tasks — create a task owned by the authenticated user
  // -------------------------------------------------------------------------

  router.post('/', csrf, (req: Request, res: Response) => {
    const errors = validateCreateTask(req.body)
    if (errors.length > 0) {
      res.status(400).json(errorResponse('Validation failed', errors))
      return
    }

    // userId comes from the verified JWT — never from the request body —
    // so we spread it in after validation rather than including it in the
    // validated body.
    const userId = req.user!.id
    const body = req.body as Record<string, unknown>
    const input = { ...body, userId }
    let task

    if (body.type === 'daily') {
      task = store.createDailyTask(input as CreateDailyTaskInput)
    } else if (body.type === 'developmental') {
      task = store.createDevelopmentalTask(input as CreateDevelopmentalTaskInput)
    } else {
      task = store.createRoutineTask(input as CreateRoutineTaskInput)
    }

    res.status(201).json(sanitizeTask(task))
  })

  // -------------------------------------------------------------------------
  // GET /tasks/:id — get a single task (owner only)
  // -------------------------------------------------------------------------

  router.get('/:id', (req: Request, res: Response) => {
    const task = store.getTask(req.params.id)
    // Return 404 for both "not found" and "wrong owner" to prevent enumeration.
    if (!task || task.userId !== req.user!.id) {
      res.status(404).json(errorResponse('Task not found'))
      return
    }
    res.json(sanitizeTask(task))
  })

  // -------------------------------------------------------------------------
  // PUT /tasks/:id — partial-update a task (owner only)
  // -------------------------------------------------------------------------

  router.put('/:id', csrf, (req: Request, res: Response) => {
    const existing = store.getTask(req.params.id)
    if (!existing || existing.userId !== req.user!.id) {
      res.status(404).json(errorResponse('Task not found'))
      return
    }

    // Prevent updating a task that is actively queued or running
    if (existing.status === 'queued' || existing.status === 'running') {
      res.status(409).json(
        errorResponse('Cannot update a task while it is queued or running'),
      )
      return
    }

    const errors = validateUpdateTask(req.body, existing)
    if (errors.length > 0) {
      res.status(400).json(errorResponse('Validation failed', errors))
      return
    }

    const patch = req.body as Record<string, unknown>
    let updated

    if (existing.type === 'daily') {
      updated = store.updateDailyTask(req.params.id, patch)
    } else if (existing.type === 'developmental') {
      updated = store.updateDevelopmentalTask(req.params.id, patch)
    } else {
      updated = store.updateRoutineTask(req.params.id, patch)
    }

    if (!updated) {
      // Concurrent delete race; treat as gone
      res.status(404).json(errorResponse('Task not found'))
      return
    }

    res.json(sanitizeTask(updated))
  })

  // -------------------------------------------------------------------------
  // DELETE /tasks/:id — delete a task and its runs (owner only)
  // -------------------------------------------------------------------------

  router.delete('/:id', csrf, (req: Request, res: Response) => {
    const existing = store.getTask(req.params.id)
    if (!existing || existing.userId !== req.user!.id) {
      res.status(404).json(errorResponse('Task not found'))
      return
    }

    // Refuse to delete while running to avoid orphaning the executor
    if (existing.status === 'running') {
      res.status(409).json(errorResponse('Cannot delete a task while it is running'))
      return
    }

    store.deleteTask(req.params.id)
    res.json({ message: 'Task deleted', id: req.params.id })
  })

  // -------------------------------------------------------------------------
  // POST /tasks/:id/execute — trigger execution (owner only)
  // -------------------------------------------------------------------------

  router.post('/:id/execute', csrf, (req: Request, res: Response) => {
    // Rate-limit execution triggers per authenticated user to prevent DoS via
    // resource exhaustion (spawning too many concurrent tasks / runs).
    const userId = req.user!.id
    const rateDecision = executeRateLimiter.hit(userId)
    if (!rateDecision.allowed) {
      res.status(429).json(
        errorResponse(
          `Execution rate limit exceeded. Retry after ${rateDecision.retryAfterSeconds} seconds.`,
        ),
      )
      return
    }

    const task = store.getTask(req.params.id)
    if (!task || task.userId !== userId) {
      res.status(404).json(errorResponse('Task not found'))
      return
    }

    if (task.status === 'queued' || task.status === 'running') {
      res.status(409).json(
        errorResponse('Task is already queued or running. Wait for the current run to complete.'),
      )
      return
    }

    const run = store.createRun(task.id)
    if (!run) {
      // Shouldn't happen (we checked task exists), but guard defensively
      res.status(500).json(errorResponse('Failed to create task run'))
      return
    }

    store.updateTaskStatus(task.id, 'queued')

    // Kick off execution in the background; response returns immediately.
    // Pass the full (unsanitized) task so the executor can access credentials.
    launchExecution(task, run, store, options.executor)

    res.status(202).json(run)
  })

  // -------------------------------------------------------------------------
  // GET /tasks/:id/runs — list runs for a task (owner only)
  // -------------------------------------------------------------------------

  router.get('/:id/runs', (req: Request, res: Response) => {
    const task = store.getTask(req.params.id)
    if (!task || task.userId !== req.user!.id) {
      res.status(404).json(errorResponse('Task not found'))
      return
    }
    const runs = store.listRunsForTask(req.params.id)
    res.json({ runs, count: runs.length })
  })

  return router
}

// ---------------------------------------------------------------------------
// Runs router (/api/runs)
// ---------------------------------------------------------------------------

/**
 * Separate router for run-level endpoints (mounted at /api/runs).
 *
 * Authorization: each run lookup also checks that the owning task belongs to
 * the authenticated user so runs cannot be accessed cross-user by guessing IDs.
 */
export function createRunsRouter(store: TaskStore): Router {
  const router = Router()

  // GET /runs/:runId — get a single run with its logs (owner only)
  router.get('/:runId', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId)
    if (!run) {
      res.status(404).json(errorResponse('Run not found'))
      return
    }
    // Verify the caller owns the task this run belongs to
    const task = store.getTask(run.taskId)
    if (!task || task.userId !== req.user!.id) {
      res.status(404).json(errorResponse('Run not found'))
      return
    }
    res.json(run)
  })

  return router
}
