// ──────────────────────────────────────────────
// Routini domain types – client-side mirror of server/src/types.ts
// ──────────────────────────────────────────────

export type TaskType = 'daily' | 'developmental' | 'routine'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'idle'
export type DailyActionType = 'ssh' | 'email' | 'http'
export type AIProvider = 'opencode' | 'claude' | 'omnimancer'

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
  schedule: string
  actionType: DailyActionType
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

export interface User {
  id: string
  email: string
  createdAt: string
}

export interface AISettings {
  provider: AIProvider | string
  model: string
  defaultAgentId: string
  /** True when an API key has been stored; the key itself is never returned by the server. */
  hasApiKey: boolean
}

// ──────────────────────────────────────────────
// Integrations (see PRD: Routini Integrations)
// ──────────────────────────────────────────────

/** The seven v1 credential-based integrations. */
export type IntegrationId =
  | 'github'
  | 'slack'
  | 'jira'
  | 'notion'
  | 'linear'
  | 'monday'
  | 'hubspot'

/**
 * Connection status as computed server-side:
 *  - 'not_connected' — no credentials stored yet
 *  - 'connected'      — credentials stored and the last test (if any) succeeded
 *  - 'error'          — credentials stored but the last test connection failed
 */
export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

/** Describes one write-only credential field the connect modal must collect. */
export interface IntegrationField {
  key: string
  label: string
  /** True for secrets (tokens/keys) — rendered as a password input, never pre-filled. */
  secret: boolean
  required: boolean
}

/** Server-enforced scoping: which task types and agents may use this integration. */
export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: AIProvider[]
}

/**
 * A single catalog entry as returned by GET /api/integrations. Never contains
 * secrets — only metadata about whether/when the integration was connected
 * and tested.
 */
export interface Integration {
  id: IntegrationId
  name: string
  description: string
  /** Link to the provider's token/setup page, shown in the connect modal. */
  setupUrl: string
  fields: IntegrationField[]
  status: IntegrationStatus
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}
