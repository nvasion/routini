// Incidents: alerts that opened, what Routini did about them, and the
// postmortem. The list, and one incident's page with its timeline.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Empty, ErrorBanner, RunBadge, StatusDot } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi, useTick } from '../lib/hooks'
import type { Incident, IncidentDetail, IncidentEvent } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge sev ${severity}`}>{severity}</span>
}

export function since(from: string, to: string | null): string {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`
}

export function IncidentsPage() {
  const org = useOrg()
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open')
  const list = useApi<{ incidents: Incident[] }>(org.api(`/incidents${status === 'all' ? '' : `?status=${status}`}`))
  useTick(30_000)
  const reload = list.reload
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 15_000)
    return () => window.clearInterval(t)
  }, [reload])

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Incidents</h1>
        <div className="segmented" role="group" aria-label="Show">
          {(['open', 'resolved', 'all'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <p className="lead">
        Alerts from Alertmanager, Grafana or any webhook open incidents and start matching runbooks. Set up the endpoint in{' '}
        <Link to={org.path('/settings/alerts')}>Settings → Alerts</Link>.
      </p>
      <ErrorBanner error={list.error} />
      <div className="list">
        {list.data && list.data.incidents.length === 0 && <Empty>{status === 'open' ? 'No open incidents.' : 'No incidents yet.'}</Empty>}
        {list.data?.incidents.map((i) => (
          <Link key={i.id} className="list-row" to={org.path(`/incidents/${i.number}`)}>
            <StatusDot status={i.status === 'open' ? 'fail' : 'ok'} />
            <span className="grow">
              <span className="title">
                #{i.number} {i.title}
              </span>
              <span className="sub">
                {i.status === 'open' ? `open ${since(i.openedAt, null)}` : `resolved after ${since(i.openedAt, i.resolvedAt)}`}
                {i.hostName ? ` · ${i.hostName}` : ''}
                {i.alertCount > 1 ? ` · ${i.alertCount} alerts` : ''}
              </span>
            </span>
            <SeverityBadge severity={i.severity} />
          </Link>
        ))}
      </div>
    </>
  )
}

function eventText(e: IncidentEvent): string {
  const who = e.userName ? ` by ${e.userName}` : ''
  switch (e.type) {
    case 'alert.firing':
      return `Alert ${String(e.data['name'] ?? '')} fired (${String(e.data['severity'] ?? '')})`
    case 'alert.repeat':
      return 'Alert fired again'
    case 'alert.resolved':
      return 'Alert resolved by the monitoring system'
    case 'run.started':
      return `Started run #${String(e.data['number'])}: ${String(e.data['jobName'] ?? '')}`
    case 'run.finished':
      return `Run #${String(e.data['number'])} ${String(e.data['status'])}`
    case 'note':
      return `Note${who}: ${String(e.data['text'] ?? '')}`
    case 'resolved':
      return `Marked resolved${who}`
    default:
      return e.type
  }
}

export function IncidentPage() {
  const org = useOrg()
  const { number = '' } = useParams()
  const detail = useApi<IncidentDetail>(org.api(`/incidents/${number}`))
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useTick(30_000)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await detail.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (detail.error) return <ErrorBanner error={detail.error} />
  const d = detail.data
  if (!d) return <p className="muted">Loading incident…</p>
  const i = d.incident
  const pm = i.postmortem
  const canAct = org.can('member')
  const runsByNumber = new Map(d.runs.map((r) => [r.number, r]))

  return (
    <>
      <div className="meta">
        <Link to={org.path('/incidents')}>Incidents</Link> / #{i.number}
      </div>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <div className="inline">
            <SeverityBadge severity={i.severity} />
            <span className={`badge ${i.status === 'open' ? 'fail' : 'ok'}`}>{i.status}</span>
            <span className="meta">
              {i.status === 'open' ? `open for ${since(i.openedAt, null)}` : `resolved after ${since(i.openedAt, i.resolvedAt)}`} · {i.alertCount} alert{i.alertCount === 1 ? '' : 's'} · {i.source}
            </span>
          </div>
          <h1 className="page-title" style={{ fontSize: 26 }}>
            #{i.number} {i.title}
          </h1>
        </div>
        {i.status === 'open' && canAct && (
          <button type="button" className="btn" disabled={busy} onClick={() => act(() => api(org.api(`/incidents/${i.number}/resolve`), { method: 'POST' }))}>
            Resolve
          </button>
        )}
      </div>
      <ErrorBanner error={error} />

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <section className="card" aria-labelledby="alert-h">
          <h2 id="alert-h" className="section-title" style={{ margin: 0 }}>
            Alert
          </h2>
          <dl className="kv">
            <dt>Host</dt>
            <dd>{i.hostName ? <Link to={org.path('/fleet')}>{i.hostName}</Link> : <span className="muted">not matched to a fleet host</span>}</dd>
            {i.annotations['summary'] && (
              <>
                <dt>Summary</dt>
                <dd>{i.annotations['summary']}</dd>
              </>
            )}
            {i.annotations['description'] && (
              <>
                <dt>Description</dt>
                <dd>{i.annotations['description']}</dd>
              </>
            )}
            <dt>Opened</dt>
            <dd>{new Date(i.openedAt).toLocaleString()}</dd>
          </dl>
          <div className="labels" aria-label="Labels">
            {Object.entries(i.labels).map(([k, v]) => (
              <span key={k} className="badge mono">
                {k}={v}
              </span>
            ))}
          </div>
        </section>

        <section className="card" aria-labelledby="timeline-h">
          <h2 id="timeline-h" className="section-title" style={{ margin: 0 }}>
            Timeline
          </h2>
          <ol className="list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {d.events.map((e) => {
              const runNo = e.type.startsWith('run.') ? Number(e.data['number']) : null
              const run = runNo ? runsByNumber.get(runNo) : undefined
              return (
                <li key={e.id} className="list-row" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{eventText(e)}</span>
                    <span className="sub">{relativeTime(e.ts)}</span>
                  </span>
                  {run && e.type === 'run.started' && (
                    <Link to={org.path(`/runs/${run.number}`)}>
                      <RunBadge status={run.status} />
                    </Link>
                  )}
                </li>
              )
            })}
          </ol>
          {canAct && (
            <form
              className="stack"
              style={{ gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault()
                if (!note.trim()) return
                void act(async () => {
                  await api(org.api(`/incidents/${i.number}/notes`), { body: { text: note } })
                  setNote('')
                })
              }}
            >
              <label className="sr-only" htmlFor="inc-note">
                Add a note
              </label>
              <textarea id="inc-note" className="textarea" rows={2} placeholder="Add a note to the timeline" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="inline">
                <button type="submit" className="btn small" disabled={busy || !note.trim()}>
                  Add note
                </button>
              </div>
            </form>
          )}
        </section>
      </div>

      <section className="section card" aria-labelledby="pm-h">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 id="pm-h" className="section-title" style={{ margin: 0 }}>
            Postmortem
          </h2>
          <span className="meta">{pm ? (pm.editedAt ? `edited ${relativeTime(pm.editedAt)}` : `draft generated ${relativeTime(pm.generatedAt)}`) : 'drafted when the incident resolves'}</span>
        </div>
        {editing ? (
          <>
            <label className="sr-only" htmlFor="pm-text">
              Postmortem (markdown)
            </label>
            <textarea id="pm-text" className="textarea mono" rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="inline">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api(org.api(`/incidents/${i.number}/postmortem`), { method: 'PUT', body: { markdown: draft } })
                    setEditing(false)
                  })
                }
              >
                Save postmortem
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {pm ? <Markdown text={pm.markdown} /> : <Empty>No postmortem yet.</Empty>}
            {canAct && (
              <div className="inline">
                {pm && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setDraft(pm.markdown)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    if (pm?.editedAt && !window.confirm('Regenerate the draft? Your edits will be replaced.')) return
                    void act(() => api(org.api(`/incidents/${i.number}/postmortem/generate`), { method: 'POST' }))
                  }}
                >
                  {pm ? 'Regenerate draft' : 'Draft now'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  )
}
