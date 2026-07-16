import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type {
  Task,
  TaskType,
  TaskStatus,
  DailyTask,
  DevTask,
  Routine,
  RoutineStep,
  TaskLog,
} from '../types.js'
import { runDevTask, validateRepoUrl, validateAgentId, VALID_AGENTS } from '../services/devTask.js'
import { executeRoutine, validateStepCondition } from '../services/routineEngine.js'
import { sendTaskOutcomeNotification, createTransporter } from '../services/email.js'
import { notificationSettings } from './notifications.js'
import { requireCsrf } from './auth.js'

export const tasksRouter = Router()

// ── In-memory stores (skeleton – no persistence) ─────────────────────────────

export const tasks = new Map<string, Task>()

/**
 * Execution logs per task ID.
 * Each entry is an ordered list of timestamped log lines.
 * Logs are appended during and after container execution.
 */
export const taskLogs = new Map<string, TaskLog[]>()

const VALID_TYPES: TaskType[] = ['daily', 'developmental', 'routine']
const VALID_STATUSES: TaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'idle']

/** Maximum number of steps a single routine may have. */
const MAX_STEPS = 20

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLog(taskId: string, message: string): void {
  const list = taskLogs.get(taskId) ?? []
  list.push({ timestamp: new Date().toISOString(), message })
  taskLogs.set(taskId, list)
}

// ── Notification helper ───────────────────────────────────────────────────────

/**
 * Dispatches an email notification for a completed task when the current
 * notification settings require it.
 *
 * Rules:
 *   – `enabled` must be true.
 *   – `recipientEmail` must be present.
 *   – Routine completions trigger an email when `notifyOnRoutineMilestone` is set
 *     (regardless of the success/failure flags).
 *   – All other tasks trigger an email when `notifyOnSuccess` (status="succeeded")
 *     or `notifyOnFailure` (status="failed") matches.
 *
 * Errors from the transport are caught and logged; they must not propagate and
 * crash the background execution loop.
 */
async function notifyOutcome(task: Task): Promise<void> {
  const settings = notificationSettings

  if (!settings.enabled || !settings.recipientEmail) return

  const { status, type } = task

  const shouldNotify =
    (type === 'routine' && settings.notifyOnRoutineMilestone) ||
    (status === 'succeeded' && settings.notifyOnSuccess) ||
    (status === 'failed' && settings.notifyOnFailure)

  if (!shouldNotify) return

  try {
    await sendTaskOutcomeNotification(
      {
        taskId: task.id,
        taskName: task.name,
        taskType: type,
        status,
        timestamp: new Date().toISOString(),
      },
      settings.recipientEmail,
      createTransporter(),
    )
  } catch (err) {
    // Log but never re-throw — notification failures must not surface as task
    // failures or crash the execution loop.  Log without forwarding err.message
    // because transport errors may embed SMTP credentials.
    console.error(`[notifications] Failed to send email for task ${task.id}`, err)
  }
}

// ── Seed data ─────────────────────────────────────────────────────────────────

function seedData(): void {
  const now = new Date().toISOString()

  const daily: DailyTask = {
    id: randomUUID(),
    name: 'Daily Health Check',
    description: 'Checks server health via HTTP request',
    type: 'daily',
    status: 'idle',
    schedule: '0 9 * * *',
    actionType: 'http',
    config: { url: 'https://example.com/health', method: 'GET' },
    createdAt: now,
    updatedAt: now,
  }

  const dev: DevTask = {
    id: randomUUID(),
    name: 'Code Review Bot',
    description: 'Runs automated code review using a configured AI agent',
    type: 'developmental',
    status: 'idle',
    repoUrl: 'https://github.com/example/repo',
    branch: 'feature/auto-review',
    agentId: 'claude',
    createdAt: now,
    updatedAt: now,
  }

  const routine: Routine = {
    id: randomUUID(),
    name: 'Morning Workflow',
    description: 'Health check then code review if all clear',
    type: 'routine',
    status: 'idle',
    steps: [
      { id: randomUUID(), taskId: daily.id, order: 1 },
      { id: randomUUID(), taskId: dev.id, order: 2, condition: 'previous.status === "succeeded"' },
    ],
    createdAt: now,
    updatedAt: now,
  }

  tasks.set(daily.id, daily)
  tasks.set(dev.id, dev)
  tasks.set(routine.id, routine)
}

