// ─────────────────────────────────────────────────────────────────────────────
// Org settings (tenant table): AI endpoints per agent, notifications.
//
// Model API keys are secrets, so they live in the credential store under
// `ai.key.<endpoint>`; settings only report which endpoints have one.
// Patches are validated completely before anything is written.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import { AGENT_IDS, type AgentId } from '../integrations/catalog.js'
import { getSecret, listSecrets, putSecret } from './credentials.js'

export const AI_ENDPOINTS = ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'openai', 'google', 'azure', 'gateway'] as const
export type AIEndpoint = (typeof AI_ENDPOINTS)[number]
/** Endpoints that take an API key (the gateway authenticates on its own). */
export const KEYED_ENDPOINTS = AI_ENDPOINTS.filter((e) => e !== 'gateway')

/**
 * Which endpoints each agent can reach. Claude Code speaks the Anthropic
 * Messages API and Bedrock natively; it reaches the rest through
 * claude-code-model-gateway.
 */
export const AGENT_ALLOWED_ENDPOINTS: Record<AgentId, readonly AIEndpoint[]> = {
  claude: ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'gateway'],
  opencode: ['anthropic', 'openai', 'openrouter'],
  omnimancer: AI_ENDPOINTS.filter((e) => e !== 'gateway'),
}

export interface AgentEndpointConfig {
  endpoint: AIEndpoint
  /** Model id for the endpoint; empty string = the agent's own default. */
  model: string
  gatewayUrl?: string
  /** AWS region, for the aws-bedrock endpoint. */
  region?: string
}

export interface AiSettings {
  defaultAgent: AgentId
  agents: Record<AgentId, AgentEndpointConfig>
}

export interface NotificationSettings {
  enabled: boolean
  recipientEmail: string
  notifyOnSuccess: boolean
  notifyOnFailure: boolean
}

export interface OrgSettings {
  ai: AiSettings
  notifications: NotificationSettings
  /** Which endpoints have a stored API key. Keys themselves are never returned. */
  endpointKeys: Record<string, boolean>
}

export const DEFAULT_AI: AiSettings = {
  defaultAgent: 'claude',
  agents: {
    claude: { endpoint: 'anthropic', model: '' },
    opencode: { endpoint: 'openrouter', model: '' },
    omnimancer: { endpoint: 'openrouter', model: '' },
  },
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: false,
  recipientEmail: '',
  notifyOnSuccess: false,
  notifyOnFailure: true,
}

/** e.g. us-east-1, eu-central-2, us-gov-west-1. Also keeps the Bedrock hostnames derived from it safe. */
export const AWS_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/

export const aiKeyName =(endpoint: string) => `ai.key.${endpoint}`

export class SettingsValidationError extends Error {}

