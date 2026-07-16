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
import { taskEvents } from '../services/taskEvents.js'
import type { TaskLogEvent } from '../services/taskEvents.js'

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

/**
 * Regex patterns used to detect and redact secrets in log output.
 *
 * Each entry is a [pattern, replacement] tuple applied in order.  Patterns
 * are intentionally broad so they catch common credential formats seen in
 * SSH output, container stdout, and HTTP client error messages.
 *
 * Sensitive formats matched:
 *  - Bearer / Authorization header values
 *  - Common API-key prefixes (sk-, pk-, api-, key-)
 *  - Passwords embedded in URIs (proto://user:password@host)
 *  - Key=value credential pairs (password=, passwd=, secret=, token=, api_key=)
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer token in Authorization headers or log output
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  // Well-known API key prefixes (OpenAI sk-, Stripe pk-, etc.)
  [/\b(sk|pk|api|key)-[A-Za-z0-9]{8,}/gi, '[REDACTED]'],
  // Password in URI: proto://user:password@host  →  proto://user:[REDACTED]@host
  [/(:\/\/[^:@\s]+:)[^@\s]+(@)/g, '$1[REDACTED]$2'],
  // key=value credential pairs (case-insensitive)
  [/\b(password|passwd|secret|token|api_key|apikey)\s*=\s*\S+/gi, '$1=[REDACTED]'],
]

/**
 * Returns a copy of `message` with common secret patterns replaced by
 * [REDACTED].  Applied to every log line before it is stored or broadcast
 * to SSE clients, preventing credential leakage via execution output.
 */
function sanitizeLogMessage(message: string): string {
  let result = message
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * Produces a client-safe copy of a task for SSE transmission.
 *
 * Strips all server-internal and potentially sensitive fields before the task
 * leaves the server boundary.  This is the single serialization gate: any
 * sensitive field added to the Task type in the future MUST be handled here
 * (either deleted or explicitly redacted).
 *
 * Fields removed:
 *  - `ownerId`  – internal authorization field; must never reach the client.
 *  - `config`   – DailyTask action config may contain SSH credentials, HTTP
 *                 basic-auth passwords, or API tokens depending on actionType.
 *                 Strip the entire object; the UI uses status/name, not config.
 */
function sanitizeTaskForClient(task: Task): unknown {
  const copy: Record<string, unknown> = { ...(task as unknown as Record<string, unknown>) }
  // Internal authorization field — never expose to clients.
  delete copy['ownerId']
  // May contain SSH keys, API tokens, or passwords (DailyTask.config).
  delete copy['config']
  return copy
}

/**
 * Appends a timestamped log line to a task's log list and broadcasts a
 * 'task:log' event to all SSE subscribers.
 *
 * The message is passed through `sanitizeLogMessage` before storage so that
 * secrets captured in SSH output, container stdout, or error messages are
 * never persisted or transmitted to clients.
 *
 * Exported for testing; internal callers should always prefer this function
 * over writing to `taskLogs` directly.
 */
export function appendLog(taskId: string, message: string): void {
  const log: TaskLog = { timestamp: new Date().toISOString(), message: sanitizeLogMessage(message) }
  const list = taskLogs.get(taskId) ?? []
  list.push(log)
  taskLogs.set(taskId, list)
  taskEvents.emitTaskLog(taskId, log)
}

/**
 * Persists a task to the in-memory store and broadcasts a 'task:updated' event
 * to all SSE subscribers. Use this instead of calling tasks.set() directly
 * whenever the task state changes so that SSE clients stay in sync.
 */
function setTaskAndNotify(task: Task): void {
  tasks.set(task.id, task)
  taskEvents.emitTaskUpdated(task)
}

/**
 * Write a single SSE frame (event + data) to the response stream.
 * No-op when the connection has already ended to avoid write-after-close errors.
 */
function writeSseEvent(res: Response, event: string, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

/**
 * Returns true if the authenticated user is permitted to see this task.
 *
 * Tasks without an ownerId are system/seed tasks visible to all authenticated
 * users. Tasks with an ownerId are private to their creator.
 */
function userCanSeeTask(task: Task, userId: string): boolean {
  return !task.ownerId || task.ownerId === userId
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

// ── GET /api/tasks/events ─────────────────────────────────────────────────────
//
// Server-Sent Events endpoint that streams real-time task updates to all
// connected clients. Registered *before* GET /:id so the literal path
// "events" is never matched by the dynamic :id parameter.
//
// On connect the server sends a 'connected' event with a snapshot of all
// current tasks so clients can initialize their local state without a
// separate HTTP request.  Subsequent 'task:updated' events are sent
// whenever a task's status or data changes; 'task:log' events carry new
// execution log lines.  A heartbeat comment is sent every 15 seconds to
// keep the connection alive through proxies and load balancers.

tasksRouter.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Disable nginx proxy buffering so events reach the browser immediately.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Capture the authenticated user's ID for ownership checks throughout this
  // connection's lifetime. req.user is guaranteed by requireAuth.
  const userId = req.user!.id

  // Send an initial snapshot filtered to tasks the authenticated user may see.
  // Sanitize each task to strip server-internal fields (e.g. ownerId) before
  // transmitting to the client.
  const userTasks = [...tasks.values()]
    .filter(t => userCanSeeTask(t, userId))
    .map(sanitizeTaskForClient)
  writeSseEvent(res, 'connected', { tasks: userTasks })

  // Per-connection event listeners — only forward events for tasks this user owns
  // (or system tasks with no ownerId). ownerId is checked on the emitted task
  // object directly; in production all tasks carry their creator's ownerId.
  const onTaskUpdated = (task: Task): void => {
    if (userCanSeeTask(task, userId)) {
      writeSseEvent(res, 'task:updated', sanitizeTaskForClient(task))
    }
  }

  const onTaskLog = (payload: TaskLogEvent): void => {
    // Resolve ownership via the canonical store entry so we never rely solely
    // on the emitted object (which may be a test mock without ownerId).
    const logTask = tasks.get(payload.taskId)
    if (logTask && userCanSeeTask(logTask, userId)) {
      writeSseEvent(res, 'task:log', payload)
    }
  }

  taskEvents.on('task:updated', onTaskUpdated)
  taskEvents.on('task:log', onTaskLog)

  // Heartbeat: keeps the TCP connection alive through proxies that close
  // idle connections, and allows the server to detect dead clients early.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n')
    }
  }, 15_000)

  // Cleanup when the client disconnects (tab close, navigation, network drop).
  req.on('close', () => {
    clearInterval(heartbeat)
    taskEvents.off('task:updated', onTaskUpdated)
    taskEvents.off('task:log', onTaskLog)
  })
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

