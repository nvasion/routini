/**
 * IntegrationsPage — read-only catalog grid, one card per integration, fed by
 * GET /api/integrations. Mirrors MetricsPage's data-fetching shape (loading /
 * error / empty states around a single GET) rather than Dashboard's SSE-driven
 * pattern, since the catalog only changes in response to this page's own
 * mutations (connect/test/disconnect — implemented by a later task).
 *
 * Scope: this page only renders the catalog and its status badges. Clicking a
 * card is wired through the optional `onSelectIntegration` callback so a
 * follow-up task can open the connect modal (reusing ConfigModal's
 * overlay/panel chrome, per the PRD) without having to restructure this grid.
 */

import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Integration, IntegrationStatus } from '../types'
import { apiFetch } from '../api'
import './IntegrationsPage.css'

interface StatusBadgeInfo {
  label: string
  className: string
}

const STATUS_BADGES: Record<IntegrationStatus, StatusBadgeInfo> = {
  not_connected: { label: 'Not connected', className: 'integration-badge--not-connected' },
  connected: { label: 'Connected', className: 'integration-badge--connected' },
  error: { label: 'Error', className: 'integration-badge--error' },
}

/**
 * Maps a catalog entry's status to its display label and CSS modifier class.
 * Falls back to the "not connected" presentation for any unrecognized value
 * so a server-side enum change never renders a blank/broken badge.
 * Exported so the mapping can be unit-tested directly.
 */
export function describeIntegrationStatus(status: IntegrationStatus): StatusBadgeInfo {
  return STATUS_BADGES[status] ?? STATUS_BADGES.not_connected
}

interface IntegrationCardProps {
  integration: Integration
  onSelect?: (integration: Integration) => void
}

function IntegrationCard({ integration, onSelect }: IntegrationCardProps) {
  const badge = describeIntegrationStatus(integration.status)

  const handleClick = () => onSelect?.(integration)

  // Keyboard parity with TaskCard: the whole card is a hit target, activated
  // by Enter/Space in addition to click, matching its role="button" semantics.
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect?.(integration)
  }

  return (
    <article
      className="integration-card"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`${integration.name} — ${badge.label}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="integration-card-header">
        <h2 className="integration-card-name">{integration.name}</h2>
        <span className={`integration-badge ${badge.className}`}>{badge.label}</span>
      </div>

      {integration.description && (
        <p className="integration-card-description">{integration.description}</p>
      )}

      {integration.status === 'connected' && integration.connectedAt && (
        <p className="integration-card-meta">
          Since{' '}
          <time dateTime={integration.connectedAt}>
            {new Date(integration.connectedAt).toLocaleDateString()}
          </time>
        </p>
      )}
    </article>
  )
}

export interface IntegrationsPageProps {
  /**
   * Invoked with the clicked integration. Left unwired by default (a no-op)
   * so this page renders and tests standalone before the connect modal task
   * lands; the follow-up task supplies this to open that modal.
   */
  onSelectIntegration?: (integration: Integration) => void
}

export function IntegrationsPage({ onSelectIntegration }: IntegrationsPageProps = {}) {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchIntegrations = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await apiFetch('/api/integrations')
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { integrations: Integration[] }
      setIntegrations(data.integrations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchIntegrations()
  }, [fetchIntegrations])

  return (
    <div className="integrations-page">
      <header className="integrations-header">
        <div>
          <h1>Integrations</h1>
          <p className="integrations-subtitle">
            Connect the external tools your tasks and coding agents work with
          </p>
        </div>
      </header>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state-placeholder">Loading integrations…</div>
      ) : integrations.length === 0 ? (
        <div className="state-placeholder">
          <p>No integrations available</p>
        </div>
      ) : (
        <div className="integrations-grid">
          {integrations.map(integration => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              onSelect={onSelectIntegration}
            />
          ))}
        </div>
      )}
    </div>
  )
}
