/**
 * In-memory TaskStore.
 *
 * Provides CRUD for tasks and task runs. All data lives in process memory —
 * swap this implementation for a persistent backend (Postgres, Redis, …)
 * when durability is required. The interface stays the same so callers
 * (routes, tests) are unaffected.
 *
 * SECURITY NOTE — sensitive fields at rest:
 * Task configs may contain credential fields (SshConfig.password,
 * SshConfig.privateKey, EmailConfig.password). In this in-memory
 * implementation they live in the process heap and are never written to disk.
 * Any persistent replacement MUST:
 *   1. Encrypt these fields with AES-256-GCM (or equivalent) before writing.
 *   2. Store encryption keys in a dedicated KMS — never co-located with data.
 *   3. Redact them from query logs and audit trails.
 * The route layer (sanitizeTask in tasks/routes.ts) ensures these fields are
 * never returned to API clients regardless of the storage backend.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentName,
  CreateDailyTaskInput,
  CreateDevelopmentalTaskInput,
  CreateRoutineTaskInput,
  DailyTask,
  DevelopmentalTask,
  LogEntry,
  RoutineTask,
  RunStatus,
  ScheduleConfig,
  Task,
  TaskRun,
  TaskStatus,
  TaskType,
  UpdateDailyTaskInput,
  UpdateDevelopmentalTaskInput,
  UpdateRoutineTaskInput,
} from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateTaskResult {
  task: Task
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export class TaskStore {
  private readonly tasks = new Map<string, Task>()
  private readonly runs = new Map<string, TaskRun>()

  /**
   * Run IDs per task — maintained separately so listing runs for a task is
   * O(runs) rather than a full scan of the runs map.
   */
  private readonly taskRunIds = new Map<string, string[]>()

  // -------------------------------------------------------------------------
  // Task CRUD
  // -------------------------------------------------------------------------

  createDailyTask(input: CreateDailyTaskInput): DailyTask {
    const now = new Date().toISOString()
    const task: DailyTask = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      type: 'daily',
      subtype: input.subtype,
      config: input.config,
      schedule: input.schedule ?? { type: 'manual' },
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    this.taskRunIds.set(task.id, [])
    return task
  }

  createDevelopmentalTask(input: CreateDevelopmentalTaskInput): DevelopmentalTask {
    const now = new Date().toISOString()
    const task: DevelopmentalTask = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      type: 'developmental',
      repoUrl: input.repoUrl,
      agentName: input.agentName,
      branchName: input.branchName ?? `auto/${randomUUID().slice(0, 8)}`,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    this.taskRunIds.set(task.id, [])
    return task
  }

  createRoutineTask(input: CreateRoutineTaskInput): RoutineTask {
    const now = new Date().toISOString()
    const task: RoutineTask = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      type: 'routine',
      steps: input.steps,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    this.taskRunIds.set(task.id, [])
    return task
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /**
   * List tasks, optionally filtered by type and/or owning userId.
   * Pass `userId` to restrict results to a single user's tasks (required for
   * all user-facing endpoints to enforce per-user data isolation).
   */
  listTasks(type?: TaskType, userId?: string): Task[] {
    let result = [...this.tasks.values()]
    if (type !== undefined) {
      result = result.filter((t) => t.type === type)
    }
    if (userId !== undefined) {
      result = result.filter((t) => t.userId === userId)
    }
    return result
  }

  /**
   * Apply a partial update to a task. Returns the updated task, or `undefined`
   * if no task with that `id` exists.
   *
   * Fields that callers may NOT update via this method (they are system-managed):
   *   id, type, createdAt
   */
  updateDailyTask(id: string, patch: UpdateDailyTaskInput): Task | undefined {
    const existing = this.tasks.get(id)
    if (!existing || existing.type !== 'daily') return undefined

    const updated: DailyTask = {
      ...existing,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.subtype !== undefined && { subtype: patch.subtype }),
      ...(patch.config !== undefined && { config: patch.config }),
      ...(patch.schedule !== undefined && { schedule: patch.schedule as ScheduleConfig }),
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  updateDevelopmentalTask(id: string, patch: UpdateDevelopmentalTaskInput): Task | undefined {
    const existing = this.tasks.get(id)
    if (!existing || existing.type !== 'developmental') return undefined

    const updated: DevelopmentalTask = {
      ...existing,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.repoUrl !== undefined && { repoUrl: patch.repoUrl }),
      ...(patch.agentName !== undefined && { agentName: patch.agentName as AgentName }),
      ...(patch.branchName !== undefined && { branchName: patch.branchName }),
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  updateRoutineTask(id: string, patch: UpdateRoutineTaskInput): Task | undefined {
    const existing = this.tasks.get(id)
    if (!existing || existing.type !== 'routine') return undefined

    const updated: RoutineTask = {
      ...existing,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.steps !== undefined && { steps: patch.steps }),
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  /**
   * Update only the status field of any task (used by the executor).
   */
  updateTaskStatus(id: string, status: TaskStatus): Task | undefined {
    const existing = this.tasks.get(id)
    if (!existing) return undefined
    const updated = { ...existing, status, updatedAt: new Date().toISOString() }
    this.tasks.set(id, updated)
    return updated
  }

  /**
   * Remove a task and all of its associated runs.
   * Returns `true` if the task existed and was deleted, `false` if not found.
   */
  deleteTask(id: string): boolean {
    if (!this.tasks.has(id)) return false
    this.tasks.delete(id)
    const runIds = this.taskRunIds.get(id) ?? []
    for (const runId of runIds) {
      this.runs.delete(runId)
    }
    this.taskRunIds.delete(id)
    return true
  }

  // -------------------------------------------------------------------------
  // Run management
  // -------------------------------------------------------------------------

  /**
   * Create a new run for the given task. Returns `undefined` if the task does
   * not exist (so callers can surface a 404 without an extra store.getTask call).
   */
  createRun(taskId: string): TaskRun | undefined {
    if (!this.tasks.has(taskId)) return undefined
    const run: TaskRun = {
      id: randomUUID(),
      taskId,
      status: 'queued',
      startedAt: new Date().toISOString(),
      logs: [],
    }
    this.runs.set(run.id, run)
    const ids = this.taskRunIds.get(taskId) ?? []
    ids.push(run.id)
    this.taskRunIds.set(taskId, ids)
    return run
  }

  updateRun(
    runId: string,
    patch: {
      status?: RunStatus
      completedAt?: string
      error?: string
    },
  ): TaskRun | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    const updated: TaskRun = { ...run, ...patch }
    this.runs.set(runId, updated)
    return updated
  }

  appendRunLog(runId: string, entry: LogEntry): TaskRun | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    const updated: TaskRun = { ...run, logs: [...run.logs, entry] }
    this.runs.set(runId, updated)
    return updated
  }

  getRun(runId: string): TaskRun | undefined {
    return this.runs.get(runId)
  }

  listRunsForTask(taskId: string): TaskRun[] {
    const ids = this.taskRunIds.get(taskId) ?? []
    return ids.flatMap((id) => {
      const run = this.runs.get(id)
      return run ? [run] : []
    })
  }
}
