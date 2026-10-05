// Settings → Alerts: where monitoring tools send alerts, and the token they use.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner } from '../components/ui'
import { api } from '../lib/api'
import { useApi } from '../lib/hooks'
import { useOrg } from '../shell/OrgContext'

export function alertmanagerExample(url: string, token: string): string {
  return [
    'receivers:',
    '  - name: routini',
    '    webhook_configs:',
    `      - url: ${url}`,
    '        send_resolved: true',
    '        http_config:',
    '          authorization:',
    '            type: Bearer',
    `            credentials: ${token}`,
  ].join('\n')
}

export function AlertsPanel() {
  const org = useOrg()
  const settings = useApi<{ url: string; configured: boolean }>(org.api('/alerts/settings'))
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function rotate() {
    if (settings.data?.configured && !window.confirm('Create a new token? The current one stops working, so update your monitoring tools.')) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ token: string; url: string }>(org.api('/alerts/token'), { method: 'POST' })
      setToken(r.token)
      await settings.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const s = settings.data
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="lead">
        Point Alertmanager, Grafana or any webhook at this endpoint. A firing alert opens an incident and starts every job with a matching{' '}
        <strong>Alert</strong> trigger; a resolved alert resolves it and drafts the postmortem. See <Link to={org.path('/incidents')}>Incidents</Link>.
      </p>
      <ErrorBanner error={settings.error ?? error} />
      {s && (
        <div className="card">
          <div className="field">
            <span className="field-label">Endpoint</span>
            <pre className="code" aria-label="Alert endpoint">
              POST {s.url}
            </pre>
          </div>
          <span className="meta">{s.configured ? 'A token is set. It is never shown again; create a new one to replace it.' : 'No token yet: alerts are refused until you create one.'}</span>
          {token && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="banner info">Copy this token now. It will not be shown again.</div>
              <pre className="code" aria-label="Alert token">
                {token}
              </pre>
              <span className="field-label">Alertmanager</span>
              <pre className="code">{alertmanagerExample(s.url, token)}</pre>
              <span className="field-label">Any tool (generic JSON)</span>
              <pre className="code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`curl -X POST ${s.url} -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' \\
  -d '{"name":"DiskFull","severity":"critical","labels":{"instance":"web-01"},"annotations":{"summary":"Disk above 90%"}}'`}</pre>
            </div>
          )}
          {org.can('admin') ? (
            <div className="inline">
              <button type="button" className="btn primary" disabled={busy} onClick={rotate}>
                {s.configured ? 'Create a new token' : 'Create token'}
              </button>
            </div>
          ) : (
            <span className="muted">Only admins can create alert tokens.</span>
          )}
        </div>
      )}
    </div>
  )
}
