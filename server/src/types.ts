// ──────────────────────────────────────────────
// Routini domain types – shared across the server
// ──────────────────────────────────────────────

export type TaskType = 'daily' | 'developmental' | 'routine'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'idle'
export type DailyActionType = 'ssh' | 'email' | 'http'
export type AIProvider = 'opencode' | 'claude' | 'omnimancer'

// ── Tasks ─────────────────────────────────────

interface BaseTask {
  id: string
  name: string
  description: string
  type: TaskType
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface DailyTask extends BaseTask {
  type: 'daily'
  /** cron expression, e.g. "0 9 * * *" */
  schedule: string
  actionType: DailyActionType
  /** action-specific key/value config (no secrets stored here) */
  config: Record<string, string>
}

export interface DevTask extends BaseTask {
  type: 'developmental'
  repoUrl: string
  branch: string
  agentId: string
  lastRunAt?: string
}

export interface RoutineStep {
  id: string
  taskId: string
  order: number
  condition?: string
}

export interface Routine extends BaseTask {
  type: 'routine'
  steps: RoutineStep[]
}

export type Task = DailyTask | DevTask | Routine

// ── Auth ──────────────────────────────────────

export interface User {
  id: string
  email: string
  createdAt: string
}

// ── Settings ──────────────────────────────────

export interface AISettings {
  provider: AIProvider | string
  model: string
  defaultAgentId: string
  /** True when an API key has been stored for the current provider; the key itself is never returned. */
  hasApiKey: boolean
}

/** Controls if and when email notifications are sent for task outcomes. */
export interface NotificationSettings {
  /** Master switch: no emails are sent when false. */
  enabled: boolean
  /** Destination email address for all notifications. */
  recipientEmail: string
  /** Notify when any task completes successfully. */
  notifyOnSuccess: boolean
  /** Notify when any task fails. */
  notifyOnFailure: boolean
  /** Notify whenever a routine completes (either status). */
  notifyOnRoutineMilestone: boolean
}

// ── Execution logs ────────────────────────────

/** A single timestamped log line produced during task execution. */
export interface TaskLog {
  timestamp: string
  message: string
}

// ── API helpers ───────────────────────────────

export interface ApiError {
  error: string
  details?: string
}