// ── GET /api/tasks/:id/events ─────────────────────────────────────────────────
//
// Scoped SSE endpoint for a single task. Sends only events relevant to the
// specified task ID.  The initial 'connected' event includes the current task
// state and its full execution log history so the client can render a detail
// view without a separate HTTP fetch.

tasksRouter.get('/:id/events', (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  // Enforce ownership: only the task creator (or all users for system tasks)
  // may subscribe to per-task SSE events. Return 403 rather than 404 so the
  // client can distinguish "not found" from "access denied".
  if (!userCanSeeTask(task, req.user!.id)) {
    res.status(403).json({ error: 'Access denied' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const { id } = req.params

  // Initial snapshot: sanitized task state + all existing log lines.
  writeSseEvent(res, 'connected', {
    task: sanitizeTaskForClient(task),
    logs: taskLogs.get(id) ?? [],
  })

  const onTaskUpdated = (updatedTask: Task): void => {
    if (updatedTask.id === id) {
      writeSseEvent(res, 'task:updated', sanitizeTaskForClient(updatedTask))
    }
  }
  const onTaskLog = (payload: TaskLogEvent): void => {
    if (payload.taskId === id) {
      writeSseEvent(res, 'task:log', payload)
    }
  }

  taskEvents.on('task:updated', onTaskUpdated)
  taskEvents.on('task:log', onTaskLog)

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n')
    }
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    taskEvents.off('task:updated', onTaskUpdated)
    taskEvents.off('task:log', onTaskLog)
  })
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
    // Tag every new task with the creator's user ID so SSE streams and future
    // authorization checks can enforce per-user data isolation.
    ownerId: req.user!.id,
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

  // Persist and broadcast so SSE clients see the new task immediately.
  setTaskAndNotify(newTask)
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

  setTaskAndNotify(updated)
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

  setTaskAndNotify(updated)
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
  setTaskAndNotify(triggered)

  // Respond immediately — execution is async and may take minutes.
  res.json({ message: 'Task triggered', task: triggered })

  // Fire-and-forget: execute tasks in the background.
  if (triggered.type === 'developmental') {
    void executeDevTask(triggered as DevTask)
  } else if (triggered.type === 'routine') {
    void executeRoutineTask(triggered as Routine)
  }
})

// ── Background execution ──────────────────────────────────────────────────────

/**
 * Runs a developmental task container and keeps the in-memory task record
 * and log store in sync throughout the lifecycle:
 *
 *   queued → running → succeeded | failed
 *
 * Every status transition is broadcast to SSE clients via setTaskAndNotify,
 * and every log line is broadcast via appendLog → taskEvents.emitTaskLog.
 * This function is intentionally fire-and-forget from the trigger route.
 * Errors are caught and reflected in task status rather than thrown.
 */
async function executeDevTask(task: DevTask): Promise<void> {
  // Transition to 'running' before the container starts.
  const running: Task = { ...task, status: 'running', updatedAt: new Date().toISOString() }
  setTaskAndNotify(running)
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
      setTaskAndNotify(succeeded)
    } else {
      appendLog(task.id, `Container failed: ${result.error ?? 'unknown error'}`)
      const failed: DevTask = {
        ...(tasks.get(task.id) as DevTask ?? task),
        status: 'failed',
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      setTaskAndNotify(failed)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(task.id, `Unexpected error during execution: ${msg}`)
    const failed: Task = {
      ...(tasks.get(task.id) ?? task),
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }
    setTaskAndNotify(failed)
  }
}

/**
 * Runs a routine's steps in sequence using the routine engine.
 *
 * Lifecycle:
 *   queued → running → succeeded | failed
 *
 * Every status transition is broadcast to SSE clients via setTaskAndNotify.
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
  setTaskAndNotify(running)
  appendLog(routine.id, 'Routine execution starting…')

  try {
    const finalStatus = await executeRoutine(routine, tasks, appendLog)

    const finished: Routine = {
      ...(tasks.get(routine.id) as Routine ?? routine),
      status: finalStatus,
      updatedAt: new Date().toISOString(),
    }
    setTaskAndNotify(finished)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(routine.id, `Unexpected error during routine execution: ${msg}`)
    const failed: Routine = {
      ...(tasks.get(routine.id) as Routine ?? routine),
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }
    setTaskAndNotify(failed)
  }
}