seedData()

// ── GET /api/tasks ────────────────────────────────────────────────────────────

tasksRouter.get('/', (req: Request, res: Response) => {
  const { type, status } = req.query

  if (type !== undefined && !VALID_TYPES.includes(type as TaskType)) {
    res.status(400).json({ error: `Invalid task type. Must be one of: ${VALID_TYPES.join(', ')}` })
    return
  }

  if (status !== undefined && !VALID_STATUSES.includes(status as TaskStatus)) {
    res.status(400).json({ error: `Invalid task status. Must be one of: ${VALID_STATUSES.join(', ')}` })
    return
  }

  let result = [...tasks.values()]

  if (type) result = result.filter(t => t.type === type)
  if (status) result = result.filter(t => t.status === status)

  res.json({ tasks: result, count: result.length })
})

// ── GET /api/tasks/:id ────────────────────────────────────────────────────────

tasksRouter.get('/:id', (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  res.json(task)
})

// ── POST /api/tasks ───────────────────────────────────────────────────────────

tasksRouter.post('/', requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const { name, description, type } = body

  if (!name || typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ error: 'Task name is required' })
    return
  }

  if (!type) {
    res.status(400).json({ error: 'Task type is required' })
    return
  }

  if (!VALID_TYPES.includes(type as TaskType)) {
    res.status(400).json({ error: `Task type must be one of: ${VALID_TYPES.join(', ')}` })
    return
  }

  const now = new Date().toISOString()
  const base = {
    id: randomUUID(),
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    type: type as TaskType,
    status: 'idle' as TaskStatus,
    createdAt: now,
    updatedAt: now,
  }

  let newTask: Task

  if (type === 'daily') {
    const { schedule = '0 9 * * *', actionType = 'http', config = {} } = body
    newTask = {
      ...base,
      type: 'daily',
      schedule: typeof schedule === 'string' ? schedule : '0 9 * * *',
      actionType: (actionType as DailyTask['actionType']) ?? 'http',
      config: (config as Record<string, string>) ?? {},
    }
  } else if (type === 'developmental') {
    const { repoUrl, branch = 'main', agentId = 'claude' } = body

    // Reject missing or non-string value before URL parsing.
    if (!repoUrl || typeof repoUrl !== 'string') {
      res.status(400).json({ error: 'repoUrl is required for developmental tasks' })
      return
    }

    // Validate the URL is safe (https, known host, no credentials) to catch
    // problems early and prevent SSRF when the task is later triggered.
    const repoCheck = validateRepoUrl(repoUrl)
    if (!repoCheck.valid) {
      res.status(400).json({ error: repoCheck.error })
      return
    }

    // Validate the agent ID references a supported AI agent.
    const resolvedAgent = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'claude'
    if (!validateAgentId(resolvedAgent)) {
      res.status(400).json({
        error: `Unsupported agentId "${resolvedAgent}". Must be one of: ${[...VALID_AGENTS].join(', ')}`,
      })
      return
    }

    newTask = {
      ...base,
      type: 'developmental',
      repoUrl: repoUrl.trim(),
      branch: typeof branch === 'string' ? branch.trim() : 'main',
      agentId: resolvedAgent,
    }
  } else {
    // routine — steps are managed separately via PUT /api/tasks/:id/steps
    newTask = { ...base, type: 'routine', steps: [] }
  }

  tasks.set(newTask.id, newTask)
  res.status(201).json(newTask)
})

// ── PUT /api/tasks/:id ────────────────────────────────────────────────────────

