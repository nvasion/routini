/**
 * IntegrationConnectionPanel — the "connected integration" controls described
 * in the Routini Integrations PRD: Test connection (server-side live check
 * with persisted result + timestamp), a per-integration scoping panel
 * (allowed task types + allowed agents), and Disconnect.
 *
 * This is a content fragment, not a modal shell: it is meant to be embedded
 * inside the integration connect modal (which reuses ConfigModal's
 * overlay/panel chrome — see ConfigModal.tsx) once that integration is
 * `status: 'connected'`. It intentionally renders nothing for integrations
 * that aren't connected yet, since Test connection / scoping / Disconnect
 * are only meaningful once credentials exist server-side.
 *
 * API contract (see PRD "API design"):
 *   POST   /api/integrations/:id/test → { ok, message?, lastTestAt } — persists the result server-side.
 *   PUT    /api/integrations/:id      → accepts a partial body; here we only ever send `{ scopes }`.
 *   DELETE /api/integrations/:id      → removes stored credentials and resets metadata.
 * None of these responses ever include secret values — the server is
 * write-only for credential fields (see credential store docs in README.md).
 */

import { useState } from 'react'
import type { AIProvider, Integration, IntegrationScopes, TaskType } from '../types'
import { apiFetch } from '../api'
import {
  AGENT_SCOPE_OPTIONS,
  TASK_TYPE_OPTIONS,
  buildScopesPayload,
  describeTestResult,
  formatTimestamp,
  toggleValue,
} from './integrationConnectionPanel.utils.ts'
import './ConfigModal.css'
import './IntegrationConnectionPanel.css'

export interface IntegrationConnectionPanelProps {
  integration: Integration
  /** Called after a successful Test connection call, so the parent (catalog list/modal) can stay in sync. */
  onTested?: (id: string, result: { ok: boolean; lastTestAt: string | null }) => void
  /** Called after scopes are saved successfully. */
  onScopesSaved?: (id: string, scopes: IntegrationScopes) => void
  /** Called after a successful disconnect — the parent should treat the integration as not-connected. */
  onDisconnected?: (id: string) => void
}

interface TestResponseBody {
  ok: boolean
  message?: string
  lastTestAt?: string
  error?: string
}

