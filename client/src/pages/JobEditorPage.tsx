// Create or edit a job: trigger plus an ordered list of steps.

import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBanner, Field, Icon, Modal } from '../components/ui'
import { api } from '../lib/api'
import { useApi } from '../lib/hooks'
import type { Environment, Host, Job, StepKind } from '../lib/types'
import { useOrg } from '../shell/OrgContext'
import { emptyJob, emptyStep, fromJob, toPayload, type JobForm, type StepForm } from './jobForm'

export function JobEditorPage() {
  const org = useOrg()
  const navigate = useNavigate()
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const existing = useApi<{ job: Job }>(isNew ? null : org.api(`/jobs/${id}`))
  const hosts = useApi<{ hosts: Host[] }>(org.api('/hosts'))
  const environments = useApi<{ environments: Environment[] }>(org.api('/environments'))
  const [form, setForm] = useState<JobForm>(emptyJob)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState<{ secret: string; url: string; jobId: string } | null>(null)
  const readOnly = !org.can('member')

  useEffect(() => {
    if (existing.data) setForm(fromJob(existing.data.job))
  }, [existing.data])

  const set = (patch: Partial<JobForm>) => setForm((f) => ({ ...f, ...patch }))
  const setStep = (key: string, patch: Partial<StepForm>) => setForm((f) => ({ ...f, steps: f.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) }))
  const move = (i: number, by: -1 | 1) =>
    setForm((f) => {
      const steps = [...f.steps]
      const j = i + by
      if (j < 0 || j >= steps.length) return f
      ;[steps[i], steps[j]] = [steps[j]!, steps[i]!]
      return { ...f, steps }
    })

  async function save(e: FormEvent) {
    e.preventDefault()
    const result = toPayload(form)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setSaving(true)
    setErrors([])
    try {
      const res = isNew
        ? await api<{ job: Job; webhookSecret?: string }>(org.api('/jobs'), { body: result.payload })
        : await api<{ job: Job; webhookSecret?: string }>(org.api(`/jobs/${id}`), { method: 'PUT', body: result.payload })
      if (res.webhookSecret) setSecret({ secret: res.webhookSecret, url: res.job.webhookUrl ?? '', jobId: res.job.id })
      else navigate(org.path(`/jobs/${res.job.id}`), { replace: true })
      if (!isNew) await existing.reload()
    } catch (err) {
      setErrors([(err as Error).message])
    } finally {
      setSaving(false)
    }
  }

  async function runNow() {
    const { run } = await api<{ run: { number: number } }>(org.api(`/jobs/${id}/run`), { method: 'POST' })
    navigate(org.path(`/runs/${run.number}`))
  }
  async function archive() {
    if (!window.confirm('Archive this job? Its runs are kept.')) return
    await api(org.api(`/jobs/${id}`), { method: 'DELETE' })
    navigate(org.path('/jobs'))
  }
  async function rotate() {
    const res = await api<{ job: Job; webhookSecret?: string }>(org.api(`/jobs/${id}`), { method: 'PUT', body: { rotateWebhookSecret: true } })
    if (res.webhookSecret) setSecret({ secret: res.webhookSecret, url: res.job.webhookUrl ?? '', jobId: res.job.id })
  }

  if (existing.error) return <ErrorBanner error={existing.error} />
  const job = existing.data?.job
  return (
    <form className="stack" style={{ gap: 20 }} onSubmit={save}>
      <div className="meta">
        <Link to={org.path('/jobs')}>Jobs</Link> / {isNew ? 'new' : job?.name ?? '…'}
      </div>
      <div className="page-head">
        <h1 className="page-title">{isNew ? 'New job' : job?.name ?? 'Job'}</h1>
        {!isNew && (
          <div className="inline">
            <Link className="btn" to={org.path(`/runs?jobId=${id}`)}>
              Runs
            </Link>
            {!readOnly && (
              <>
                <button type="button" className="btn" onClick={runNow}>
                  <Icon name="play" size={14} /> Run now
                </button>
                <button type="button" className="btn danger" onClick={archive}>
                  Archive
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <div className="card">
          <div className="row">
            <Field label="Name">{(fid) => <input id={fid} className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required />}</Field>
            <Field label="Enabled" hint="Disabled jobs only run when started by hand.">
              {(fid) => (
                <select id={fid} className="select" value={form.enabled ? 'yes' : 'no'} onChange={(e) => set({ enabled: e.target.value === 'yes' })}>
                  <option value="yes">Enabled</option>
                  <option value="no">Disabled</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Description">{(fid) => <textarea id={fid} className="textarea" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        </div>

        <div className="card">
          <h3>Trigger</h3>
          <div className="segmented" role="group" aria-label="Trigger" style={{ alignSelf: 'flex-start' }}>
            {(['manual', 'cron', 'webhook'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={form.triggerKind === k} onClick={() => set({ triggerKind: k })}>
                {k === 'manual' ? 'Manual' : k === 'cron' ? 'Schedule' : 'Webhook'}
              </button>
            ))}
          </div>
          {form.triggerKind === 'cron' && (
            <div className="row">
              <Field label="Cron expression" hint="minute hour day month weekday — e.g. 0 */6 * * * is every 6 hours">
                {(fid) => <input id={fid} className="input mono" value={form.cronExpr} onChange={(e) => set({ cronExpr: e.target.value })} />}
              </Field>
              <Field label="Time zone">{(fid) => <input id={fid} className="input" value={form.cronTz} onChange={(e) => set({ cronTz: e.target.value })} />}</Field>
            </div>
          )}
          {form.triggerKind === 'webhook' && (
            <p className="muted" style={{ margin: 0 }}>
              {job?.webhookUrl ? (
                <>
                  POST to <span className="mono">{window.location.origin + job.webhookUrl}</span> with <span className="mono">Authorization: Bearer &lt;secret&gt;</span> or an
                  <span className="mono"> X-Routini-Signature</span> HMAC.{' '}
                  {!readOnly && (
                    <button type="button" className="btn small" onClick={rotate}>
                      Rotate secret
                    </button>
                  )}
                </>
              ) : (
                'A URL and secret are created when you save.'
              )}
            </p>
          )}
          {job?.nextRunAt && <span className="meta">next run {new Date(job.nextRunAt).toLocaleString()}</span>}
        </div>

        <div className="section">
          <h2 className="section-title">Steps</h2>
          {form.steps.map((s, i) => (
            <StepEditor
              key={s.key}
              index={i}
              step={s}
              hosts={hosts.data?.hosts ?? []}
              environments={environments.data?.environments ?? []}
              count={form.steps.length}
              onChange={(p) => setStep(s.key, p)}
              onMove={(by) => move(i, by)}
              onRemove={() => setForm((f) => ({ ...f, steps: f.steps.filter((x) => x.key !== s.key) }))}
            />
          ))}
          {!readOnly && (
            <div className="inline">
              {(['action', 'agent', 'approval'] as StepKind[]).map((k) => (
                <button key={k} type="button" className="btn" onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, emptyStep(k, f.steps.length)] }))}>
                  <Icon name="plus" size={14} /> {k === 'action' ? 'Action' : k === 'agent' ? 'Agent' : 'Approval'}
                </button>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      {errors.length > 0 && (
        <div className="banner" role="alert">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {!readOnly && (
        <div className="inline">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create job' : 'Save changes'}
          </button>
          <Link className="btn" to={org.path('/jobs')}>
            Cancel
          </Link>
        </div>
      )}

      {secret && (
        <Modal
          title="Webhook secret"
          onClose={() => {
            setSecret(null)
            navigate(org.path(`/jobs/${secret.jobId}`), { replace: true })
          }}
        >
          <p className="lead">Copy this now — it will not be shown again.</p>
          <pre className="code">{secret.secret}</pre>
          <span className="muted">URL</span>
          <pre className="code">{window.location.origin + secret.url}</pre>
          <pre className="code">{`curl -X POST -H 'Authorization: Bearer ${secret.secret}' -H 'Content-Type: application/json' -d '{}' ${window.location.origin}${secret.url}`}</pre>
        </Modal>
      )}
    </form>
  )
}

function StepEditor(props: {
  index: number
  step: StepForm
  hosts: Host[]
  environments: Environment[]
  count: number
  onChange: (p: Partial<StepForm>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const { step: s, onChange: set, index } = props
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <span className="meta">
          {index + 1} · {s.kind.toUpperCase()}
        </span>
        <div className="inline">
          <button type="button" className="btn small" aria-label="Move step up" disabled={index === 0} onClick={() => props.onMove(-1)}>
            ↑
          </button>
          <button type="button" className="btn small" aria-label="Move step down" disabled={index === props.count - 1} onClick={() => props.onMove(1)}>
            ↓
          </button>
          <button type="button" className="btn small danger" aria-label={`Remove step ${index + 1}`} onClick={props.onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      <div className="row">
        <Field label="Step name">{(id) => <input id={id} className="input" value={s.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
        <Field label="Runs when" hint="Relative to the last step that ran.">
          {(id) => (
            <select id={id} className="select" value={s.when} onChange={(e) => set({ when: e.target.value as StepForm['when'] })}>
              <option value="on_success">previous succeeded</option>
              <option value="on_failure">previous failed</option>
              <option value="always">always</option>
            </select>
          )}
        </Field>
      </div>

      {s.kind === 'action' && (
        <>
          <div className="segmented" role="group" aria-label="Action type" style={{ alignSelf: 'flex-start' }}>
            {(['http', 'ssh', 'imap'] as const).map((t) => (
              <button key={t} type="button" aria-pressed={s.actionType === t} onClick={() => set({ actionType: t })}>
                {t.toUpperCase()}
              </button>
            ))}
          </div>
          {s.actionType === 'http' && (
            <>
              <div className="row">
                <Field label="URL">{(id) => <input id={id} className="input" value={s.url} placeholder="https://api.example.com/health" onChange={(e) => set({ url: e.target.value })} />}</Field>
                <Field label="Method">
                  {(id) => (
                    <select id={id} className="select" value={s.method} onChange={(e) => set({ method: e.target.value })}>
                      {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Expected status">{(id) => <input id={id} className="input" inputMode="numeric" placeholder="200" value={s.expectStatus} onChange={(e) => set({ expectStatus: e.target.value })} />}</Field>
              </div>
              <div className="row">
                <Field label="Headers (JSON)">{(id) => <textarea id={id} className="textarea mono" rows={2} value={s.headersJson} onChange={(e) => set({ headersJson: e.target.value })} />}</Field>
                <Field label="Body">{(id) => <textarea id={id} className="textarea mono" rows={2} value={s.body} onChange={(e) => set({ body: e.target.value })} />}</Field>
              </div>
            </>
          )}
          {s.actionType === 'ssh' && (
            <div className="row">
              <Field label="Host" hint={props.hosts.length === 0 ? 'Add hosts in Settings → Hosts.' : undefined}>
                {(id) => (
                  <select id={id} className="select" value={s.hostId} onChange={(e) => set({ hostId: e.target.value })}>
                    <option value="">Choose a host…</option>
                    {props.hosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} ({h.address})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Command" hint="Runs in a shell on the host; pipes and && work.">
                {(id) => <input id={id} className="input mono" value={s.command} placeholder="df -h / | tail -1" onChange={(e) => set({ command: e.target.value })} />}
              </Field>
            </div>
          )}
          {s.actionType === 'imap' && (
            <div className="row">
              <Field label="IMAP host">{(id) => <input id={id} className="input" value={s.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />}</Field>
              <Field label="Username">{(id) => <input id={id} className="input" value={s.imapUser} onChange={(e) => set({ imapUser: e.target.value })} />}</Field>
              <Field label="Password credential" hint="Key from Settings → Credentials.">
                {(id) => <input id={id} className="input mono" value={s.imapCredential} onChange={(e) => set({ imapCredential: e.target.value })} />}
              </Field>
              <Field label="Search">
                {(id) => (
                  <select id={id} className="select" value={s.search || 'UNSEEN'} onChange={(e) => set({ search: e.target.value })}>
                    {['UNSEEN', 'SEEN', 'ALL', 'FLAGGED', 'UNFLAGGED'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          )}
        </>
      )}

      {s.kind === 'agent' && (
        <>
          <Field label="What should the agent do?">
            {(id) => (
              <textarea id={id} className="textarea" rows={4} value={s.prompt} placeholder="Update dependencies, fix anything that breaks, keep the tests green." onChange={(e) => set({ prompt: e.target.value })} />
            )}
          </Field>
          <div className="row">
            <Field label="Agent">
              {(id) => (
                <select id={id} className="select" value={s.agent} onChange={(e) => set({ agent: e.target.value as StepForm['agent'] })}>
                  <option value="claude">Claude Code</option>
                  <option value="omnimancer">Omnimancer</option>
                  <option value="opencode">OpenCode</option>
                </select>
              )}
            </Field>
            <Field label="Model" hint="Blank uses the org default.">{(id) => <input id={id} className="input mono" value={s.model} onChange={(e) => set({ model: e.target.value })} />}</Field>
          </div>
          <Field label="Runs in" hint={s.environmentId ? 'Works in its own git worktree inside the environment; your checkout is not touched.' : 'A fresh container, removed afterwards.'}>
            {(id) => (
              <select id={id} className="select" value={s.environmentId} onChange={(e) => set({ environmentId: e.target.value })}>
                <option value="">A fresh container</option>
                {props.environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    Environment: {env.name}
                    {env.repo ? ` (${env.repo.url.replace(/^https:\/\//, '')})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="row">
            {!s.environmentId && (
              <>
                <Field label="Repository (optional)" hint="https URL on GitHub, GitLab, Bitbucket or Azure DevOps.">
                  {(id) => <input id={id} className="input" value={s.repoUrl} placeholder="https://github.com/acme/app" onChange={(e) => set({ repoUrl: e.target.value })} />}
                </Field>
                <Field label="Base branch">{(id) => <input id={id} className="input mono" value={s.baseBranch} onChange={(e) => set({ baseBranch: e.target.value })} />}</Field>
              </>
            )}
            <Field label="Result">
              {(id) => (
                <select id={id} className="select" value={s.output} disabled={!s.repoUrl.trim() && !s.environmentId} onChange={(e) => set({ output: e.target.value as StepForm['output'] })}>
                  <option value="pr">Open a pull request</option>
                  <option value="branch">Push a branch</option>
                  <option value="none">Nothing (report only)</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Done check (optional)" hint="Runs after the agent; the step fails if it exits non-zero. E.g. npm test">
            {(id) => <input id={id} className="input mono" value={s.checkCommand} onChange={(e) => set({ checkCommand: e.target.value })} />}
          </Field>
        </>
      )}

      {s.kind === 'approval' && (
        <div className="row">
          <Field label="What is being approved?">{(id) => <input id={id} className="input" value={s.message} placeholder="Clear 5 GB of journal logs on prod-web-02?" onChange={(e) => set({ message: e.target.value })} />}</Field>
          <Field label="Who can approve">
            {(id) => (
              <select id={id} className="select" value={s.minRole} onChange={(e) => set({ minRole: e.target.value as StepForm['minRole'] })}>
                <option value="member">Any member</option>
                <option value="admin">Admins</option>
                <option value="owner">Owners</option>
              </select>
            )}
          </Field>
        </div>
      )}

      {s.kind !== 'approval' && (
        <details>
          <summary className="muted">Retries and timeout</summary>
          <div className="row" style={{ marginTop: 10 }}>
            <Field label="Retries">
              {(id) => (
                <select id={id} className="select" value={s.retries} onChange={(e) => set({ retries: e.target.value })}>
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Timeout (seconds)" hint={s.kind === 'agent' ? 'Default 1800.' : undefined}>
              {(id) => <input id={id} className="input" inputMode="numeric" value={s.timeoutSec} onChange={(e) => set({ timeoutSec: e.target.value })} />}
            </Field>
          </div>
        </details>
      )}
    </div>
  )
}
