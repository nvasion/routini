/**
 * Routine Execution Engine
 *
 * Executes a routine's steps in sequential order, evaluating optional
 * conditions between steps and delegating per-step execution to the
 * appropriate handler.
 *
 * SECURITY: Conditions are evaluated by static regex matching — never via
 * eval() or new Function() — preventing code injection attacks.
 */

import type { Task, Routine, DevTask, TaskStatus } from '../types.js'

// ── Condition handling ────────────────────────────────────────────────────────

/** Status values permitted inside step conditions. */
const VALID_CONDITION_STATUSES = new Set<string>([
  'succeeded',
  'failed',
  'running',
  'queued',
  'idle',
])

/**
 * Matches the only two supported condition forms:
 *   previous.status === 'value'
 *   previous.status !== 'value'
 *
 * Single or double quotes are both accepted; extra whitespace around the
 * operator is tolerated.
 */
const CONDITION_RE = /^previous\.status\s*(===|!==)\s*["'](\w+)["']$/

/**
 * Validates a user-supplied step condition string.
 *
 * @returns null if the condition is absent or valid; otherwise an error
 *          message describing the problem.
 */
export function validateStepCondition(condition: string | undefined): string | null {
  if (condition === undefined || condition.trim() === '') return null

  const match = CONDITION_RE.exec(condition.trim())
  if (!match) {
    return (
      `Condition must match "previous.status === 'value'" or "previous.status !== 'value'". ` +
      `Got: "${condition}"`
    )
  }

  const statusValue = match[2]!
  if (!VALID_CONDITION_STATUSES.has(statusValue)) {
    return (
      `Condition references unknown status "${statusValue}". ` +
      `Allowed values: ${[...VALID_CONDITION_STATUSES].join(', ')}`
    )
  }

  return null
}

/**
 * Evaluates a step condition without eval().
 *
 * @returns true (allow the step to run) for unrecognised patterns — the
 *          engine fails open rather than silently skipping steps.
 */
export function evaluateCondition(
  condition: string,
  ctx: { previous: { status: TaskStatus } },
): boolean {
  const match = CONDITION_RE.exec(condition.trim())
  if (!match) return true // unrecognised → allow

  const [, op, value] = match
  if (op === '===') return ctx.previous.status === value
  if (op === '!==') return ctx.previous.status !== value
  return true
}

// ── Step executor ─────────────────────────────────────────────────────────────

/**
 * Executes a single routine step and returns its final TaskStatus.
 * Injectable for unit testing without Docker or network dependencies.
 */
export type RunStepFn = (
  task: Task,
  appendLog: (msg: string) => void,
) => Promise<TaskStatus>

export interface RoutineEngineOptions {
  /** Override the step executor (used in tests). */
  runStep?: RunStepFn
}

/**
 * Default step executor. Dispatches by task type:
 *   - daily:         simulated (no real SSH / email / HTTP infrastructure yet)
 *   - developmental: delegates to the Docker-based runDevTask service
 *   - routine:       rejected — nested routines would cause infinite recursion
 */
async function defaultRunStep(
  task: Task,
  appendLog: (msg: string) => void,
): Promise<TaskStatus> {
  if (task.type === 'routine') {
    appendLog('Nested routine steps are not supported — step skipped')
    return 'failed'
  }

  if (task.type === 'daily') {
    appendLog(`Executing daily task "${task.name}" (${task.actionType})`)
    // Simulation: real SSH / email / HTTP handlers are not wired up yet.
    // The engine still tracks status and respects downstream conditions.
    appendLog(`Daily task "${task.name}" completed (simulated)`)
    return 'succeeded'
  }

  // task.type === 'developmental'
  appendLog(`Executing developmental task "${task.name}"`)
  // Lazy import keeps Docker dependencies out of test bundles when runStep
  // is mocked, and prevents circular import issues at module load time.
  const { runDevTask } = await import('./devTask.js')
  const result = await runDevTask(task as DevTask)
  for (const line of result.logs) appendLog(line)
  if (result.success) {
    appendLog(`Task succeeded. Commit SHA: ${result.commitSha ?? 'n/a'}`)
    return 'succeeded'
  }
  appendLog(`Task failed: ${result.error ?? 'unknown error'}`)
  return 'failed'
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Executes a routine by running its steps in sequential order.
 *
 * Behaviour:
 *   - Steps are sorted by `order` before execution.
 *   - A step with a `condition` is only executed when the condition is true
 *     relative to the previous step's status. Skipped steps do not count as
 *     failures.
 *   - Steps that reference a task that no longer exists are treated as failures
 *     and logged; the engine continues to the next step.
 *   - Errors thrown by individual steps are caught and treated as failures so
 *     subsequent steps still run.
 *
 * @returns 'succeeded' if every executed step succeeded; 'failed' otherwise.
 */
export async function executeRoutine(
  routine: Routine,
  tasksMap: Map<string, Task>,
  appendLog: (routineId: string, message: string) => void,
  options: RoutineEngineOptions = {},
): Promise<TaskStatus> {
  const runStep = options.runStep ?? defaultRunStep

  const sortedSteps = [...routine.steps].sort((a, b) => a.order - b.order)

  appendLog(
    routine.id,
    `Starting routine "${routine.name}" — ${sortedSteps.length} step(s) to execute`,
  )

  let previousStatus: TaskStatus = 'succeeded'
  let anyFailed = false

  for (const step of sortedSteps) {
    const task = tasksMap.get(step.taskId)

    if (!task) {
      appendLog(
        routine.id,
        `[step ${step.order}] Referenced task "${step.taskId}" not found — step failed`,
      )
      previousStatus = 'failed'
      anyFailed = true
      continue
    }

    // Evaluate optional guard condition
    if (step.condition) {
      const shouldRun = evaluateCondition(step.condition, {
        previous: { status: previousStatus },
      })
      if (!shouldRun) {
        appendLog(
          routine.id,
          `[step ${step.order}] Condition not met ` +
            `("${step.condition}", previous=${previousStatus}) — skipping "${task.name}"`,
        )
        continue
      }
    }

    appendLog(
      routine.id,
      `[step ${step.order}] Executing "${task.name}" (${task.type})`,
    )

    try {
      previousStatus = await runStep(task, msg =>
        appendLog(routine.id, `[step ${step.order}] ${msg}`),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(
        routine.id,
        `[step ${step.order}] Unexpected error in "${task.name}": ${msg}`,
      )
      previousStatus = 'failed'
    }

    if (previousStatus !== 'succeeded') anyFailed = true

    appendLog(
      routine.id,
      `[step ${step.order}] "${task.name}" finished — status: ${previousStatus}`,
    )
  }

  const finalStatus: TaskStatus = anyFailed ? 'failed' : 'succeeded'
  appendLog(routine.id, `Routine "${routine.name}" completed — final status: ${finalStatus}`)
  return finalStatus
}
