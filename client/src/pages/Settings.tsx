import React, { useState, useEffect } from 'react'
import type { AISettings } from '../types'
import { apiFetch } from '../api'
import './Settings.css'

const AI_PROVIDERS = [
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'omnimancer', label: 'Omnimancer' },
] as const

export function Settings() {
  const [settings, setSettings] = useState<AISettings>({
    provider: 'claude',
    model: '',
    defaultAgentId: '',
    hasApiKey: false,
  })
  /**
   * Local-only API key input.  The server never returns the stored key so this
   * field is never pre-populated.  A non-empty value on submit is sent to the
   * server and the field is cleared afterward to avoid leaving the key in state.
   */
  const [apiKey, setApiKey] = useState('')
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
      setSettings(data)
    } catch (err) {
      setFlash({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFlash(null)

    try {
      setSaving(true)

      // Build the request payload.  Only include apiKey when the user has
      // typed a new value — omitting it leaves the stored key unchanged.
      const payload: Record<string, string> = {
        provider: settings.provider,
        model: settings.model,
        defaultAgentId: settings.defaultAgentId,
      }
      if (apiKey.trim()) {
        payload.apiKey = apiKey.trim()
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
      setSettings(updated)
      // Clear the local key input after a successful save so the plaintext
      // key is not held in React state longer than necessary.
      setApiKey('')
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
            Configure your AI provider and default coding agent
          </p>
        </header>

        <form onSubmit={handleSubmit} className="settings-form">
          {flash && (
            <p className={`settings-flash settings-flash-${flash.type}`} role="status">
              {flash.text}
            </p>
          )}

          <section className="settings-section">
            <h2>Provider</h2>

            <div className="form-group">
              <label htmlFor="provider">AI Provider</label>
              <select
                id="provider"
                value={settings.provider}
                onChange={e =>
                  setSettings(prev => ({ ...prev, provider: e.target.value }))
                }
              >
                {AI_PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="apiKey">API Key</label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={
                  settings.hasApiKey
                    ? 'Key configured — enter a new value to replace it'
                    : 'Enter your API key'
                }
                autoComplete="new-password"
              />
              {settings.hasApiKey && !apiKey && (
                <p className="form-hint">A key is currently configured for this provider.</p>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="model">Model</label>
              <input
                id="model"
                type="text"
                value={settings.model}
                onChange={e =>
                  setSettings(prev => ({ ...prev, model: e.target.value }))
                }
                placeholder="e.g. claude-opus-4-5"
              />
            </div>

            <div className="form-group">
              <label htmlFor="defaultAgentId">Default Agent ID</label>
              <input
                id="defaultAgentId"
                type="text"
                value={settings.defaultAgentId}
                onChange={e =>
                  setSettings(prev => ({ ...prev, defaultAgentId: e.target.value }))
                }
                placeholder="e.g. claude"
              />
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
