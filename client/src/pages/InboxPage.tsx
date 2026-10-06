// Inbox: what needs a person (approvals, recent failures), what is live, what is next.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, ErrorBanner, StatusDot } from '../components/ui'
import { api } from '../lib/api'
import { clockTime, money, relativeTime } from '../lib/format'
import { useApi, useEventStream } from '../lib/hooks'
import type { Inbox } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

export function InboxPage() {
  const org = useOrg()
  const inbox = useApi<Inbox>(org.api('/inbox'))
  useEventStream(org.api('/stream'), () => void inbox.reload(), ['run'])
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function decide(runNumber: number, stepIdx: number, decision: 'approve' | 'deny') {
    setBusy(`${runNumber}:${stepIdx}`)
    setActionError(null)
    try {
      await api(org.api(`/runs/${runNumber}/steps/${stepIdx}/${decision}`), { method: 'POST', body: {} })
      await inbox.reload()
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const d = inbox.data
  const needCount = (d?.approvals.length ?? 0) + (d?.failures.length ?? 0) + (d?.incidents?.length ?? 0)
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Inbox</h1>
        {d && (
          <span className="meta">
            {needCount} need you · {d.live.length} live · {d.upcoming.length} scheduled
          </span>
        )}
      </div>
      <ErrorBanner error={inbox.error ?? actionError} />

      <section className="section" aria-labelledby="needs">
        <h2 id="needs" className="section-title">
          Needs you
        </h2>
        {d && needCount === 0 && <div className="list"><Empty>Nothing needs you right now.</Empty></div>}
        {d?.incidents?.map((i) => (
          <article key={i.id} className="card">
            <div className="inline meta">
              <span className="badge fail">
                <StatusDot status="fail" />
                INCIDENT #{i.number}
              </span>
              <span className={`badge sev ${i.severity}`}>{i.severity}</span>
              <span>
                opened {relativeTime(i.openedAt)}
                {i.hostName ? ` · ${i.hostName}` : ''}
                {i.alertCount > 1 ? ` · ${i.alertCount} alerts` : ''}
              </span>
            </div>
            <h3>{i.title}</h3>
            <div className="inline">
              <Link className="btn" to={org.path(`/incidents/${i.number}`)}>
                Open incident
              </Link>
            </div>
          </article>
        ))}
        {d?.approvals.map((a) => (
          <article key={a.id} className="card">
            <div className="inline meta">
              <span className="badge warn">
                <StatusDot status="warn" />
                APPROVAL{a.minRole !== 'member' ? ` · ${a.minRole}+` : ''}
              </span>
              <span>
                run #{a.runNumber} · {a.jobName} · {relativeTime(a.requestedAt)}
              </span>
            </div>
            <h3>
              {a.stepName}: {a.message}
            </h3>
            <div className="inline">
              <Link className="btn" to={org.path(`/runs/${a.runNumber}`)}>
                Review run
              </Link>
              {org.can(a.minRole === 'owner' ? 'owner' : a.minRole === 'admin' ? 'admin' : 'member') && (
                <>
                  <button type="button" className="btn primary" disabled={busy !== null} onClick={() => decide(a.runNumber, a.stepIdx, 'approve')}>
                    Approve
                  </button>
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => decide(a.runNumber, a.stepIdx, 'deny')}>
                    Deny
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
        {d?.failures.map((r) => (
          <article key={r.id} className="card">
            <div className="inline meta">
              <span className="badge fail">
                <StatusDot status="fail" />
                FAILED
              </span>
              <span>
                run #{r.number} · {r.trigger} · {relativeTime(r.finishedAt)}
              </span>
            </div>
            <h3>{r.jobName}</h3>
            {r.error && <p className="lead">{r.error}</p>}
            <div className="inline">
              <Link className="btn" to={org.path(`/runs/${r.number}`)}>
                Open run
              </Link>
            </div>
          </article>
        ))}
      </section>

      <div className="row">
        <section className="section" aria-labelledby="live">
          <h2 id="live" className="section-title">
            Live now
          </h2>
          <div className="list">
            {d && d.live.length === 0 && <Empty>No runs in progress.</Empty>}
            {d?.live.map((r) => (
              <Link key={r.id} className="list-row" to={org.path(`/runs/${r.number}`)}>
                <StatusDot status={r.status} />
                <span className="grow">
                  <span className="title">{r.jobName}</span>
                  <span className="sub">
                    #{r.number} · {r.status === 'waiting' ? 'waiting for approval' : r.status}
                  </span>
                </span>
                <span className="meta">{r.costUsd ? money(r.costUsd) : relativeTime(r.createdAt)}</span>
              </Link>
            ))}
          </div>
        </section>
        <section className="section" aria-labelledby="next">
          <h2 id="next" className="section-title">
            Coming up
          </h2>
          <div className="list">
            {d && d.upcoming.length === 0 && <Empty>No scheduled jobs.</Empty>}
            {d?.upcoming.map((u) => (
              <Link key={u.jobId} className="list-row" to={org.path(`/jobs/${u.jobId}`)}>
                <span className="mono" style={{ color: 'var(--accent)', minWidth: 72, whiteSpace: 'nowrap' }}>
                  {clockTime(u.nextRunAt)}
                </span>
                <span className="grow">
                  <span className="title">{u.name}</span>
                  <span className="sub">{relativeTime(u.nextRunAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      {d && d.failures.length === 0 && d.approvals.length === 0 && d.live.length === 0 && d.upcoming.length === 0 && (
        <div className="banner info">
          New here? <Link to={org.path('/jobs/new')}>Create your first job</Link>, or <Link to={org.path('/settings/models')}>add a model key</Link> so agents can run.
        </div>
      )}
    </>
  )
}