async function testIntegration(id: string): Promise<TestResponseBody> {
  const res = await apiFetch(`/api/integrations/${id}/test`, { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as TestResponseBody
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to test connection (HTTP ${res.status})`)
  }
  return body
}

async function saveIntegrationScopes(id: string, scopes: IntegrationScopes): Promise<void> {
  const res = await apiFetch(`/api/integrations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildScopesPayload(scopes)),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Failed to save scopes (HTTP ${res.status})`)
  }
}

async function disconnectIntegration(id: string): Promise<void> {
  const res = await apiFetch(`/api/integrations/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Failed to disconnect (HTTP ${res.status})`)
  }
}

export function IntegrationConnectionPanel({
  integration,
  onTested,
  onScopesSaved,
  onDisconnected,
}: IntegrationConnectionPanelProps) {
  // ── Test connection ─────────────────────────────────────────────────────
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [lastTestOk, setLastTestOk] = useState<boolean | null>(integration.lastTestOk)
  const [lastTestAt, setLastTestAt] = useState<string | null>(integration.lastTestAt)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    try {
      const body = await testIntegration(integration.id)
      const nextLastTestAt = body.lastTestAt ?? null
      setLastTestOk(body.ok)
      setLastTestAt(nextLastTestAt)
      setTestMessage(body.message ?? null)
      onTested?.(integration.id, { ok: body.ok, lastTestAt: nextLastTestAt })
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to test connection')
    } finally {
      setTesting(false)
    }
  }

  // ── Scoping panel ────────────────────────────────────────────────────────
  const [taskTypes, setTaskTypes] = useState<TaskType[]>(integration.scopes.taskTypes)
  const [agents, setAgents] = useState<AIProvider[]>(integration.scopes.agents)
  const [scopesSaving, setScopesSaving] = useState(false)
  const [scopesError, setScopesError] = useState<string | null>(null)
  const [scopesSaved, setScopesSaved] = useState(false)

  const markScopesDirty = () => {
    setScopesSaved(false)
    setScopesError(null)
  }

  const handleSaveScopes = async () => {
    setScopesSaving(true)
    setScopesError(null)
    try {
      const scopes: IntegrationScopes = { taskTypes, agents }
      await saveIntegrationScopes(integration.id, scopes)
      setScopesSaved(true)
      onScopesSaved?.(integration.id, scopes)
    } catch (err) {
      setScopesError(err instanceof Error ? err.message : 'Failed to save scopes')
    } finally {
      setScopesSaving(false)
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  const handleDisconnect = async () => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await disconnectIntegration(integration.id)
      setConfirmingDisconnect(false)
      onDisconnected?.(integration.id)
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setDisconnecting(false)
    }
  }

  // Test connection / scoping / disconnect only make sense once credentials
  // exist server-side — nothing to render for a not-yet-connected integration.
  if (integration.status === 'not_connected') {
    return null
  }

  return (
    <div className="icp-root">
      {/* ── Test connection ─────────────────────────────────────────────── */}
      <div className="cm-form-row">
        <span className="cm-form-label">Connection</span>
        <div className="icp-test-row">
          <button
            type="button"
            className="cm-btn-ghost cm-btn-sm"
            onClick={handleTest}
            disabled={testing}
            aria-busy={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <span
            className={lastTestOk === false ? 'icp-test-result icp-test-result--fail' : 'icp-test-result'}
            role="status"
          >
            {testMessage ?? describeTestResult(lastTestOk, lastTestAt)}
          </span>
        </div>
        {lastTestAt && <p className="cm-form-hint">Last tested: {formatTimestamp(lastTestAt)}</p>}
        {testError && (
          <p className="cm-error" role="alert">
            {testError}
          </p>
        )}
      </div>

      {/* ── Scoping panel ────────────────────────────────────────────────── */}
      <div className="cm-form-row">
        <span className="cm-form-label">Scoping</span>
        <p className="cm-form-hint">
          Restricts which tasks and agents may use this integration at run time. Enforced server-side
          when a task or agent container is spawned — this panel only controls what's allowed, not
          just what's shown.
        </p>

        <fieldset className="icp-fieldset">
          <legend className="icp-legend">Allowed task types</legend>
          {TASK_TYPE_OPTIONS.map(opt => (
            <label key={opt.value} className="icp-checkbox">
              <input
                type="checkbox"
                checked={taskTypes.includes(opt.value)}
                onChange={() => {
                  setTaskTypes(prev => toggleValue(prev, opt.value))
                  markScopesDirty()
                }}
              />
              {opt.label}
            </label>
          ))}
        </fieldset>

        <fieldset className="icp-fieldset">
          <legend className="icp-legend">Allowed agents</legend>
          {AGENT_SCOPE_OPTIONS.map(opt => (
            <label key={opt.value} className="icp-checkbox">
              <input
                type="checkbox"
                checked={agents.includes(opt.value)}
                onChange={() => {
                  setAgents(prev => toggleValue(prev, opt.value))
                  markScopesDirty()
                }}
              />
              {opt.label}
            </label>
          ))}
        </fieldset>

        {scopesError && (
          <p className="cm-error" role="alert">
            {scopesError}
          </p>
        )}
        {scopesSaved && !scopesError && (
          <p className="cm-success" role="status">
            Scopes saved
          </p>
        )}

        <div className="icp-scopes-actions">
          <button
            type="button"
            className="cm-btn-save cm-btn-sm"
            onClick={handleSaveScopes}
            disabled={scopesSaving}
            aria-busy={scopesSaving}
          >
            {scopesSaving ? 'Saving…' : 'Save scopes'}
          </button>
        </div>
      </div>

      {/* ── Disconnect ───────────────────────────────────────────────────── */}
      <div className="cm-form-row icp-disconnect-row">
        <span className="cm-form-label">Danger zone</span>
        {disconnectError && (
          <p className="cm-error" role="alert">
            {disconnectError}
          </p>
        )}
        {!confirmingDisconnect ? (
          <button
            type="button"
            className="icp-btn-danger"
            onClick={() => setConfirmingDisconnect(true)}
          >
            Disconnect
          </button>
        ) : (
          <div className="icp-disconnect-confirm">
            <p className="cm-form-hint">
              Remove the stored credentials for {integration.name}? Task types and agents currently
              scoped to it will lose access. This cannot be undone.
            </p>
            <div className="icp-disconnect-confirm-actions">
              <button
                type="button"
                className="cm-btn-ghost cm-btn-sm"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={disconnecting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="icp-btn-danger"
                onClick={handleDisconnect}
                disabled={disconnecting}
                aria-busy={disconnecting}
              >
                {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
