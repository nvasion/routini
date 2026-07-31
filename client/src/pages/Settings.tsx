import React, { useState, useEffect } from 'react'
import type { AISettings, AIEndpoint, AgentEndpointConfig } from '../types'
import { apiFetch } from '../api'
import './Settings.css'

// ── Catalog (mirrors server/src/routes/settings.ts) ──────────────────────────

const ENDPOINT_LABELS: Record<AIEndpoint, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  digitalocean: 'DigitalOcean Inference',
  'aws-bedrock': 'AWS Bedrock',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  azure: 'Azure OpenAI',
  gateway: 'claude-code-model-gateway (all endpoints)',
}

/** Which endpoints each coding agent may talk to. Gateway opens all of them
    to Claude Code; Omnimancer is natively open to every endpoint. */
const AGENTS: { id: string; label: string; endpoints: AIEndpoint[]; note: string }[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    endpoints: ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'gateway'],
    note: 'Talks to Anthropic, OpenRouter, DigitalOcean and AWS Bedrock for now — selecting the gateway opens all endpoints.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    endpoints: ['anthropic', 'openai', 'openrouter'],
    note: 'OpenRouter is open to all agents.',
  },
  {
    id: 'omnimancer',
    label: 'Omnimancer',
    endpoints: ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'openai', 'google', 'azure'],
    note: 'Natively multi-provider — open to all endpoints, no gateway needed.',
  },
]

const KEYED_ENDPOINTS: AIEndpoint[] = [
  'anthropic',
  'openrouter',
  'digitalocean',
  'aws-bedrock',
  'openai',
  'google',
  'azure',
]

const ENDPOINT_KEY_HINTS: Partial<Record<AIEndpoint, string>> = {
  'aws-bedrock': 'Enter as ACCESS_KEY_ID:SECRET_ACCESS_KEY',
}

const DEFAULT_AGENTS: Record<string, AgentEndpointConfig> = {
  claude: { endpoint: 'anthropic', model: 'claude-opus-4-5' },
  opencode: { endpoint: 'openrouter', model: '' },
  omnimancer: { endpoint: 'openrouter', model: '' },
}

