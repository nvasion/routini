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
  /**
   * ID of the user who created this task.
   * Undefined for system/seed tasks, which are visible to all authenticated users.
   * All tasks created via the API are tagged with the creator's user ID.
   */
  ownerId?: string
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

/**
 * Write-only view of a DailyTask's `config` for API responses that must not
 * echo back the values a client just wrote (e.g. the response to
 * `PUT /api/tasks/:id`). Each configured key is present, mapped to `true`,
 * so callers can confirm what was set without the value being readable back
 * over the API.
 */
export type SanitizedDailyConfig = Record<string, true>

/** DailyTask API response shape where `config` has been reduced to key names only. */
export interface DailyTaskResponse extends Omit<DailyTask, 'config'> {
  config: SanitizedDailyConfig
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

/**
 * Model endpoints a coding agent can talk to.
 *
 * 'gateway' is special: it points Claude Code at a claude-code-model-gateway
 * instance (Anthropic-Messages-API proxy) via ANTHROPIC_BASE_URL, which opens
 * ALL endpoints (anthropic, openai, openrouter, google, bedrock, azure,
 * DigitalOcean inference, local) behind a single URL.
 */
export type AIEndpoint =
  | 'anthropic'
  | 'openrouter'
  | 'digitalocean'
  | 'aws-bedrock'
  | 'openai'
  | 'google'
  | 'azure'
  | 'gateway'

/** Per-coding-agent endpoint configuration. */
export interface AgentEndpointConfig {
  /** Which endpoint this agent's model calls go to. */
  endpoint: AIEndpoint
  /** Model identifier understood by the chosen endpoint. */
  model: string
  /** Base URL of a claude-code-model-gateway instance; required when endpoint is 'gateway'. */
  gatewayUrl?: string
}

export interface AISettings {
  provider: AIProvider | string
  model: string
  defaultAgentId: string
  /** True when an API key has been stored for the current provider; the key itself is never returned. */
  hasApiKey: boolean
  /** Endpoint configuration per coding agent (claude / opencode / omnimancer). */
  agents: Record<string, AgentEndpointConfig>
  /** Which endpoints have an API key stored; the keys themselves are never returned. */
  endpointKeys: Record<string, boolean>
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