tasksRouter.put('/:id', requireCsrf, (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  const body = req.body as Record<string, unknown>
  const { name, description } = body

  const updated: Task = {
    ...task,
    ...(name !== undefined &&
      typeof name === 'string' &&
      name.trim() !== '' && { name: name.trim() }),
    ...(description !== undefined && { description: String(description).trim() }),
    updatedAt: new Date().toISOString(),
  }

  tasks.set(updated.id, updated)
  res.json(updated)
})

// ── PUT /api/tasks/:id/steps ──────────────────────────────────────────────────

/**
 * Replaces all steps of a routine task.
 *
 * Validation rules:
 *   - Task must exist and be of type 'routine'.
 *   - `steps` must be an array with at most MAX_STEPS elements.
 *   - Each step needs a valid `taskId` referencing an existing, non-self task.
 *   - `order` must be a unique positive integer per step.
 *   - `condition` (optional) must match the supported condition pattern.
 *
 * On success the full updated routine is returned.
 */
tasksRouter.put('/:id/steps', requireCsrf, (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  if (task.type !== 'routine') {
    res.status(400).json({ error: 'Steps can only be set on routine tasks' })
    return
  }

  const { steps: rawSteps } = req.body as { steps: unknown }

  if (!Array.isArray(rawSteps)) {
    res.status(400).json({ error: 'steps must be an array' })
    return
  }

  if (rawSteps.length > MAX_STEPS) {
    res.status(400).json({ error: `Routine cannot have more than ${MAX_STEPS} steps` })
    return
  }

  const validatedSteps: RoutineStep[] = []
  const seenOrders = new Set<number>()

  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i]

    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      res.status(400).json({ error: `Step ${i}: each step must be an object` })
      return
    }

    const step = s as Record<string, unknown>

    // taskId validation
    const taskId = step['taskId']
    if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
      res.status(400).json({ error: `Step ${i}: taskId is required` })
      return
    }
    const trimmedTaskId = taskId.trim()
    if (!tasks.has(trimmedTaskId)) {
      res.status(400).json({ error: `Step ${i}: task "${trimmedTaskId}" not found` })
      return
    }
    if (trimmedTaskId === req.params.id) {
      res.status(400).json({ error: `Step ${i}: routine cannot reference itself` })
      return
    }

    // order validation
    const rawOrder = step['order']
    const order = Number(rawOrder)
    if (!Number.isInteger(order) || order < 1) {
      res.status(400).json({ error: `Step ${i}: order must be a positive integer` })
      return
    }
    if (seenOrders.has(order)) {
      res.status(400).json({ error: `Step ${i}: duplicate order value ${order}` })
      return
    }
    seenOrders.add(order)

    // condition validation (optional)
    const rawCondition = step['condition']
    let condition: string | undefined
    if (rawCondition !== undefined && rawCondition !== null) {
      const condStr = String(rawCondition).trim()
      if (condStr !== '') {
        const condErr = validateStepCondition(condStr)
        if (condErr) {
          res.status(400).json({ error: `Step ${i}: ${condErr}` })
          return
        }
        condition = condStr
      }
    }

    // Preserve existing step IDs if provided; otherwise generate new ones.
    const stepId =
      typeof step['id'] === 'string' && step['id'].trim() !== ''
        ? step['id'].trim()
        : randomUUID()

    validatedSteps.push({
      id: stepId,
      taskId: trimmedTaskId,
      order,
      ...(condition !== undefined ? { condition } : {}),
    })
  }

  const updated: Routine = {
    ...(task as Routine),
    steps: validatedSteps,
    updatedAt: new Date().toISOString(),
  }

  tasks.set(updated.id, updated)
  res.json(updated)
})

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────

tasksRouter.delete('/:id', requireCsrf, (req: Request, res: Response) => {
  if (!tasks.has(req.params.id)) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  tasks.delete(req.params.id)
  taskLogs.delete(req.params.id) // remove associated logs
  res.json({ message: 'Task deleted', id: req.params.id })
})

