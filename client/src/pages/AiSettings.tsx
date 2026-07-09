/**
 * AI Settings page.
 *
 * Lets the signed-in user pick a provider, store an API key, choose a default
 * developmental-task agent, and tune model parameters. The plaintext API key
 * is never fetched back from the server — the page shows a "Configured" /
 * "Not configured" badge based on the `hasApiKey` flag returned by the API.
 *
 * Update semantics
 * ────────────────
 * The page submits a partial patch:
 *   - Fields the user has not touched are omitted so the server keeps their
 *     current value.
 *   - The API key input is send-only: an empty submission means "no change";
 *     clearing an existing key is a distinct action (`Clear API key`) that
 *     sends `apiKey: null` explicitly.
 *   - Nullable inputs (temperature, maxTokens, model) submit `null` when the
 *     user leaves them blank so the server clears any previous value.
 */

import { useEffect, useState, type FormEvent } from 'react'
import {
  AI_AGENTS,
  AI_PROVIDERS,
  AiSettingsApiError,
  fetchAiSettings,
  updateAiSettings,
  type AgentName,
  type AiProvider,
  type AiSettingsView,
  type UpdateAiSettingsInput,
} from '../settings/aiSettingsApi'

interface FormState {
  provider: AiProvider | ''
  defaultAgent: AgentName | ''
  apiKey: string
  model: string
  temperature: string
  maxTokens: string
}

/** Format a settings view into the form's string-typed shape. */
function toFormState(view: AiSettingsView): FormState {
  return {
    provider: view.provider ?? '',
    defaultAgent: view.defaultAgent ?? '',
    apiKey: '',
    model: view.model ?? '',
    temperature: view.temperature === null ? '' : String(view.temperature),
    maxTokens: view.maxTokens === null ? '' : String(view.maxTokens),
  }
}

/**
 * Convert a form field's trimmed string into an update payload. Blank means
 * "clear on the server"; a value is sent unchanged. Returns `undefined` when
 * the previous view already had `null` and the input is still blank, so we
 * don't spam the API with no-op writes.
 */
function nullableStringField(
  input: string,
  previous: string | null,
): string | null | undefined {
  const trimmed = input.trim()
  if (trimmed === '' && previous === null) return undefined
  return trimmed === '' ? null : trimmed
}

function nullableNumberField(
  input: string,
  previous: number | null,
): number | null | undefined {
  const trimmed = input.trim()
  if (trimmed === '' && previous === null) return undefined
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return NaN // sentinel used by caller for validation error
  return value
}

/**
 * Build the PUT payload. Only fields the user changed relative to the
 * previous view (or that need explicit clearing) end up in the patch.
 * Returns either a payload object or an array of client-side error strings.
 */
function buildPatch(
  form: FormState,
  previous: AiSettingsView,
): UpdateAiSettingsInput | string[] {
  const errors: string[] = []
  const patch: UpdateAiSettingsInput = {}

  // provider / defaultAgent are simple enum fields
  const nextProvider = form.provider === '' ? null : form.provider
  if (nextProvider !== previous.provider) patch.provider = nextProvider

  const nextAgent = form.defaultAgent === '' ? null : form.defaultAgent
  if (nextAgent !== previous.defaultAgent) patch.defaultAgent = nextAgent

  // apiKey: blank = no change; the "Clear" button below sets apiKey to null.
  const keyTrimmed = form.apiKey.trim()
  if (keyTrimmed.length > 0) patch.apiKey = keyTrimmed

  const modelPatch = nullableStringField(form.model, previous.model)
  if (modelPatch !== undefined) patch.model = modelPatch

  const tempPatch = nullableNumberField(form.temperature, previous.temperature)
  if (Number.isNaN(tempPatch)) {
    errors.push('temperature must be a number')
  } else if (tempPatch !== undefined) {
    patch.temperature = tempPatch
  }

  const maxPatch = nullableNumberField(form.maxTokens, previous.maxTokens)
  if (Number.isNaN(maxPatch)) {
    errors.push('maxTokens must be a whole number')
  } else if (maxPatch !== undefined) {
    if (!Number.isInteger(maxPatch as number)) {
      errors.push('maxTokens must be a whole number')
    } else {
      patch.maxTokens = maxPatch as number
    }
  }

  return errors.length > 0 ? errors : patch
}

interface AiSettingsPageProps {
  /** Navigate back to the dashboard tab. */
  onDone?: () => void
}

