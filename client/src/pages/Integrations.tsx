/**
 * Integrations — catalog grid of the external tools tasks and coding agents
 * can connect to (GitHub, Slack, Jira, Notion, Linear, monday.com, HubSpot).
 *
 * Data source: GET /api/integrations returns the full catalog plus each
 * integration's non-secret status (never a credential value). Clicking a
 * card opens IntegrationModal, which reuses ConfigModal's overlay/panel
 * chrome, for connecting, testing, re-scoping, or disconnecting.
 */
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Integration } from '../types'
import { apiFetch } from '../api'
import { IntegrationModal } from '../components/IntegrationModal'
import './Integrations.css'

const STATUS_LABEL: Record<Integration['status'], string> = {
  not_connected: 'Not connected',
  connected: 'Connected',
  error: 'Error',
}

function IntegrationCard({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onOpen()
  }

  return (
    <article
      className="integration-card"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`Configure ${integration.name}`}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <div className="integration-card-header">
        <span className="integration-card-name">{integration.name}</span>
        <span className={`integration-badge integration-badge--${integration.status}`}>
          {STATUS_LABEL[integration.status]}
        </span>
      </div>
      <p className="integration-card-description">{integration.description}</p>
    </article>
  )
}

export function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const fetchIntegrations = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await apiFetch('/api/integrations')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { integrations: Integration[] }
      setIntegrations(data.integrations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchIntegrations()
  }, [fetchIntegrations])

  const openIntegration = integrations.find(i => i.id === openId) ?? null

  return (
    <div className="integrations-page">
      <header className="integrations-header">
        <h1>Integrations</h1>
        <p className="integrations-subtitle">
          Connect the external tools your tasks and coding agents work with.
        </p>
      </header>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state-placeholder">Loading integrations…</div>
      ) : (
        <div className="integrations-grid" role="list">
          {integrations.map(integration => (
            <div role="listitem" key={integration.id}>
              <IntegrationCard integration={integration} onOpen={() => setOpenId(integration.id)} />
            </div>
          ))}
        </div>
      )}

      {openIntegration && (
        <IntegrationModal
          integration={openIntegration}
          onClose={() => setOpenId(null)}
          onChange={updated => {
            setIntegrations(prev => prev.map(i => (i.id === updated.id ? updated : i)))
          }}
        />
      )}
    </div>
  )
}
