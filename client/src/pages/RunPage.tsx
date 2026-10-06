// One run: header, live step timeline, approvals, outputs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBanner, RunBadge, StatusDot } from '../components/ui'
import { api } from '../lib/api'
import { duration, money, relativeTime, stepStatusLabel } from '../lib/format'
import { useApi, useEventStream, useTick } from '../lib/hooks'
import type { Approval, RunDetail, RunEvent, RunStep, Step } from '../lib/types'
import { useDock } from '../shell/Dock'
import { useOrg } from '../shell/OrgContext'
import { buildTimeline, mergeEvents, placementLabel } from './timeline'

const STREAM_TYPES = ['status', 'step.status', 'step.placement', 'log', 'agent.init', 'agent.message', 'agent.tool_call', 'agent.tool_result', 'agent.result', 'approval.requested', 'approval.decided', 'artifact', 'cost', 'egress.blocked']

export function RunPage() {
  const org = useOrg()
  const dock = useDock()
  const navigate = useNavigate()
  const { run: ref = '' } = useParams()
  const detail = useApi<RunDetail>(org.api(`/runs/${ref}`))
  const [events, setEvents] = useState<RunEvent[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useTick(1000)

  // Status-changing events refresh the run/steps/approvals (coalesced).
  const pending = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (pending.current !== null) return
    pending.current = window.setTimeout(() => {
      pending.current = null
      void detail.reload()
    }, 250)
  }, [detail])
  useEffect(() => () => {
    if (pending.current !== null) window.clearTimeout(pending.current)
  }, [])
  useEffect(() => setEvents([]), [ref])

  useEventStream(
    org.api(`/runs/${ref}/stream`),
    (type, data) => {
      if (type === 'end') {
        scheduleReload()
        return
      }
      setEvents((prev) => mergeEvents(prev, [data as RunEvent]))
      if (type === 'status' || type === 'step.status' || type.startsWith('approval') || type === 'cost' || type === 'artifact') scheduleReload()
    },
    STREAM_TYPES,
  )

  const timeline = useMemo(() => buildTimeline(events), [events])
  const d = detail.data

  async function act(path: string, body: unknown = {}) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await api<{ run?: { number: number } }>(org.api(path), { method: 'POST', body })
      await detail.reload()
      return res
    } catch (err) {
      setActionError((err as Error).message)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  if (detail.error) return <ErrorBanner error={detail.error} />
  if (!d) return <p className="muted">Loading run…</p>
  const { run } = d
  const live = run.status === 'queued' || run.status === 'running' || run.status === 'waiting'

  return (
    <>
      <div className="meta">
        <Link to={org.path('/runs')}>Runs</Link> / #{run.number}
      </div>
      <div className="page-head">
        <div className="inline" style={{ gap: 12 }}>
          <h1 className="page-title" style={{ fontSize: 28 }}>
            {run.jobName}
          </h1>
          <RunBadge status={run.status} />
        </div>
        <div className="inline">
          <button type="button" className="btn" onClick={() => dock.show('live', String(run.number))}>
            Follow in dock
          </button>
          {live && org.can('member') && (
            <button type="button" className="btn danger" disabled={busy || run.cancelRequested} onClick={() => act(`/runs/${run.number}/cancel`)}>
              {run.cancelRequested ? 'Canceling…' : 'Cancel run'}
            </button>
          )}
          {!live && org.can('member') && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                const res = await act(`/runs/${run.number}/rerun`)
                if (res?.run) navigate(org.path(`/runs/${res.run.number}`))
              }}
            >
              Run again
            </button>
          )}
        </div>
      </div>
      <div className="inline meta" style={{ fontSize: 12 }}>
        <span className="badge">run #{run.number}</span>
        <span className="badge">
          trigger: {run.trigger.kind}
          {run.trigger.kind === 'mcp' && typeof run.trigger['tokenName'] === 'string' ? ` · ${run.trigger['tokenName']} (${String(run.trigger['tool'] ?? '')})` : ''}
        </span>
        {run.trigger.kind === 'alert' && typeof run.trigger['incidentNumber'] === 'number' && (
          <Link className="badge fail" to={org.path(`/incidents/${run.trigger['incidentNumber']}`)}>
            incident #{run.trigger['incidentNumber']}
          </Link>
        )}
        <span className="badge">started {relativeTime(run.startedAt ?? run.createdAt)}</span>
        <span className="badge">{duration(run.startedAt, run.finishedAt)}</span>
        <span className="badge">model spend {money(run.costUsd)}</span>
        {run.agentSeconds > 0 && <span className="badge">agent time {duration(new Date(0).toISOString(), new Date(run.agentSeconds * 1000).toISOString())}</span>}
        <Link className="badge accent" to={org.path(`/jobs/${run.jobId}`)}>
          job
        </Link>
      </div>
      {run.error && run.status === 'failed' && <div className="banner">{run.error}</div>}
      <ErrorBanner error={actionError} />

      <ol className="timeline" aria-label="Steps">
        {d.steps.map((s, i) => (
          <StepItem
            key={s.idx}
            step={s}
            spec={run.jobSnapshot.steps[s.idx]}
            events={timeline.byStep.get(s.idx) ?? []}
            approval={[...d.approvals].reverse().find((a) => a.stepIdx === s.idx)}
            last={i === d.steps.length - 1}
            canDecide={(min) => org.can(min)}
            busy={busy}
            decide={(decision, comment) => act(`/runs/${run.number}/steps/${s.idx}/${decision}`, comment ? { comment } : {})}
          />
        ))}
      </ol>

      {timeline.artifacts.length > 0 && (
        <section className="section" aria-labelledby="outputs">
          <h2 id="outputs" className="section-title">
            Outputs
          </h2>
          <div className="row">
            {timeline.artifacts.map((a) => (
              <a key={a.id} className="card" style={{ textDecoration: 'none', color: 'var(--ink)' }} href={String(a.data['url'] ?? '#')} target="_blank" rel="noreferrer">
                <span className="meta" style={{ color: 'var(--accent)' }}>
                  {a.data['kind'] === 'pull_request' ? `PULL REQUEST${a.data['number'] ? ` #${String(a.data['number'])}` : ''}${a.data['source'] === 'factory' ? ' · FACTORY' : ''}` : 'BRANCH'}
                </span>
                <span>{String(a.data['branch'] ?? a.data['url'])}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function stepSummary(spec: Step | undefined): string {
  if (!spec) return ''
  if (spec.kind === 'action') {
    const c = spec.config
    if (c.type === 'http') return `${c.method ?? 'GET'} ${c.url}`
    if (c.type === 'ssh') return `${c.host === 'alert' ? "alert's host" : 'host'}: ${c.command}`
    if (c.type === 'factory') return c.operation === 'prd' ? `factory: execute PRD ${c.prdId}` : `factory: orchestrate ${c.projectId} · ${c.runtime ?? 'claude-code'}${c.model ? ` · ${c.model}` : ''}`
    return `imap: ${c.username}@${c.host}`
  }
  if (spec.kind === 'agent') return `${spec.config.agent}${spec.config.environmentId ? ' · in an environment' : spec.config.repo ? ` · ${spec.config.repo.url}@${spec.config.repo.baseBranch}` : ''}`
  return spec.config.message
}

function StepItem(props: {
  step: RunStep
  spec: Step | undefined
  events: RunEvent[]
  approval: Approval | undefined
  last: boolean
  canDecide: (min: 'member' | 'admin' | 'owner') => boolean
  busy: boolean
  decide: (decision: 'approve' | 'deny', comment: string) => Promise<unknown>
}) {
  const { step, spec, events, approval, last } = props
  const [comment, setComment] = useState('')
  const output = step.output ?? {}
  const pr = output['pullRequest'] as { url: string; number: number } | undefined
  const placement = placementLabel(events)
  return (
    <li className="tl-item">
      <div className="tl-rail">
        <StatusDot status={step.status} label={stepStatusLabel(step.status)} />
        {!last && <span className="line" />}
      </div>
      <div className="tl-body">
        <div className="meta">
          {step.idx + 1} · {step.kind.toUpperCase()} · {stepStatusLabel(step.status)}
          {step.attempt > 1 ? ` · attempt ${step.attempt}` : ''}
          {step.startedAt ? ` · ${duration(step.startedAt, step.finishedAt)}` : ''}
        </div>
        <div className="inline" style={{ gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{step.name}</span>
          {placement && <span className="badge" title="Where this step executed">{placement}</span>}
        </div>
        <div className="mono muted" style={{ fontSize: 12 }}>
          {stepSummary(spec)}
        </div>
        {spec?.kind === 'agent' && <details><summary className="muted">Prompt</summary><pre className="code">{spec.config.prompt}</pre></details>}

        {events.length > 0 && (
          <div className="tl-entries">
            {events.map((e) => (
              <EventLine key={e.id} e={e} />
            ))}
          </div>
        )}

        {approval && (
          <div className="approval-box">
            {approval.source === 'policy' && (
              <div className="meta" style={{ color: 'var(--warn)' }}>
                POLICY{approval.rule ? ` · ${approval.rule}` : ''}
              </div>
            )}
            <div style={{ fontWeight: 600 }}>{approval.message}</div>
            {approval.status === 'pending' ? (
              props.canDecide(approval.minRole === 'viewer' ? 'member' : (approval.minRole as 'member' | 'admin' | 'owner')) ? (
                <>
                  <label className="sr-only" htmlFor={`c-${step.idx}`}>
                    Comment
                  </label>
                  <textarea id={`c-${step.idx}`} className="textarea" rows={2} placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div className="inline">
                    <button type="button" className="btn primary" disabled={props.busy} onClick={() => props.decide('approve', comment)}>
                      Approve
                    </button>
                    <button type="button" className="btn" disabled={props.busy} onClick={() => props.decide('deny', comment)}>
                      Deny
                    </button>
                  </div>
                </>
              ) : (
                <span className="muted">Waiting for someone with the {approval.minRole} role.</span>
              )
            ) : (
              <span className="muted">
                {approval.status}
                {approval.decidedAt ? ` ${relativeTime(approval.decidedAt)}` : ''}
                {approval.comment ? ` — “${approval.comment}”` : ''}
              </span>
            )}
          </div>
        )}

        {step.error && <div className="banner">{step.error}</div>}
        {pr && (
          <a className="btn" href={pr.url} target="_blank" rel="noreferrer">
            Pull request #{pr.number}
          </a>
        )}
      </div>
    </li>
  )
}

function EventLine({ e }: { e: RunEvent }) {
  const d = e.data
  switch (e.type) {
    case 'log':
      return <div className={`tl-entry${d['stream'] === 'stderr' ? ' stderr' : ''}`}>{String(d['message'] ?? '')}</div>
    case 'agent.message':
      return <div className="tl-entry msg">{String(d['text'] ?? '')}</div>
    case 'agent.tool_call':
      return (
        <div className="tl-entry">
          <span className="tool">{String(d['name'])}</span> {String(d['input'] ?? '')}
        </div>
      )
    case 'agent.tool_result':
      return (
        <div className="tl-entry" style={d['ok'] === false ? { color: 'var(--fail)' } : undefined}>
          {String(d['output'] ?? '')}
        </div>
      )
    case 'agent.init':
      return <div className="tl-entry muted">agent started · model {String(d['model'] ?? 'default')}</div>
    case 'agent.result':
      return <div className="tl-entry msg">{String(d['summary'] ?? (d['ok'] ? 'Agent finished.' : 'Agent reported an error.'))}</div>
    case 'approval.requested':
      return <div className="tl-entry">{d['source'] === 'policy' ? `approval required by policy${d['rule'] ? ` “${String(d['rule'])}”` : ''}` : 'approval requested'}</div>
    case 'egress.blocked':
      return (
        <div className="tl-entry" style={{ color: 'var(--warn)' }}>
          blocked outbound (not on the allow-list): {((d['hosts'] as string[] | undefined) ?? []).join(', ')}
        </div>
      )
    case 'approval.decided':
      return (
        <div className="tl-entry">
          {String(d['decision'])} by {String(d['by'])}
          {d['comment'] ? `: ${String(d['comment'])}` : ''}
        </div>
      )
    case 'artifact':
      return <div className="tl-entry">output: {String(d['url'] ?? d['branch'] ?? d['kind'])}</div>
    default:
      return null
  }
}