export function Settings() {
  const [settings, setSettings] = useState<AISettings>({
    provider: 'claude',
    model: '',
    defaultAgentId: 'claude',
    hasApiKey: false,
    agents: DEFAULT_AGENTS,
    endpointKeys: {},
  })
  /**
   * Local-only endpoint API key inputs. The server never returns stored keys
   * so these are never pre-populated; non-empty values are sent on save and
   * the fields are cleared afterward.
   */
  const [endpointKeys, setEndpointKeys] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('/api/settings')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as AISettings
      // Merge over defaults so a server predating per-agent config still renders.
      setSettings({ ...data, agents: { ...DEFAULT_AGENTS, ...(data.agents ?? {}) } })
    } catch (err) {
      setFlash({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }

  const updateAgent = (agentId: string, patch: Partial<AgentEndpointConfig>) => {
    setSettings(prev => ({
      ...prev,
      agents: {
        ...prev.agents,
        [agentId]: { ...(prev.agents[agentId] ?? DEFAULT_AGENTS[agentId]), ...patch },
      },
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFlash(null)

    try {
      setSaving(true)

      const payload: Record<string, unknown> = {
        defaultAgentId: settings.defaultAgentId,
        agents: settings.agents,
      }
      // Only send keys the user actually typed — omitting leaves stored keys unchanged.
      const typedKeys = Object.fromEntries(
        Object.entries(endpointKeys).filter(([, v]) => v.trim() !== ''),
      )
      if (Object.keys(typedKeys).length > 0) {
        payload.endpointApiKeys = typedKeys
      }

      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errData = (await res.json()) as { error: string }
        throw new Error(errData.error ?? `HTTP ${res.status}`)
      }

      const updated = (await res.json()) as AISettings
      setSettings({ ...updated, agents: { ...DEFAULT_AGENTS, ...(updated.agents ?? {}) } })
      // Clear plaintext keys from React state as soon as they are persisted.
      setEndpointKeys({})
      setFlash({ type: 'success', text: 'Settings saved successfully' })
    } catch (err) {
      setFlash({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="settings-loading">Loading settings…</div>
  }

  return (
    <div className="settings-page">
      <div className="settings-container">
        <header className="settings-header">
          <h1>AI Settings</h1>
          <p className="settings-subtitle">
            Configure which endpoint each coding agent talks to, and the API keys per endpoint
          </p>
        </header>

        <form onSubmit={handleSubmit} className="settings-form">
          {flash && (
            <p className={`settings-flash settings-flash-${flash.type}`} role="status">
              {flash.text}
            </p>
          )}

          {/* ── Per-agent endpoint configuration ── */}
          {AGENTS.map(agent => {
            const config = settings.agents[agent.id] ?? DEFAULT_AGENTS[agent.id]
            return (
              <section className="settings-section" key={agent.id} aria-label={`${agent.label} settings`}>
                <h2>{agent.label}</h2>
                <p className="form-hint">{agent.note}</p>

                <div className="form-group">
                  <label htmlFor={`endpoint-${agent.id}`}>Endpoint</label>
                  <select
                    id={`endpoint-${agent.id}`}
                    value={config.endpoint}
                    onChange={e => updateAgent(agent.id, { endpoint: e.target.value as AIEndpoint })}
                  >
                    {agent.endpoints.map(endpoint => (
                      <option key={endpoint} value={endpoint}>
                        {ENDPOINT_LABELS[endpoint]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor={`model-${agent.id}`}>Model</label>
                  <input
                    id={`model-${agent.id}`}
                    type="text"
                    value={config.model}
                    onChange={e => updateAgent(agent.id, { model: e.target.value })}
                    placeholder={agent.id === 'claude' ? 'e.g. claude-opus-4-5' : 'e.g. provider/model-name'}
                  />
                </div>

                {config.endpoint === 'gateway' && (
                  <>
                    <div className="form-group">
                      <label htmlFor={`gateway-url-${agent.id}`}>Gateway URL</label>
                      <input
                        id={`gateway-url-${agent.id}`}
                        type="text"
                        value={config.gatewayUrl ?? ''}
                        onChange={e => updateAgent(agent.id, { gatewayUrl: e.target.value })}
                        placeholder="http://gateway-host:8080"
                      />
                    </div>

                    <aside className="settings-gateway-help" aria-label="Gateway setup instructions">
                      <h3>Setting up claude-code-model-gateway</h3>
                      <p>
                        The gateway is a drop-in Anthropic-API proxy. With it in place, Claude Code
                        can reach <strong>all</strong> endpoints (Anthropic, OpenAI, OpenRouter,
                        Google, AWS Bedrock, Azure, DigitalOcean Inference, local models).
                      </p>
                      <ol>
                        <li>
                          Download and install:{' '}
                          <code>git clone https://github.com/nvasion/claude-code-model-gateway && pip install -e .</code>{' '}
                          (or <code>docker compose up -d</code> in the repo — serves on port 8080).
                        </li>
                        <li>
                          Add providers: <code>claude-code-model-gateway config init</code> then{' '}
                          <code>claude-code-model-gateway provider add openrouter</code> (reads{' '}
                          <code>OPENROUTER_API_KEY</code> from its environment; repeat per provider).
                        </li>
                        <li>
                          Route models: <code>claude-code-model-gateway route add "claude-*" --provider anthropic</code>,{' '}
                          then start the router with <code>claude-code-model-gateway route serve</code>.
                        </li>
                        <li>
                          Enter the gateway's URL above — agent runs will receive{' '}
                          <code>ANTHROPIC_BASE_URL=&lt;gateway URL&gt;</code>.
                        </li>
                        <li>
                          Verify with <code>curl http://gateway-host:8080/health</code>.
                        </li>
                      </ol>
                      <p className="form-hint">
                        Provider API keys must be present in the gateway's own environment — Routini
                        never transmits keys to it.
                      </p>
                    </aside>
                  </>
                )}
              </section>
            )
          })}

          {/* ── Per-endpoint API keys ── */}
          <section className="settings-section" aria-label="Endpoint API keys">
            <h2>Endpoint API Keys</h2>
            <p className="form-hint">
              Keys are stored encrypted and shared by every agent using that endpoint. Stored keys
              are never shown — enter a value to set or replace one.
            </p>

            {KEYED_ENDPOINTS.map(endpoint => (
              <div className="form-group" key={endpoint}>
                <label htmlFor={`key-${endpoint}`}>{ENDPOINT_LABELS[endpoint]}</label>
                <input
                  id={`key-${endpoint}`}
                  type="password"
                  value={endpointKeys[endpoint] ?? ''}
                  onChange={e => setEndpointKeys(prev => ({ ...prev, [endpoint]: e.target.value }))}
                  placeholder={
                    settings.endpointKeys?.[endpoint]
                      ? 'Key configured — enter a new value to replace it'
                      : 'Enter API key'
                  }
                  autoComplete="new-password"
                />
                {ENDPOINT_KEY_HINTS[endpoint] && (
                  <p className="form-hint">{ENDPOINT_KEY_HINTS[endpoint]}</p>
                )}
              </div>
            ))}
          </section>

          {/* ── Default agent ── */}
          <section className="settings-section" aria-label="Default agent">
            <h2>Default Agent</h2>
            <div className="form-group">
              <label htmlFor="defaultAgentId">Agent used when a task doesn't specify one</label>
              <select
                id="defaultAgentId"
                value={settings.defaultAgentId}
                onChange={e => setSettings(prev => ({ ...prev, defaultAgentId: e.target.value }))}
              >
                {AGENTS.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <div className="settings-footer">
            <button type="submit" className="btn-save" disabled={saving}>
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
