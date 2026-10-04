import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Empty, ErrorBanner, RunBadge } from '../components/ui'
import { api } from '../lib/api'
import { describeTrigger, relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { Job } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

export function JobsPage() {
  const org = useOrg()
  const navigate = useNavigate()
  const jobs = useApi<{ jobs: Job[] }>(org.api('/jobs'))
  const [error, setError] = useState<string | null>(null)

  async function runNow(job: Job) {
    setError(null)
    try {
      const { run } = await api<{ run: { number: number } }>(org.api(`/jobs/${job.id}/run`), { method: 'POST' })
      navigate(org.path(`/runs/${run.number}`))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Jobs</h1>
        {org.can('member') && (
          <Link className="btn primary" to={org.path('/jobs/new')}>
            New job
          </Link>
        )}
      </div>
      <p className="lead">A job is a trigger plus steps. Steps run in order: actions (HTTP, SSH, IMAP), coding agents, and approvals that wait for a person.</p>
      <ErrorBanner error={jobs.error ?? error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>JOB</th>
              <th>STEPS</th>
              <th>TRIGGER</th>
              <th>LAST RUN</th>
              <th>NEXT</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.data?.jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <Link to={org.path(`/jobs/${j.id}`)} style={{ fontWeight: 500 }}>
                    {j.name}
                  </Link>
                  {!j.enabled && <span className="badge" style={{ marginLeft: 8 }}>disabled</span>}
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {j.steps.map((s) => s.kind).join(' → ')}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {describeTrigger(j.trigger)}
                </td>
                <td>
                  {j.lastRun ? (
                    <Link to={org.path(`/runs/${j.lastRun.number}`)} style={{ textDecoration: 'none' }}>
                      <RunBadge status={j.lastRun.status} /> <span className="meta">#{j.lastRun.number}</span>
                    </Link>
                  ) : (
                    <span className="muted">never</span>
                  )}
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {j.nextRunAt ? relativeTime(j.nextRunAt) : '—'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {org.can('member') && (
                    <button type="button" className="btn small" onClick={() => runNow(j)}>
                      Run now
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.data && jobs.data.jobs.length === 0 && <Empty>No jobs yet.</Empty>}
      </div>
    </>
  )
}
