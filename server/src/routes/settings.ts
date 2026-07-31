import { Router, Request, Response } from 'express'
import type { AISettings, AIEndpoint, AgentEndpointConfig } from '../types.js'
import { requireCsrf } from './auth.js'
import {
  saveCredential,
  getCredentialSecret,
  removeCredential,
} from '../services/credentials.js'

export const settingsRouter = Router()

// ── Endpoint catalog ──────────────────────────────────────────────
//
// Which endpoints each coding agent may talk to.  Claude Code natively
// speaks the Anthropic Messages API, so on its own it reaches Anthropic,
// AWS Bedrock, and the OpenRouter / DigitalOcean inference bridges — but
// pointed at a claude-code-model-gateway instance ('gateway') ALL endpoints
// open up behind one URL.  Omnimancer is natively multi-provider and is open
// to every endpoint; OpenRouter itself is an aggregator open to all agents.

export const AI_ENDPOINTS: AIEndpoint[] = [
  'anthropic',
  'openrouter',
  'digitalocean',
  'aws-bedrock',
  'openai',
  'google',
  'azure',
  'gateway',
]

export const AGENT_ALLOWED_ENDPOINTS: Record<string, AIEndpoint[]> = {
  // "For now" list per product decision — gateway unlocks the rest.
  claude: ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'gateway'],
  opencode: ['anthropic', 'openai', 'openrouter'],
  // Omnimancer talks to providers natively — every endpoint except the
  // gateway (it does not need one and never routes through it).
  omnimancer: AI_ENDPOINTS.filter(e => e !== 'gateway'),
}

const DEFAULT_AGENT_CONFIGS: Record<string, AgentEndpointConfig> = {
  claude: { endpoint: 'anthropic', model: 'claude-opus-4-5' },
  opencode: { endpoint: 'openrouter', model: '' },
  omnimancer: { endpoint: 'openrouter', model: '' },
}

/** Credential-store name for a per-endpoint API key. */
const endpointCredentialName = (endpoint: string): string => `ai_api_key_${endpoint}`

// ── Credential store integration ──────────────────────────────────
//
// The AI API key is persisted via the encrypted credential store service
// (server/src/services/credentials.ts, AES-256-GCM at rest) so it survives
// server restarts and is never stored in plaintext on disk.  The settings
// document (provider/model/defaultAgentId) remains in memory because it is
// non-secret configuration; only the API key — a secret — goes through the
// credential store.
//
// The API key is stored under the "system" scope (null userId) because the AI
// settings are a single global configuration shared by all authenticated
// users, mirroring the single global `currentSettings` object.
const API_KEY_CREDENTIAL_NAME = 'ai_api_key'

// ── In-memory settings ────────────────────────────────────────────

export let currentSettings: AISettings = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  defaultAgentId: 'claude',
  hasApiKey: false,
  agents: { ...DEFAULT_AGENT_CONFIGS },
  endpointKeys: Object.fromEntries(AI_ENDPOINTS.filter(e => e !== 'gateway').map(e => [e, false])),
}

/**
 * API key held in memory so it is never accidentally serialised into the
 * settings response.  The credential store is the source of truth for
 * persistence; this export mirrors the decrypted value for in-process
 * consumers and tests.
 *
 * Exported so tests can verify state between runs; never exposed via the
 * HTTP API.  On module load we hydrate it from the credential store (best
 * effort — a missing or unavailable store simply means no key is loaded).
 */
export let storedApiKey: string | null = null

// ── Hydrate from the credential store on load ─────────────────────
//
// Reading at import time lets a freshly started server report hasApiKey
// correctly for a key that was stored in a previous process.  Any failure
// (e.g. the DB module is unavailable during isolated development) is
// swallowed so the server still boots; the key is simply treated as absent.

try {
  const existing = getCredentialSecret(null, API_KEY_CREDENTIAL_NAME)
  if (existing) {
    storedApiKey = existing
    currentSettings = { ...currentSettings, hasApiKey: true }
  }
  // Hydrate the per-endpoint key presence map from the credential store.
  const endpointKeys = { ...currentSettings.endpointKeys }
  for (const endpoint of Object.keys(endpointKeys)) {
    endpointKeys[endpoint] = Boolean(getCredentialSecret(null, endpointCredentialName(endpoint)))
  }
  currentSettings = { ...currentSettings, endpointKeys }
} catch (err) {
  // The credential store / DB may be unavailable in some isolated
  // development setups; degrade gracefully rather than crashing startup.
  // The error is logged server-side only — never surfaced to clients and
  // never includes the secret material.
  console.error(
    '[settings] unable to load persisted AI API key from credential store:',
    (err as Error).message,
  )
}

// ── GET /api/settings ─────────────────────────────────────────────

settingsRouter.get('/', (_req: Request, res: Response) => {
  // Never include secrets (API keys, tokens) in responses.
  res.json(currentSettings)
})

// ── PUT /api/settings ─────────────────────────────────────────────

