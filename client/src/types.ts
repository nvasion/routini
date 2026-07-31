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

/**
 * Model endpoints a coding agent can talk to. 'gateway' points Claude Code at
 * a claude-code-model-gateway instance, which opens ALL endpoints behind one
 * URL (mirror of server/src/types.ts).
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
  endpoint: AIEndpoint
  model: string
  /** Base URL of a claude-code-model-gateway instance; required when endpoint is 'gateway'. */
  gatewayUrl?: string
}

export interface AISettings {
  provider: AIProvider | string
  model: string
  defaultAgentId: string
  /** True when an API key has been stored; the key itself is never returned by the server. */
  hasApiKey: boolean
  /** Endpoint configuration per coding agent (claude / opencode / omnimancer). */
  agents: Record<string, AgentEndpointConfig>
  /** Which endpoints have an API key stored; the keys themselves are never returned. */
  endpointKeys: Record<string, boolean>
}
