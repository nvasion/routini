/**
 * IntegrationConnectModal — centered dialog for connecting (or editing the
 * credentials of) a single integration from the /integrations catalog.
 *
 * Reuses ConfigModal's overlay/panel chrome (the `cm-*` classes in
 * ConfigModal.css) rather than duplicating it, so both modals share the same
 * backdrop, close affordances, form-row layout, and save/cancel footer. Only
 * the integration-specific pieces (setup link, description) get their own
 * small stylesheet, IntegrationConnectModal.css.
 *
 * Write-only credentials: GET /api/integrations never returns secret values
 * (see the Integration type), so every field always starts blank — for a
 * fresh connection and for editing an already-connected integration alike.
 * Saving only sends fields the user actually typed into (see
 * buildConnectPayload), so leaving a field blank keeps its stored value
 * unchanged instead of wiping it out.
 *
 * Close affordances mirror ConfigModal: an explicit ✕ button, clicking the
 * backdrop, and the Escape key all close the modal without saving.
 */

import { useEffect, useState } from 'react'
import type { Integration } from '../types'
import { apiFetch } from '../api'
import { FormRow, FormStatus } from './FormControls'
import { buildConnectPayload, initialFieldValues, validateConnectForm } from './integrationConnectModal.utils'
import './ConfigModal.css'
import './IntegrationConnectModal.css'

export interface IntegrationConnectModalProps {
  integration: Integration
  onClose: () => void
  /** Called with the server's updated integration record after a successful save. */
  onSaved?: (integration: Integration) => void
}

/**
 * Persists credential fields (and any other write-only integration state) via
 * PUT /api/integrations/:id and returns the server's updated catalog entry.
 * Throws an Error (with server-provided detail when available) so callers can
 * surface it inline instead of it disappearing silently.
 */
async function saveIntegration(id: string, payload: Record<string, unknown>): Promise<Integration> {
  const res = await apiFetch(`/api/integrations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await res.json().catch(() => ({}))) as Integration & { error?: string }
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Failed to save integration (HTTP ${res.status})`)
  }
  return body
}

export function IntegrationConnectModal({ integration, onClose, onSaved }: IntegrationConnectModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => initialFieldValues(integration))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Close on Escape for keyboard/accessibility parity with the close button,
  // same as ConfigModal.
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

  const updateField = (key: string, value: string) => {
    setValues(prev => ({ ...prev, [key]: value }))
    markDirty()
  }

  const handleSave = async () => {
    const validationError = validateConnectForm(integration, values)
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const updated = await saveIntegration(integration.id, buildConnectPayload(values))
      setSaved(true)
      onSaved?.(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to connect ${integration.name}`)
    } finally {
      setSaving(false)
    }
  }

  const isReconnect = integration.status === 'connected'

  return (
    <div className="cm-overlay" role="presentation" onClick={onClose}>
      <div
        className="cm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${integration.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="cm-header">
          <div>
            <h2 className="cm-title">{isReconnect ? 'Edit credentials' : 'Connect'}</h2>
            <p className="cm-subtitle">{integration.name}</p>
          </div>
          <button
            className="cm-close"
            onClick={onClose}
            aria-label="Close connect modal"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="cm-body">
          {integration.description && <p className="icm-description">{integration.description}</p>}

          <a
            className="icm-setup-link"
            href={integration.setupUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {integration.setupLabel} ↗
          </a>

          {isReconnect && (
            <p className="cm-form-hint">
              Stored credentials aren't shown here. Fill in a field to replace it — leave the rest
              blank to keep them unchanged.
            </p>
          )}

          {integration.fields.map(field => (
            <FormRow
              key={field.key}
              id={`icm-${integration.id}-${field.key}`}
              label={field.required === false ? `${field.label} (optional)` : field.label}
            >
              <input
                id={`icm-${integration.id}-${field.key}`}
                className="cm-input"
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                onChange={e => updateField(field.key, e.target.value)}
              />
            </FormRow>
          ))}

          <FormStatus error={error} saved={saved} />

          <div className="cm-footer">
            <button type="button" className="cm-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="cm-btn-save"
              onClick={handleSave}
              disabled={saving}
              aria-busy={saving}
            >
              {saving ? 'Saving…' : isReconnect ? 'Save' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
