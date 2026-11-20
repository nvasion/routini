// Backlog: sources (each synced from a monday board or a repo of spec
// files), the items table, and one item's panel (docs/work-intake-backlog.md
// section 9). The HTTP API (section 8) ships in wave B; this page is built
// and tested against it with a mocked fetch.

import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Empty, ErrorBanner, Field, Icon, StatusDot } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { BacklogItem, BacklogItemEvent, BacklogSource, ItemState, Job, RunStatus, StepStatus } from '../lib/types'
import { useOrg } from '../shell/OrgContext'
import { BacklogSourceEditor } from './BacklogSourceEditor'

const STATE_LABELS: Record<ItemState, string> = { ready: 'Ready', planning: 'Planning', building: 'Building', finishing: 'Finishing', done: 'Done', blocked: 'Blocked', dropped: 'Dropped' }

/**
 * The status-token class for an item's state, reusing the dot/badge aliases
 * already defined for run and step statuses: ready reads as "queued" (info),
 * planning/building/finishing as "running", done as "succeeded" (ok), blocked
 * as "failed", and dropped falls back to the default, muted badge style.
 */
function stateDotStatus(state: ItemState): RunStatus | StepStatus | 'off' {
  switch (state) {
    case 'ready':
      return 'queued'
    case 'planning':
    case 'building':
    case 'finishing':
      return 'running'
    case 'done':
      return 'succeeded'
    case 'blocked':
      return 'failed'
    case 'dropped':
      return 'off'
  }
}

function StatePill({ state }: { state: ItemState }) {
  const status = stateDotStatus(state)
  return (
    <span className={`badge ${status}`}>
      <StatusDot status={status} />
      {STATE_LABELS[state]}
    </span>
  )
}

/** An item event in words (docs/work-intake-backlog.md names the kinds). Unknown kinds show as is. */
export function eventLabel(e: { kind: string; data: Record<string, unknown> }, sourceName: string): string {
  const d = e.data ?? {}
  switch (e.kind) {
    case 'imported':
      return `Imported from ${sourceName}`
    case 'picked':
      return 'Picked up by a run'
    case 'stage':
      return d['step'] ? `Moved on at step ${String(d['step'])}` : 'Moved to the next stage'
    case 'run.finished':
      return `Run${d['number'] ? ` #${String(d['number'])}` : ''} ${d['status'] === 'succeeded' ? 'finished' : String(d['status'] ?? 'finished')}`
    case 'ready.source':
      return `Set ready in ${sourceName}`
    case 'ready.manual':
    case 'ready':
      return 'Set ready in Routini'
    case 'dropped.source':
      return `Dropped in ${sourceName}`
    case 'dropped.manual':
    case 'drop':
      return 'Dropped in Routini'
    case 'repo.ignored':
      return `Ignored an invalid repository: ${String(d['value'] ?? '')}`
    default:
      return e.kind
  }
}

/** Item links come from tracker data: only http(s) URLs become links (no javascript: or data:). */
export function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/** A job whose cron trigger picks backlog items (the job editor's "Run once per backlog item" switch). */
function isBacklogJob(job: Job): boolean {
  return job.trigger.kind === 'cron' && job.trigger.backlog !== undefined
}

