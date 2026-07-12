import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { Task, TaskType, TaskStatus, DailyTask, DevTask, Routine } from '../types.js'

export const tasksRouter = Router()

// ── In-memory store (skeleton – no persistence) ───────────────────

export const tasks = new Map<string, Task>()

const VALID_TYPES: TaskType[] = ['daily', 'developmental', 'routine']
const VALID_STATUSES: TaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'idle']

// Seed data
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

// ── GET /api/tasks ────────────────────────────────────────────────

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

// ── GET /api/tasks/:id ───────────────────────────────────────────

tasksRouter.get('/:id', (req: Request, res: Response) => {
  const task = tasks.get(req.params.id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  res.json(task)
})

// ── POST /api/tasks ──────────────────────────────────────────────

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

    if (!repoUrl || typeof repoUrl !== 'string' || repoUrl.trim() === '') {
      res.status(400).json({ error: 'repoUrl is required for developmental tasks' })
      return
    }

    newTask = {
      ...base,
      type: 'developmental',
      repoUrl: repoUrl.trim(),
      branch: typeof branch === 'string' ? branch.trim() : 'main',
      agentId: typeof agentId === 'string' ? agentId.trim() : 'claude',
    }
  } else {
    // routine
    newTask = { ...base, type: 'routine', steps: [] }
  }

  tasks.set(newTask.id, newTask)
  res.status(201).json(newTask)
})

// ── PUT /api/tasks/:id ───────────────────────────────────────────

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

// ── DELETE /api/tasks/:id ────────────────────────────────────────

tasksRouter.delete('/:id', (req: Request, res: Response) => {
  if (!tasks.has(req.params.id)) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  tasks.delete(req.params.id)
  res.json({ message: 'Task deleted', id: req.params.id })
})

// ── POST /api/tasks/:id/trigger ──────────────────────────────────

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

  res.json({ message: 'Task triggered', task: triggered })
})