settingsRouter.put('/', requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const { provider, model, defaultAgentId, apiKey, agents, endpointApiKeys } = body

  // ── Per-agent endpoint configuration ────────────────────────────
  //
  // Accepts a partial map: { claude: { endpoint, model?, gatewayUrl? }, ... }.
  // Each agent may only select an endpoint from its allow-list; the gateway
  // endpoint additionally requires a valid http(s) gatewayUrl.
  if (agents !== undefined) {
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
      res.status(400).json({ error: 'agents must be an object' })
      return
    }

    const updatedAgents = { ...currentSettings.agents }

    for (const [agentId, rawConfig] of Object.entries(agents as Record<string, unknown>)) {
      const allowed = AGENT_ALLOWED_ENDPOINTS[agentId]
      if (!allowed) {
        res.status(400).json({
          error: `Unknown agent "${agentId}". Must be one of: ${Object.keys(AGENT_ALLOWED_ENDPOINTS).join(', ')}`,
        })
        return
      }
      if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
        res.status(400).json({ error: `agents.${agentId} must be an object` })
        return
      }

      const config = rawConfig as Record<string, unknown>
      const current = updatedAgents[agentId] ?? DEFAULT_AGENT_CONFIGS[agentId]
      const next: AgentEndpointConfig = { ...current }

      if (config['endpoint'] !== undefined) {
        const endpoint = config['endpoint']
        if (typeof endpoint !== 'string' || !allowed.includes(endpoint as AIEndpoint)) {
          res.status(400).json({
            error: `Endpoint "${String(endpoint)}" is not available to agent "${agentId}". Allowed: ${allowed.join(', ')}`,
          })
          return
        }
        next.endpoint = endpoint as AIEndpoint
      }

      if (config['model'] !== undefined) {
        if (typeof config['model'] !== 'string') {
          res.status(400).json({ error: `agents.${agentId}.model must be a string` })
          return
        }
        next.model = config['model'].trim()
      }

      if (config['gatewayUrl'] !== undefined) {
        if (typeof config['gatewayUrl'] !== 'string') {
          res.status(400).json({ error: `agents.${agentId}.gatewayUrl must be a string` })
          return
        }
        next.gatewayUrl = config['gatewayUrl'].trim()
      }

      if (next.endpoint === 'gateway') {
        let parsed: URL | null = null
        try {
          parsed = new URL(next.gatewayUrl ?? '')
        } catch {
          parsed = null
        }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          res.status(400).json({
            error: `agents.${agentId}: the gateway endpoint requires a valid http(s) gatewayUrl (e.g. http://gateway-host:8080)`,
          })
          return
        }
      }

      updatedAgents[agentId] = next
    }

    currentSettings = { ...currentSettings, agents: updatedAgents }
  }

  // ── Per-endpoint API keys (write-only) ──────────────────────────
  //
  // Accepts { anthropic: "sk-…", openrouter: "…" }.  Keys are persisted in
  // the encrypted credential store under ai_api_key_<endpoint> and are never
  // echoed back; endpointKeys only reports which endpoints have one.
  if (endpointApiKeys !== undefined) {
    if (!endpointApiKeys || typeof endpointApiKeys !== 'object' || Array.isArray(endpointApiKeys)) {
      res.status(400).json({ error: 'endpointApiKeys must be an object' })
      return
    }

    const keyableEndpoints: AIEndpoint[] = AI_ENDPOINTS.filter(e => e !== 'gateway')
    const entries = Object.entries(endpointApiKeys as Record<string, unknown>)

    for (const [endpoint, value] of entries) {
      if (!keyableEndpoints.includes(endpoint as AIEndpoint)) {
        res.status(400).json({
          error: `Unknown endpoint "${endpoint}". Must be one of: ${keyableEndpoints.join(', ')}`,
        })
        return
      }
      if (typeof value !== 'string' || value.trim() === '') {
        res.status(400).json({ error: `endpointApiKeys.${endpoint} must be a non-empty string` })
        return
      }
    }

    const updatedKeys = { ...currentSettings.endpointKeys }
    try {
      for (const [endpoint, value] of entries) {
        const name = endpointCredentialName(endpoint)
        removeCredential(null, name)
        saveCredential(null, name, (value as string).trim())
        updatedKeys[endpoint] = true
      }
    } catch (err) {
      console.error(
        '[settings] failed to persist endpoint API key to credential store:',
        (err as Error).message,
      )
      res.status(500).json({ error: 'Failed to persist API key' })
      return
    }
    currentSettings = { ...currentSettings, endpointKeys: updatedKeys }
  }

  if (provider !== undefined) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      res.status(400).json({ error: 'provider must be a non-empty string' })
      return
    }
    currentSettings = { ...currentSettings, provider: provider.trim() }
  }

  if (model !== undefined) {
    if (typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string' })
      return
    }
    currentSettings = { ...currentSettings, model: model.trim() }
  }

  if (defaultAgentId !== undefined) {
    if (typeof defaultAgentId !== 'string') {
      res.status(400).json({ error: 'defaultAgentId must be a string' })
      return
    }
    currentSettings = { ...currentSettings, defaultAgentId: defaultAgentId.trim() }
  }

  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      res.status(400).json({ error: 'apiKey must be a non-empty string' })
      return
    }
    // Persist the key through the encrypted credential store so it is
    // encrypted at rest (AES-256-GCM) and survives server restarts.  Keep the
    // in-memory mirror in sync so the `storedApiKey` export reflects the
    // current value and the key is never included in currentSettings (which
    // would risk it being serialised and returned in GET responses).
    const trimmedKey = apiKey.trim()
    try {
      // Replace any previously stored key for this scope.  Removing first
      // guarantees a clean INSERT (the credential store keys the row by a
      // deterministic id, so an existing row would otherwise collide on the
      // primary key during an upsert).
      removeCredential(null, API_KEY_CREDENTIAL_NAME)
      saveCredential(null, API_KEY_CREDENTIAL_NAME, trimmedKey)
      storedApiKey = trimmedKey
      currentSettings = { ...currentSettings, hasApiKey: true }
    } catch (err) {
      // Never leak the secret or crypto internals to the client.
      console.error(
        '[settings] failed to persist AI API key to credential store:',
        (err as Error).message,
      )
      res.status(500).json({ error: 'Failed to persist API key' })
      return
    }
  }

  res.json(currentSettings)
})