const fail = (msg: string): never => {
  throw new SettingsValidationError(msg)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function mergeAi(stored: unknown): AiSettings {
  const s = isObj(stored) ? stored : {}
  const agents = { ...DEFAULT_AI.agents }
  if (isObj(s['agents'])) {
    for (const id of AGENT_IDS) {
      const a = (s['agents'] as Record<string, unknown>)[id]
      if (isObj(a)) agents[id] = { ...agents[id], ...(a as Partial<AgentEndpointConfig>) }
    }
  }
  const defaultAgent = AGENT_IDS.includes(s['defaultAgent'] as AgentId) ? (s['defaultAgent'] as AgentId) : DEFAULT_AI.defaultAgent
  return { defaultAgent, agents }
}

function mergeNotifications(stored: unknown): NotificationSettings {
  return { ...DEFAULT_NOTIFICATIONS, ...(isObj(stored) ? (stored as Partial<NotificationSettings>) : {}) }
}

export async function getOrgSettings(q: Queryable, orgId: string): Promise<OrgSettings> {
  const [row] = await q.query<{ ai: unknown; notifications: unknown }>(
    'SELECT ai, notifications FROM org_settings WHERE org_id = $1',
    [orgId],
  )
  const stored = new Set((await listSecrets(q, orgId, 'ai.key.')).map((m) => m.key))
  return {
    ai: mergeAi(row?.ai),
    notifications: mergeNotifications(row?.notifications),
    endpointKeys: Object.fromEntries(KEYED_ENDPOINTS.map((e) => [e, stored.has(aiKeyName(e))])),
  }
}

export interface SettingsPatch {
  ai?: AiSettings
  notifications?: NotificationSettings
  endpointApiKeys?: Record<string, string>
}

/** Validates a raw PUT body against the current settings. Throws SettingsValidationError. */
export function parseSettingsPatch(raw: unknown, current: OrgSettings): SettingsPatch {
  if (!isObj(raw)) fail('Body must be an object')
  const body = raw as Record<string, unknown>
  const patch: SettingsPatch = {}

  if (body['ai'] !== undefined) {
    if (!isObj(body['ai'])) fail('ai must be an object')
    const ai = body['ai'] as Record<string, unknown>
    const next: AiSettings = { defaultAgent: current.ai.defaultAgent, agents: { ...current.ai.agents } }
    if (ai['defaultAgent'] !== undefined) {
      if (!AGENT_IDS.includes(ai['defaultAgent'] as AgentId)) fail(`ai.defaultAgent must be one of: ${AGENT_IDS.join(', ')}`)
      next.defaultAgent = ai['defaultAgent'] as AgentId
    }
    if (ai['agents'] !== undefined) {
      if (!isObj(ai['agents'])) fail('ai.agents must be an object')
      for (const [agentId, cfgRaw] of Object.entries(ai['agents'] as Record<string, unknown>)) {
        if (!AGENT_IDS.includes(agentId as AgentId)) fail(`Unknown agent "${agentId}". Must be one of: ${AGENT_IDS.join(', ')}`)
        if (!isObj(cfgRaw)) fail(`ai.agents.${agentId} must be an object`)
        const cfg = cfgRaw as Record<string, unknown>
        const id = agentId as AgentId
        const merged: AgentEndpointConfig = { ...next.agents[id] }
        if (cfg['endpoint'] !== undefined) {
          const allowed = AGENT_ALLOWED_ENDPOINTS[id]
          if (!allowed.includes(cfg['endpoint'] as AIEndpoint)) {
            fail(`Endpoint "${String(cfg['endpoint'])}" is not available to agent "${id}". Allowed: ${allowed.join(', ')}`)
          }
          merged.endpoint = cfg['endpoint'] as AIEndpoint
        }
        if (cfg['model'] !== undefined) {
          if (typeof cfg['model'] !== 'string' || cfg['model'].length > 200) fail(`ai.agents.${id}.model must be a string of at most 200 chars`)
          merged.model = (cfg['model'] as string).trim()
        }
        if (cfg['gatewayUrl'] !== undefined) {
          if (typeof cfg['gatewayUrl'] !== 'string') fail(`ai.agents.${id}.gatewayUrl must be a string`)
          merged.gatewayUrl = (cfg['gatewayUrl'] as string).trim()
        }
        if (cfg['region'] !== undefined) {
          if (typeof cfg['region'] !== 'string') fail(`ai.agents.${id}.region must be a string`)
          merged.region = (cfg['region'] as string).trim()
          if (merged.region && !AWS_REGION_RE.test(merged.region)) fail(`ai.agents.${id}.region must be an AWS region such as us-east-1`)
        }
        if (id === 'claude' && merged.endpoint === 'aws-bedrock' && !merged.region) {
          fail(`ai.agents.${id}: the aws-bedrock endpoint requires a region`)
        }
        if (merged.endpoint === 'gateway') {
          let ok = false
          try {
            const u = new URL(merged.gatewayUrl ?? '')
            ok = u.protocol === 'http:' || u.protocol === 'https:'
          } catch {
            ok = false
          }
          if (!ok) fail(`ai.agents.${id}: the gateway endpoint requires a valid http(s) gatewayUrl`)
        }
        next.agents[id] = merged
      }
    }
    patch.ai = next
  }

  if (body['notifications'] !== undefined) {
    if (!isObj(body['notifications'])) fail('notifications must be an object')
    const n = body['notifications'] as Record<string, unknown>
    const next: NotificationSettings = { ...current.notifications }
    for (const key of ['enabled', 'notifyOnSuccess', 'notifyOnFailure'] as const) {
      if (n[key] !== undefined) {
        if (typeof n[key] !== 'boolean') fail(`notifications.${key} must be a boolean`)
        next[key] = n[key] as boolean
      }
    }
    if (n['recipientEmail'] !== undefined) {
      const e = n['recipientEmail']
      if (typeof e !== 'string' || (e !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) || e.length > 254) {
        fail('notifications.recipientEmail must be a valid email address')
      }
      next.recipientEmail = (e as string).trim()
    }
    if (next.enabled && !next.recipientEmail) fail('notifications.recipientEmail is required when notifications are enabled')
    patch.notifications = next
  }

  if (body['endpointApiKeys'] !== undefined) {
    if (!isObj(body['endpointApiKeys'])) fail('endpointApiKeys must be an object')
    const keys: Record<string, string> = {}
    for (const [endpoint, value] of Object.entries(body['endpointApiKeys'] as Record<string, unknown>)) {
      if (!(KEYED_ENDPOINTS as readonly string[]).includes(endpoint)) {
        fail(`Unknown endpoint "${endpoint}". Must be one of: ${KEYED_ENDPOINTS.join(', ')}`)
      }
      if (typeof value !== 'string' || value.trim() === '') fail(`endpointApiKeys.${endpoint} must be a non-empty string`)
      keys[endpoint] = (value as string).trim()
    }
    patch.endpointApiKeys = keys
  }

  return patch
}

export async function applySettingsPatch(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  userId: string,
  patch: SettingsPatch,
): Promise<void> {
  if (patch.ai || patch.notifications) {
    await q.query(
      `INSERT INTO org_settings (org_id, ai, notifications) VALUES ($1, coalesce($2::jsonb, '{}'), coalesce($3::jsonb, '{}'))
       ON CONFLICT (org_id) DO UPDATE SET
         ai = coalesce($2::jsonb, org_settings.ai),
         notifications = coalesce($3::jsonb, org_settings.notifications),
         updated_at = now()`,
      [orgId, patch.ai ? JSON.stringify(patch.ai) : null, patch.notifications ? JSON.stringify(patch.notifications) : null],
    )
  }
  for (const [endpoint, value] of Object.entries(patch.endpointApiKeys ?? {})) {
    await putSecret(q, box, orgId, aiKeyName(endpoint), value, userId)
  }
}

/** Decrypted API key for an endpoint (server-side use only, e.g. agent spawn). */
export async function getEndpointKey(q: Queryable, box: SecretBox, orgId: string, endpoint: string): Promise<string | null> {
  return getSecret(q, box, orgId, aiKeyName(endpoint))
}
