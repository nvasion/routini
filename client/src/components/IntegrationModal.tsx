/**
 * IntegrationModal — connect / manage dialog for a single catalog
 * integration, opened from the Integrations catalog grid
 * (client/src/pages/Integrations.tsx).
 *
 * Reuses ConfigModal's overlay/panel/header/body/footer chrome (the `cm-*`
 * classes from ConfigModal.css, plus its exported FormRow/FormStatus pieces)
 * per the PRD's "reuse ConfigModal chrome" requirement, rather than
 * duplicating that layout.
 *
 * Credential fields are write-only: values typed here are sent to
 * PUT /api/integrations/:id and never echoed back by the server, so this
 * form never pre-fills them — a blank field means "leave the stored value
 * unchanged" once already connected (all fields are required on first
 * connect). Scoping (allowed task types / agents) and the Test connection /
 * Disconnect actions only appear once the integration is connected.
 */
import { useEffect, useState } from 'react'
import type { Integration } from '../types'
import { apiFetch } from '../api'
import { FormRow, FormStatus } from './ConfigModal'
import { describeTestResult } from './integrationConnectionPanel.utils'
import './IntegrationModal.css'

const TASK_TYPE_OPTIONS = ['daily', 'developmental', 'routine'] as const
const AGENT_OPTIONS = ['claude', 'opencode', 'omnimancer'] as const

export interface IntegrationModalProps {
  integration: Integration
  onClose: () => void
  /** Called with the server's fresh status object after any successful save/test/disconnect. */
  onChange: (updated: Integration) => void
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value]
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

export function IntegrationModal({ integration, onClose, onChange }: IntegrationModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(integration.fields.map(f => [f.key, ''])),
  )
  const [taskTypes, setTaskTypes] = useState<string[]>(integration.scopes.taskTypes)
  const [agents, setAgents] = useState<string[]>(integration.scopes.agents)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const isConnected = integration.status !== 'not_connected'

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const markDirty = () => {
    setSaved(false)
    setError(null)
  }

  const handleSave = async () => {
    const credentials: Record<string, string> = {}
    for (const field of integration.fields) {
      const value = values[field.key]?.trim()
      if (value) credentials[field.key] = value
    }

    if (!isConnected && Object.keys(credentials).length < integration.fields.length) {
      setError('All fields are required to connect this integration')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/integrations/${integration.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
          scopes: { taskTypes, agents },
        }),
      })
      const body = await readJson(res)
      if (!res.ok) {
        throw new Error((body.error as string | undefined) ?? `Failed to save (HTTP ${res.status})`)
      }
      onChange(body as unknown as Integration)
      // Clear the write-only fields after a successful save so plaintext
      // credentials aren't held in React state longer than necessary.
      setValues(Object.fromEntries(integration.fields.map(f => [f.key, ''])))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save integration')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    try {
      const res = await apiFetch(`/api/integrations/${integration.id}/test`, { method: 'POST' })
      const body = await readJson(res)
      if (!res.ok) {
        throw new Error((body.error as string | undefined) ?? `Connection test failed (HTTP ${res.status})`)
      }
      onChange(body as unknown as Integration)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Connection test failed')
    } finally {
      setTesting(false)
    }
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/integrations/${integration.id}`, { method: 'DELETE' })
      const body = await readJson(res)
      if (!res.ok) {
        throw new Error((body.error as string | undefined) ?? `Failed to disconnect (HTTP ${res.status})`)
      }
      onChange(body as unknown as Integration)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect integration')
      setDisconnecting(false)
    }
  }

  return (
    <div className="cm-overlay" role="presentation" onClick={onClose}>
      <div
        className="cm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${integration.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="cm-header">
          <div>
            <h2 className="cm-title">{integration.name}</h2>
            <p className="cm-subtitle">{integration.description}</p>
          </div>
          <button className="cm-close" onClick={onClose} aria-label="Close integration modal" title="Close">
            ✕
          </button>
        </div>

        <div className="cm-body">
          <a className="im-setup-link" href={integration.setupUrl} target="_blank" rel="noopener noreferrer">
            Get a {integration.name} credential ↗
          </a>

          {integration.fields.map(field => (
            <FormRow
              key={field.key}
              id={`im-${integration.id}-${field.key}`}
              label={field.label}
              hint={isConnected ? 'Leave blank to keep the currently stored value' : undefined}
            >
              <input
                id={`im-${integration.id}-${field.key}`}
                className="cm-input"
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                value={values[field.key] ?? ''}
                onChange={e => {
                  setValues(prev => ({ ...prev, [field.key]: e.target.value }))
                  markDirty()
                }}
              />
            </FormRow>
          ))}

          {isConnected && (
            <div className="im-scopes">
              <span className="cm-form-label">Scoping</span>
              <p className="cm-form-hint">Restrict which task types and agents may use this integration.</p>

              <fieldset className="im-scope-group">
                <legend>Task types</legend>
                {TASK_TYPE_OPTIONS.map(t => (
                  <label key={t} className="im-checkbox">
                    <input
                      type="checkbox"
                      checked={taskTypes.includes(t)}
                      onChange={() => {
                        setTaskTypes(prev => toggle(prev, t))
                        markDirty()
                      }}
                    />
                    {t}
                  </label>
                ))}
              </fieldset>

              <fieldset className="im-scope-group">
                <legend>Agents</legend>
                {AGENT_OPTIONS.map(a => (
                  <label key={a} className="im-checkbox">
                    <input
                      type="checkbox"
                      checked={agents.includes(a)}
                      onChange={() => {
                        setAgents(prev => toggle(prev, a))
                        markDirty()
                      }}
                    />
                    {a}
                  </label>
                ))}
              </fieldset>
            </div>
          )}

          <FormStatus error={error} saved={saved} savedText={isConnected ? 'Saved' : 'Connected'} />

          {isConnected && (
            <div className="im-test-section">
              <button
                type="button"
                className="cm-btn-ghost cm-btn-sm"
                onClick={handleTest}
                disabled={testing}
                aria-busy={testing}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {testError && (
                <p className="cm-error" role="alert">
                  {testError}
                </p>
              )}
              {!testError && integration.lastTestAt && (
                <p
                  className={`im-test-result ${
                    integration.lastTestOk === true
                      ? 'im-test-result--ok'
                      : integration.lastTestOk === false
                        ? 'im-test-result--fail'
                        : ''
                  }`}
                  role="status"
                >
                  {describeTestResult(integration.lastTestOk, integration.lastTestAt)}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="cm-footer">
          {isConnected && (
            <button
              type="button"
              className="cm-btn-ghost"
              onClick={handleDisconnect}
              disabled={disconnecting || saving}
              aria-busy={disconnecting}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
          <button type="button" className="cm-btn-ghost" onClick={onClose} disabled={saving || disconnecting}>
            Cancel
          </button>
          <button
            type="button"
            className="cm-btn-save"
            onClick={handleSave}
            disabled={saving || disconnecting}
            aria-busy={saving}
          >
            {saving ? 'Saving…' : isConnected ? 'Save' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