export function BacklogPage() {
  const org = useOrg()
  const [searchParams, setSearchParams] = useSearchParams()
  const sources = useApi<{ sources: BacklogSource[] }>(org.api('/backlog/sources'))
  const jobs = useApi<{ jobs: Job[] }>(org.api('/jobs'))

  const [state, setState] = useState<ItemState | 'all'>('all')
  const [sourceId, setSourceId] = useState('')
  const [q, setQ] = useState('')
  const query = new URLSearchParams({ ...(state !== 'all' ? { state } : {}), ...(sourceId ? { sourceId } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString()
  const items = useApi<{ items: BacklogItem[] }>(org.api(`/backlog/items${query ? `?${query}` : ''}`))

  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('item'))
  const [editingSource, setEditingSource] = useState<BacklogSource | null | undefined>(undefined)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Opening /backlog?item=<id> (e.g. from a run's "Item: <title>" link) selects that item once.
  useEffect(() => {
    const fromQuery = searchParams.get('item')
    if (fromQuery) {
      setSelectedId(fromQuery)
      searchParams.delete('item')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sourcesById = new Map((sources.data?.sources ?? []).map((s) => [s.id, s] as const))
  const backlogJobs = (jobs.data?.jobs ?? []).filter(isBacklogJob)

  async function syncNow(id: string) {
    setSyncing(id)
    setError(null)
    try {
      await api(org.api(`/backlog/sources/${id}/sync`), { method: 'POST', body: {} })
      await sources.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncing(null)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Backlog</h1>
        {org.can('admin') && (
          <button type="button" className="btn primary" onClick={() => setEditingSource(null)}>
            <Icon name="plus" size={14} /> Add source
          </button>
        )}
      </div>
      <ErrorBanner error={sources.error ?? items.error ?? error} />

      <div className="row" aria-label="Sources">
        {(sources.data?.sources ?? []).map((s) => (
          <div key={s.id} className="card" style={{ minWidth: 220 }}>
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <button type="button" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600, color: 'inherit', cursor: 'pointer' }} onClick={() => setEditingSource(s)}>
                {s.name}
              </button>
              <span className="meta">{s.kind}</span>
            </div>
            {s.lastSyncError ? (
              <span style={{ color: 'var(--fail)' }}>{s.lastSyncError}</span>
            ) : (
              <span className="meta">{s.lastSyncAt ? `synced ${relativeTime(s.lastSyncAt)}` : 'not synced yet'}</span>
            )}
            <button type="button" className="btn small" disabled={syncing === s.id} onClick={() => syncNow(s.id)}>
              {syncing === s.id ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        ))}
        {sources.data && sources.data.sources.length === 0 && <Empty>No sources yet. Add a monday board or a repo of spec files.</Empty>}
      </div>

      <div className="row" aria-label="Filters">
        <Field label="State">
          {(id) => (
            <select id={id} className="select" value={state} onChange={(e) => setState(e.target.value as ItemState | 'all')}>
              <option value="all">All</option>
              {Object.entries(STATE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Source">
          {(id) => (
            <select id={id} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">All</option>
              {(sources.data?.sources ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Search">{(id) => <input id={id} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title" />}</Field>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>ITEM</th>
              <th>STATE</th>
              <th>AT THE SOURCE</th>
              <th>LAST RUN</th>
              <th>BUILT BY</th>
            </tr>
          </thead>
          <tbody>
            {items.data?.items.map((it) => (
              <tr key={it.id} onClick={() => setSelectedId(it.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span style={{ fontWeight: 500 }}>{it.title}</span>
                  <span className="sub" style={{ display: 'block' }}>
                    {sourcesById.get(it.sourceId)?.name ?? it.sourceId}
                  </span>
                </td>
                <td>
                  <StatePill state={it.state} />
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {it.externalState || '—'}
                </td>
                <td>
                  {it.lastRunId ? (
                    <Link to={org.path(`/runs/${it.lastRunId}`)} onClick={(e) => e.stopPropagation()}>
                      run #{it.lastRunId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="muted">never</span>
                  )}
                </td>
                <td className="meta">{it.builtBy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.data && items.data.items.length === 0 && <Empty>No items match these filters.</Empty>}
      </div>

      {selectedId && (
        <ItemPanel
          itemId={selectedId}
          backlogJobs={backlogJobs}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            void items.reload()
          }}
        />
      )}

      {editingSource !== undefined && (
        <BacklogSourceEditor
          source={editingSource}
          onClose={() => setEditingSource(undefined)}
          onSaved={() => {
            void sources.reload()
          }}
        />
      )}
    </>
  )
}

function ItemPanel({ itemId, backlogJobs, onClose, onChanged }: { itemId: string; backlogJobs: Job[]; onClose: () => void; onChanged: () => void }) {
  const org = useOrg()
  const detail = useApi<{ item: BacklogItem; source: BacklogSource; events: BacklogItemEvent[] }>(org.api(`/backlog/items/${itemId}`))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState('')
  const panel = useRef<HTMLDivElement | null>(null)
  const loaded = detail.data !== undefined
  // The panel opens below the table: bring it into view, or a click on a row looks like nothing happened.
  useEffect(() => {
    if (loaded) panel.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [itemId, loaded])

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await detail.reload()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (detail.error) return <ErrorBanner error={detail.error} />
  const d = detail.data
  if (!d) return <p className="muted">Loading item…</p>
  const { item, source } = d
  const leased = item.runId !== null
  const canSetReady = (item.state === 'blocked' || item.state === 'dropped') && !leased

  return (
    <div ref={panel} className="card" aria-label="Item" style={{ marginTop: 16, scrollMarginTop: 16 }}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{item.title}</h2>
        <button type="button" className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="inline meta">
        <StatePill state={item.state} />
        <span>{source.name}</span>
        {httpUrl(item.url) && (
          <a href={httpUrl(item.url)!} target="_blank" rel="noreferrer">
            source
          </a>
        )}
        {httpUrl(item.pullRequestUrl) && (
          <a href={httpUrl(item.pullRequestUrl)!} target="_blank" rel="noreferrer">
            pull request
          </a>
        )}
      </div>
      {item.stateNote && <p className="lead">{item.stateNote}</p>}
      <ErrorBanner error={error} />
      <div className="inline">
        {backlogJobs.length > 0 && (item.state === 'ready' || item.state === 'blocked') && !leased && (
          <>
            <label className="sr-only" htmlFor="start-job">
              Job
            </label>
            <select id="start-job" className="select" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Choose a job…</option>
              {backlogJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn primary" disabled={busy || !jobId} onClick={() => act(() => api(org.api(`/backlog/items/${item.id}/start`), { body: { jobId } }))}>
              Start now
            </button>
          </>
        )}
        {canSetReady && (
          <button type="button" className="btn" disabled={busy} onClick={() => act(() => api(org.api(`/backlog/items/${item.id}/ready`), { method: 'POST', body: {} }))}>
            Set ready
          </button>
        )}
        {item.state !== 'dropped' && (
          <button type="button" className="btn danger" disabled={busy} onClick={() => act(() => api(org.api(`/backlog/items/${item.id}/drop`), { method: 'POST', body: {} }))}>
            Drop
          </button>
        )}
      </div>

      <h3 className="section-title">Events</h3>
      <ol className="list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {d.events.map((e) => (
          <li key={e.id} className="list-row" style={{ cursor: 'default' }}>
            <span className="grow">
              <span className="title">{eventLabel(e, source.name)}</span>
              <span className="sub">{relativeTime(e.at)}</span>
            </span>
          </li>
        ))}
        {d.events.length === 0 && <Empty>No events yet.</Empty>}
      </ol>
    </div>
  )
}
