import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Empty, ErrorBanner, RunBadge } from '../components/ui'
import { api } from '../lib/api'
import { duration, money, relativeTime } from '../lib/format'
import { useApi, useEventStream } from '../lib/hooks'
import type { RunStatus, RunSummary } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

const FILTERS: Array<[string, RunStatus[] | null]> = [
  ['All', null],
  ['Live', ['queued', 'running', 'waiting']],
  ['Failed', ['failed']],
  ['Succeeded', ['succeeded']],
]

export function RunsPage() {
  const org = useOrg()
  const [params, setParams] = useSearchParams()
  const filter = FILTERS.find(([l]) => l === params.get('show')) ?? FILTERS[0]!
  const jobId = params.get('jobId')
  const qs = new URLSearchParams()
  if (filter[1]) qs.set('status', filter[1].join(','))
  if (jobId) qs.set('jobId', jobId)
  const runs = useApi<{ runs: RunSummary[]; nextBefore: number | null }>(org.api(`/runs?${qs}`))
  useEventStream(org.api('/stream'), () => void runs.reload(), ['run'])
  const [older, setOlder] = useState<RunSummary[]>([])
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>(undefined)

  const cursor = olderCursor === undefined ? runs.data?.nextBefore ?? null : olderCursor
  async function loadMore() {
    if (cursor === null) return
    const more = await api<{ runs: RunSummary[]; nextBefore: number | null }>(org.api(`/runs?${qs}&before=${cursor}`))
    setOlder((o) => [...o, ...more.runs])
    setOlderCursor(more.runs.length ? more.nextBefore : null)
  }
  const list = [...(runs.data?.runs ?? []), ...older]

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Runs</h1>
        <div className="segmented" role="group" aria-label="Filter runs">
          {FILTERS.map(([label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={filter[0] === label}
              onClick={() => {
                setOlder([])
                setOlderCursor(undefined)
                setParams((p) => {
                  if (label === 'All') p.delete('show')
                  else p.set('show', label)
                  return p
                })
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {jobId && (
        <div className="inline meta">
          Showing one job's runs.{' '}
          <button type="button" className="btn small" onClick={() => setParams((p) => (p.delete('jobId'), p))}>
            Show all jobs
          </button>
        </div>
      )}
      <ErrorBanner error={runs.error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>RUN</th>
              <th>JOB</th>
              <th>STATUS</th>
              <th>TRIGGER</th>
              <th>STARTED</th>
              <th>DURATION</th>
              <th>COST</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  <Link to={org.path(`/runs/${r.number}`)}>#{r.number}</Link>
                </td>
                <td>{r.jobName}</td>
                <td>
                  <RunBadge status={r.status} />
                </td>
                <td className="mono muted">{r.trigger}</td>
                <td className="muted">{relativeTime(r.startedAt ?? r.createdAt)}</td>
                <td className="mono">{duration(r.startedAt, r.finishedAt)}</td>
                <td className="mono">{money(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.data && list.length === 0 && <Empty>No runs yet.</Empty>}
      </div>
      {cursor !== null && list.length >= 50 && (
        <button type="button" className="btn" onClick={loadMore}>
          Load older runs
        </button>
      )}
    </>
  )
}
