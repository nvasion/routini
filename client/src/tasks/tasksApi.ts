/**
 * Task API client.
 *
 * Provides typed wrappers for the task and run endpoints so page components
 * stay focused on rendering. All requests include `credentials: 'include'`
 * so the HttpOnly auth cookie is sent automatically.
 *
 * Error handling
 * ──────────────
 * All functions throw a `TasksApiError` on non-2xx responses. The error
 * carries the HTTP status, the top-level `error` message, and any `details`
 * array returned by the server so callers can surface structured feedback.
 */

// ---------------------------------------------------------------------------
// Client-side type definitions
//
// These mirror the server-side types (server/src/tasks/types.ts) but live here
// so the client bundle never pulls in server code. Keep them in sync if the
// server types change.
// ---------------------------------------------------------------------------

export type TaskType = 'daily' | 'developmental' | 'routine'
export type TaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface RoutineStep {
  taskId: string
  condition?: string
}

interface BaseTask {
  id: string
  userId: string
  name: string
  type: TaskType
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface DailyTask extends BaseTask {
  type: 'daily'
  subtype: string
}

export interface DevelopmentalTask extends BaseTask {
  type: 'developmental'
  repoUrl: string
  agentName: string
  branchName: string
}

export interface RoutineTask extends BaseTask {
  type: 'routine'
  steps: RoutineStep[]
}

export type Task = DailyTask | DevelopmentalTask | RoutineTask

export interface LogEntry {
  timestamp: string
  message: string
  level: 'info' | 'warn' | 'error'
}

export interface TaskRun {
  id: string
  taskId: string
  status: RunStatus
  startedAt: string
  completedAt?: string
  logs: LogEntry[]
  error?: string
}

// ---------------------------------------------------------------------------
// Condition helpers
// ---------------------------------------------------------------------------

/** Preset condition values for the routine builder UI. */
export const CONDITION_PRESETS = [
  { label: '(Always run — no condition)', value: '' },
  { label: 'Only if previous step succeeded', value: "previous.status === 'succeeded'" },
  { label: 'Only if previous step failed', value: "previous.status === 'failed'" },
  { label: 'Skip if previous step succeeded', value: "previous.status !== 'succeeded'" },
  { label: 'Skip if previous step failed', value: "previous.status !== 'failed'" },
] as const

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

interface ErrorBody {
  error?: string
  details?: string[]
}

export class TasksApiError extends Error {
  readonly status: number
  readonly details: string[]

  constructor(status: number, message: string, details: string[] = []) {
    super(message)
    this.name = 'TasksApiError'
    this.status = status
    this.details = details
  }
}

async function extractError(res: Response, fallback: string): Promise<TasksApiError> {
  let body: ErrorBody | null = null
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    /* fall through */
  }
  const message =
    body && typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback
  const details = body && Array.isArray(body.details) ? body.details : []
  return new TasksApiError(res.status, message, details)
}

// ---------------------------------------------------------------------------
// Base fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { credentials: 'include', ...init })
}

// ---------------------------------------------------------------------------
// Response parsers — runtime shape validation
//
// TypeScript casts (`as { tasks: Task[] }`) are compile-time only and provide
// zero runtime protection. If the server returns a malformed body (missing
// key, wrong type, proxy HTML page, unexpected 2xx error shape, etc.) the
// TypeScript cast silently produces `undefined` at runtime. A caller that
// then calls `.map()` or `.filter()` on that `undefined` value crashes with
// an unhandled TypeError that bubbles all the way to the browser console.
//
// These validators enforce the shape contract at runtime: they throw a
// `TasksApiError` on any invalid body so callers can catch-and-display the
// error rather than letting an undefined value leak into React state.
//
// Exported so they can be unit-tested in isolation (no DOM / React needed).
// ---------------------------------------------------------------------------

/**
 * Assert that a parsed API response body has the `{ tasks: Task[] }` shape.
 * Throws `TasksApiError` when the shape contract is violated.
 */
export function parseTasksResponse(data: unknown): Task[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { tasks?: unknown }).tasks)
  ) {
    throw new TasksApiError(
      200,
      'Unexpected server response: "tasks" is missing or not an array',
    )
  }
  return (data as { tasks: Task[] }).tasks
}

/**
 * Assert that a parsed API response body has the `{ runs: TaskRun[] }` shape.
 * Throws `TasksApiError` when the shape contract is violated.
 */
export function parseRunsResponse(data: unknown): TaskRun[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { runs?: unknown }).runs)
  ) {
    throw new TasksApiError(
      200,
      'Unexpected server response: "runs" is missing or not an array',
    )
  }
  return (data as { runs: TaskRun[] }).runs
}

// ---------------------------------------------------------------------------
// Task endpoints
// ---------------------------------------------------------------------------

/**
 * List tasks owned by the authenticated user, optionally filtered by type.
 */
export async function listTasks(type?: TaskType): Promise<Task[]> {
  const url = type != null ? `/api/tasks?type=${encodeURIComponent(type)}` : '/api/tasks'
  const res = await apiFetch(url)
  if (!res.ok) throw await extractError(res, 'Failed to fetch tasks')
  return parseTasksResponse(await res.json())
}

/**
 * Fetch a single task by ID.
 */
export async function getTask(id: string): Promise<Task> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`)
  if (!res.ok) throw await extractError(res, 'Task not found')
  return (await res.json()) as Task
}

// ---------------------------------------------------------------------------
// Routine-specific mutations
// ---------------------------------------------------------------------------

export interface CreateRoutineInput {
  name: string
  steps: RoutineStep[]
}

/**
 * Create a new routine task.
 */
export async function createRoutineTask(input: CreateRoutineInput): Promise<RoutineTask> {
  const res = await apiFetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'routine', ...input }),
  })
  if (!res.ok) throw await extractError(res, 'Failed to create routine')
  return (await res.json()) as RoutineTask
}

export interface UpdateRoutineInput {
  name?: string
  steps?: RoutineStep[]
}

/**
 * Partially update an existing routine task (name and/or steps).
 */
export async function updateRoutineTask(
  id: string,
  patch: UpdateRoutineInput,
): Promise<RoutineTask> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await extractError(res, 'Failed to update routine')
  return (await res.json()) as RoutineTask
}

/**
 * Trigger execution of any task and return the initial TaskRun.
 */
export async function executeTask(id: string): Promise<TaskRun> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw await extractError(res, 'Failed to execute task')
  return (await res.json()) as TaskRun
}

/**
 * Delete a task (and all of its runs).
 */
export async function deleteTask(id: string): Promise<void> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw await extractError(res, 'Failed to delete task')
}

/**
 * List runs for a specific task.
 */
export async function listRuns(taskId: string): Promise<TaskRun[]> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/runs`)
  if (!res.ok) throw await extractError(res, 'Failed to fetch runs')
  return parseRunsResponse(await res.json())
}
