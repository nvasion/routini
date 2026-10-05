import { useState, type FormEvent } from 'react'
import { ErrorBanner, Field, Modal } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { AgentId, Integration } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

const AGENTS: Array<[AgentId, string]> = [
  ['claude', 'Claude Code'],
  ['omnimancer', 'Omnimancer'],
  ['opencode', 'OpenCode'],
]

const STATUS: Record<Integration['status'], { label: string; cls: string }> = {
  connected: { label: 'Connected', cls: 'ok' },
  error: { label: 'Check failed', cls: 'fail' },
  not_connected: { label: 'Not connected', cls: '' },
}

export function IntegrationsPage() {
  const org = useOrg()
  const list = useApi<{ integrations: Integration[] }>(org.api('/integrations'))
  const [open, setOpen] = useState<Integration | null>(null)

  const replace = (i: Integration) => {
    list.setData((prev) => (prev ? { integrations: prev.integrations.map((x) => (x.id === i.id ? i : x)) } : prev))
    setOpen((o) => (o && o.id === i.id ? i : o))
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Integrations</h1>
      </div>
      <p className="lead">Connected tools are available to agents whose scope allows them. Secrets are stored encrypted and never shown again.</p>
      <ErrorBanner error={list.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {list.data?.integrations.map((i) => (
          <button key={i.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', color: 'var(--ink)' }} onClick={() => setOpen(i)}>
            <span className="inline" style={{ justifyContent: 'space-between', width: '100%' }}>
              <span style={{ fontFamily: 'var(--font-sign)', fontWeight: 700, fontSize: 18 }}>{i.name}</span>
              <span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              {i.description}
            </span>
            {i.status !== 'not_connected' && <span className="meta">agents: {i.scopes.agents.join(', ') || 'none'}</span>}
          </button>
        ))}
      </div>
      {open && <IntegrationModal integration={open} onClose={() => setOpen(null)} onChange={replace} canEdit={org.can('admin')} />}
    </>
  )
}

function IntegrationModal({ integration: i, onClose, onChange, canEdit }: { integration: Integration; onClose: () => void; onChange: (i: Integration) => void; canEdit: boolean }) {
  const org = useOrg()
  const [values, setValues] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<AgentId[]>(i.scopes.agents)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const connected = i.status !== 'not_connected'

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const credentials = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
      const body: Record<string, unknown> = { scopes: { agents } }
      if (Object.keys(credentials).length) body['credentials'] = credentials
      const res = await api<{ integration: Integration }>(org.api(`/integrations/${i.id}`), { method: 'PUT', body })
      setValues({})
      onChange(res.integration)
      setNote('Saved.')
    })
  }

  return (
    <Modal title={i.name} onClose={onClose}>
      <p className="lead">{i.description}</p>
      <a href={i.setupUrl} target="_blank" rel="noreferrer">
        {i.setupLabel} ↗
      </a>
      <form className="stack" onSubmit={save}>
        <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          {i.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={connected ? 'Leave blank to keep the stored value.' : undefined}>
              {(id) => (
                <input
                  id={id}
                  className="input"
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  required={!connected}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <div className="field">
            <span className="field-label">Agents that may use it</span>
            <div className="inline">
              {AGENTS.map(([id, label]) => (
                <label key={id} className="inline" style={{ gap: 6 }}>
                  <input type="checkbox" checked={agents.includes(id)} onChange={(e) => setAgents((a) => (e.target.checked ? [...a, id] : a.filter((x) => x !== id)))} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          {canEdit && (
            <div className="inline">
              <button type="submit" className="btn primary">
                {connected ? 'Save' : 'Connect'}
              </button>
              {connected && (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      run(async () => {
                        const res = await api<{ ok: boolean; message: string; integration: Integration }>(org.api(`/integrations/${i.id}/test`), { method: 'POST' })
                        onChange(res.integration)
                        setNote(res.ok ? `Test passed: ${res.message}` : `Test failed: ${res.message}`)
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => {
                      if (!window.confirm(`Disconnect ${i.name}? Stored credentials are deleted.`)) return
                      void run(async () => {
                        const res = await api<{ integration: Integration }>(org.api(`/integrations/${i.id}`), { method: 'DELETE' })
                        onChange(res.integration)
                        setNote('Disconnected.')
                      })
                    }}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
          )}
        </fieldset>
      </form>
      {i.lastTestAt && (
        <span className="meta">
          last test {relativeTime(i.lastTestAt)}: {i.lastTestOk ? 'passed' : 'failed'}
          {i.lastTestMessage ? ` — ${i.lastTestMessage}` : ''}
        </span>
      )}
      {note && <div className="banner info">{note}</div>}
      <ErrorBanner error={error} />
      {!canEdit && <span className="muted">Only admins can change integrations.</span>}
    </Modal>
  )
}