// ── POST /api/tasks/:id/trigger ───────────────────────────────────────────────

tasksRouter.post('/:id/trigger', requireCsrf, (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  if (task.status === 'running') {
    res.status(409).json({ error: 'Task is already running' })
    return
  }

  const triggered: Task = { ...task, status: 'queued', updatedAt: new Date().toISOString() }
  tasks.set(triggered.id, triggered)

  // Respond immediately — execution is async and may take minutes.
  res.json({ message: 'Task triggered', task: triggered })

  // Fire-and-forget: execute tasks in the background.
  if (triggered.type === 'developmental') {
    void executeDevTask(triggered as DevTask)
  } else if (triggered.type === 'routine') {
    void executeRoutineTask(triggered as Routine)
  }
})

// ── GET /api/tasks/:id/logs ───────────────────────────────────────────────────

tasksRouter.get('/:id/logs', (req: Request, res: Response) => {
  if (!tasks.has(req.params.id)) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  const logs = taskLogs.get(req.params.id) ?? []
  res.json({ logs, count: logs.length })
})

// ── Background execution ──────────────────────────────────────────────────────

/**
 * Runs a developmental task container and keeps the in-memory task record
 * and log store in sync throughout the lifecycle:
 *
 *   queued → running → succeeded | failed
 *
 * This function is intentionally fire-and-forget from the trigger route.
 * Errors are caught and reflected in task status rather than thrown.
 */
async function executeDevTask(task: DevTask): Promise<void> {
  // Transition to 'running' before the container starts.
  const running: Task = { ...task, status: 'running', updatedAt: new Date().toISOString() }
  tasks.set(running.id, running)
  appendLog(task.id, 'Starting developmental task container…')

  try {
    const result = await runDevTask(task)

    // Append all container log lines as individual TaskLog entries.
    for (const line of result.logs) {
      appendLog(task.id, line)
    }

    if (result.success) {
      appendLog(task.id, `Container finished successfully. Commit SHA: ${result.commitSha ?? 'n/a'}`)
      const succeeded: DevTask = {
        ...(tasks.get(task.id) as DevTask ?? task),
        status: 'succeeded',
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      tasks.set(succeeded.id, succeeded)
      await notifyOutcome(succeeded)
    } else {
      appendLog(task.id, `Container failed: ${result.error ?? 'unknown error'}`)
      const failed: DevTask = {
        ...(tasks.get(task.id) as DevTask ?? task),
        status: 'failed',
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      tasks.set(failed.id, failed)
      await notifyOutcome(failed)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(task.id, `Unexpected error during execution: ${msg}`)
    const failed: Task = {
      ...(tasks.get(task.id) ?? task),
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }
    tasks.set(failed.id, failed)
    await notifyOutcome(failed)
  }
}

/**
 * Runs a routine's steps in sequence using the routine engine.
 *
 * Lifecycle:
 *   queued → running → succeeded | failed
 *
 * Errors from individual steps are caught by the engine and reflected in
 * per-step logs. If an unhandled error escapes the engine, it is caught
 * here and the routine is marked as failed.
 */
async function executeRoutineTask(routine: Routine): Promise<void> {
  const running: Routine = {
    ...routine,
    status: 'running',
    updatedAt: new Date().toISOString(),
  }
  tasks.set(running.id, running)
  appendLog(routine.id, 'Routine execution starting…')

  try {
    const finalStatus = await executeRoutine(routine, tasks, appendLog)

    const finished: Routine = {
      ...(tasks.get(routine.id) as Routine ?? routine),
      status: finalStatus,
      updatedAt: new Date().toISOString(),
    }
    tasks.set(finished.id, finished)
    await notifyOutcome(finished)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(routine.id, `Unexpected error during routine execution: ${msg}`)
    const failed: Routine = {
      ...(tasks.get(routine.id) as Routine ?? routine),
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }
    tasks.set(failed.id, failed)
    await notifyOutcome(failed)
  }
}
