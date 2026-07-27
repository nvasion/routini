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
// Integrations (server/src/routes/integrations.ts catalog)
// ──────────────────────────────────────────────

export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

/**
 * A single credential input an integration needs (e.g. a GitHub PAT, a Jira
 * site URL). `secret` fields render as password inputs and are write-only —
 * the server never returns their stored value, matching the AISettings
 * `hasApiKey` / daily-task `config` pattern used elsewhere in this app.
 */
export interface IntegrationField {
  /** Key this field is sent under in the PUT /api/integrations/:id payload. */
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
}

/** Which task types and coding agents are allowed to use a connected integration. */
export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: AIProvider[]
}

/**
 * One catalog entry as returned by GET /api/integrations: static metadata
 * (fields, setup link) merged with this user's connection state. Never
 * carries secret values — only whether/when a connection was made and
 * last tested.
 */
export interface Integration {
  id: string
  name: string
  description: string
  fields: IntegrationField[]
  /** Link to the provider's page for creating the credential (e.g. a token settings page). */
  setupUrl: string
  setupLabel: string
  status: IntegrationStatus
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}
