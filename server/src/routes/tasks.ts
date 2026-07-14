import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { Task, TaskType, TaskStatus, DailyTask, DevTask, Routine, TaskLog } from '../types.js'
import { runDevTask, validateRepoUrl, validateAgentId, VALID_AGENTS } from '../services/devTask.js'

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLog(taskId: string, message: string): void {
  const list = taskLogs.get(taskId) ?? []
  list.push({ timestamp: new Date().toISOString(), message })
  taskLogs.set(taskId, list)
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

tasksRouter.post('/', (req: Request, res: Response) => {
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
    // routine
    newTask = { ...base, type: 'routine', steps: [] }
  }

  tasks.set(newTask.id, newTask)
  res.status(201).json(newTask)
})

// ── PUT /api/tasks/:id ────────────────────────────────────────────────────────

tasksRouter.put('/:id', (req: Request, res: Response) => {
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

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────

tasksRouter.delete('/:id', (req: Request, res: Response) => {
  if (!tasks.has(req.params.id)) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  tasks.delete(req.params.id)
  taskLogs.delete(req.params.id) // remove associated logs
  res.json({ message: 'Task deleted', id: req.params.id })
})

// ── POST /api/tasks/:id/trigger ───────────────────────────────────────────────

tasksRouter.post('/:id/trigger', (req: Request, res: Response) => {
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

  // Respond immediately — the container run is async and may take minutes.
  res.json({ message: 'Task triggered', task: triggered })

  // Fire-and-forget: execute developmental tasks in the background.
  if (triggered.type === 'developmental') {
    void executeDevTask(triggered as DevTask)
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
    } else {
      appendLog(task.id, `Container failed: ${result.error ?? 'unknown error'}`)
      const failed: DevTask = {
        ...(tasks.get(task.id) as DevTask ?? task),
        status: 'failed',
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      tasks.set(failed.id, failed)
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
  }
}