export function AiSettingsPage({ onDone }: AiSettingsPageProps) {
  const [view, setView] = useState<AiSettingsView | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const current = await fetchAiSettings()
        if (cancelled) return
        setView(current)
        setForm(toFormState(current))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleFieldChange = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setError(null)
    setDetails([])
    setSuccess(null)
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!form || !view || saving) return
    setSuccess(null)
    setError(null)
    setDetails([])

    const result = buildPatch(form, view)
    if (Array.isArray(result)) {
      setError('Please fix the highlighted fields')
      setDetails(result)
      return
    }
    if (Object.keys(result).length === 0) {
      // Nothing changed — nothing to send. Give the user a subtle confirmation.
      setSuccess('No changes to save.')
      return
    }

    setSaving(true)
    try {
      const updated = await updateAiSettings(result)
      setView(updated)
      setForm(toFormState(updated))
      setSuccess('Settings saved.')
    } catch (err) {
      if (err instanceof AiSettingsApiError) {
        setError(err.message)
        setDetails(err.details)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save settings')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleClearApiKey = async () => {
    if (!view || saving) return
    setSuccess(null)
    setError(null)
    setDetails([])
    setSaving(true)
    try {
      const updated = await updateAiSettings({ apiKey: null })
      setView(updated)
      setForm(toFormState(updated))
      setSuccess('API key cleared.')
    } catch (err) {
      if (err instanceof AiSettingsApiError) {
        setError(err.message)
        setDetails(err.details)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to clear API key')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading || !form || !view) {
    return (
      <main className="main">
        <p className="empty">Loading AI settings…</p>
      </main>
    )
  }

  return (
    <main className="main">
      <h2 className="settings-heading">AI Settings</h2>
      <p className="settings-subtitle">
        Configure the AI provider used by developmental tasks.
      </p>

      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          {details.length > 0 && (
            <ul className="error-details">
              {details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {success && (
        <p className="settings-success" role="status">
          {success}
        </p>
      )}

      <form onSubmit={handleSubmit} className="settings-form" aria-label="AI settings form">
        <label className="settings-label" htmlFor="ai-provider">
          Provider
          <select
            id="ai-provider"
            className="settings-input"
            value={form.provider}
            onChange={(e) => handleFieldChange('provider', e.target.value as AiProvider | '')}
            disabled={saving}
          >
            <option value="">— none —</option>
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-label" htmlFor="ai-api-key">
          API key{' '}
          <span
            className={
              view.hasApiKey ? 'settings-badge settings-badge-set' : 'settings-badge'
            }
          >
            {view.hasApiKey ? 'Configured' : 'Not configured'}
          </span>
          <input
            id="ai-api-key"
            className="settings-input"
            type="password"
            autoComplete="off"
            placeholder={view.hasApiKey ? 'Leave blank to keep current key' : 'Paste API key'}
            value={form.apiKey}
            onChange={(e) => handleFieldChange('apiKey', e.target.value)}
            disabled={saving}
          />
          {view.hasApiKey && (
            <button
              type="button"
              className="settings-secondary-btn"
              onClick={handleClearApiKey}
              disabled={saving}
            >
              Clear API key
            </button>
          )}
        </label>

        <label className="settings-label" htmlFor="ai-default-agent">
          Default agent
          <select
            id="ai-default-agent"
            className="settings-input"
            value={form.defaultAgent}
            onChange={(e) =>
              handleFieldChange('defaultAgent', e.target.value as AgentName | '')
            }
            disabled={saving}
          >
            <option value="">— none —</option>
            {AI_AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-label" htmlFor="ai-model">
          Model
          <input
            id="ai-model"
            className="settings-input"
            type="text"
            placeholder="e.g. claude-4.5-sonnet"
            value={form.model}
            onChange={(e) => handleFieldChange('model', e.target.value)}
            disabled={saving}
          />
        </label>

        <label className="settings-label" htmlFor="ai-temperature">
          Temperature (0 – 2)
          <input
            id="ai-temperature"
            className="settings-input"
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="Leave blank for provider default"
            value={form.temperature}
            onChange={(e) => handleFieldChange('temperature', e.target.value)}
            disabled={saving}
          />
        </label>

        <label className="settings-label" htmlFor="ai-max-tokens">
          Max tokens
          <input
            id="ai-max-tokens"
            className="settings-input"
            type="number"
            step="1"
            min="1"
            placeholder="Leave blank for provider default"
            value={form.maxTokens}
            onChange={(e) => handleFieldChange('maxTokens', e.target.value)}
            disabled={saving}
          />
        </label>

        <div className="settings-actions">
          <button type="submit" className="button" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {onDone && (
            <button
              type="button"
              className="settings-secondary-btn"
              onClick={onDone}
              disabled={saving}
            >
              Back to dashboard
            </button>
          )}
        </div>
      </form>
    </main>
  )
}
