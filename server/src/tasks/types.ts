/**
 * TypeScript interfaces for the task domain.
 *
 * Three task kinds are supported:
 *  - daily        : simple automated actions (SSH command, email check, HTTP fetch)
 *  - developmental: ephemeral AI coding job run in a Docker container
 *  - routine      : multi-step workflow that combines daily + developmental tasks
 */

// ---------------------------------------------------------------------------
// Enums / union literals
// ---------------------------------------------------------------------------

export type TaskType = 'daily' | 'developmental' | 'routine'

/** Typed constant of all valid task type strings (use instead of inline arrays). */
export const VALID_TASK_TYPES: TaskType[] = ['daily', 'developmental', 'routine']
export type DailySubtype = 'ssh' | 'email' | 'http'
export type AgentName = 'opencode' | 'claude-code' | 'omnimancer'
export type TaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD'
export type ScheduleType = 'manual' | 'cron'
export type LogLevel = 'info' | 'warn' | 'error'

// ---------------------------------------------------------------------------
// Sub-configs for daily tasks
// ---------------------------------------------------------------------------

export interface ScheduleConfig {
  type: ScheduleType
  /** Required when type is 'cron'. Standard five-field cron expression. */
  cron?: string
}

export interface SshConfig {
  host: string
  port?: number
  username: string
  command: string
  /**
   * Optional SSH password for password-based authentication.
   *
   * SECURITY: This field is write-only from the client's perspective. Route
   * handlers MUST strip it from all API responses (see sanitizeTask() in
   * tasks/routes.ts) to prevent credential leakage. Production deployments
   * that persist tasks to a database MUST encrypt this field at rest using
   * AES-256 or equivalent, with keys managed by a dedicated KMS.
   */
  password?: string
  /**
   * Optional PEM-encoded SSH private key for key-based authentication.
   *
   * SECURITY: Same restrictions as `password` — write-only in responses,
   * encrypted at rest in production storage.
   */
  privateKey?: string
}

export interface EmailConfig {
  host: string
  port?: number
  username: string
  /** IMAP folder to inspect. Defaults to INBOX when omitted. */
  folder?: string
  /**
   * IMAP account password.
   *
   * SECURITY: Write-only from the client's perspective. Route handlers MUST
   * strip this from all API responses (see sanitizeTask() in tasks/routes.ts).
   * Production deployments MUST encrypt this field at rest.
   */
  password?: string
}

export interface HttpConfig {
  url: string
  method?: HttpMethod
  /** Optional request headers. Keys and values must be plain strings. */
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Task entities
// ---------------------------------------------------------------------------

export interface BaseTask {
  id: string
  /** ID of the user who owns this task. Used to enforce per-user access control. */
  userId: string
  name: string
  type: TaskType
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface DailyTask extends BaseTask {
  type: 'daily'
  subtype: DailySubtype
  config: SshConfig | EmailConfig | HttpConfig
  schedule: ScheduleConfig
}

export interface DevelopmentalTask extends BaseTask {
  type: 'developmental'
  repoUrl: string
  agentName: AgentName
  branchName: string
}

export interface RoutineStep {
  taskId: string
  /** Optional conditional expression evaluated at runtime (e.g. "previous.status === 'succeeded'"). */
  condition?: string
}

export interface RoutineTask extends BaseTask {
  type: 'routine'
  steps: RoutineStep[]
}

export type Task = DailyTask | DevelopmentalTask | RoutineTask

// ---------------------------------------------------------------------------
// Task run (one execution attempt)
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string
  message: string
  level: LogLevel
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
// Create / update input shapes
// ---------------------------------------------------------------------------

export interface CreateDailyTaskInput {
  type: 'daily'
  /** Owning user id — injected by the route handler from req.user; never from the request body. */
  userId: string
  name: string
  subtype: DailySubtype
  config: SshConfig | EmailConfig | HttpConfig
  schedule?: ScheduleConfig
}

export interface CreateDevelopmentalTaskInput {
  type: 'developmental'
  /** Owning user id — injected by the route handler from req.user; never from the request body. */
  userId: string
  name: string
  repoUrl: string
  agentName: AgentName
  branchName?: string
}

export interface CreateRoutineTaskInput {
  type: 'routine'
  /** Owning user id — injected by the route handler from req.user; never from the request body. */
  userId: string
  name: string
  steps: RoutineStep[]
}

export type CreateTaskInput =
  | CreateDailyTaskInput
  | CreateDevelopmentalTaskInput
  | CreateRoutineTaskInput

export interface UpdateDailyTaskInput {
  name?: string
  subtype?: DailySubtype
  config?: SshConfig | EmailConfig | HttpConfig
  schedule?: ScheduleConfig
}

export interface UpdateDevelopmentalTaskInput {
  name?: string
  repoUrl?: string
  agentName?: AgentName
  branchName?: string
}

export interface UpdateRoutineTaskInput {
  name?: string
  steps?: RoutineStep[]
}
