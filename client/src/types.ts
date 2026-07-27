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
// Integrations (see PRD "Routini Integrations") — client-side mirror of the
// per-integration status shape returned by GET /api/integrations. Credential
// values themselves are write-only and never appear on this type: the server
// never serializes secrets into any response.
// ──────────────────────────────────────────────

export type IntegrationStatus = 'not_connected' | 'connected' | 'error'

/**
 * Server-enforced authorization scope for a connected integration: which
 * task types and which coding agents may use it at container-spawn time.
 * An empty array means "no task types/agents may use this integration" —
 * scoping is additive, not a placeholder for "all" (an unset/omitted
 * integration is already unusable by definition).
 */
export interface IntegrationScopes {
  taskTypes: TaskType[]
  agents: AIProvider[]
}

export interface Integration {
  id: string
  name: string
  status: IntegrationStatus
  /** ISO timestamp of when credentials were saved, or null when never connected. */
  connectedAt: string | null
  /** ISO timestamp of the most recent Test connection call, or null if never tested. */
  lastTestAt: string | null
  /** Result of the most recent test, or null if never tested. */
  lastTestOk: boolean | null
  scopes: IntegrationScopes
}
