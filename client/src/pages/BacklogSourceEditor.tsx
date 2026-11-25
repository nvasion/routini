// Add or edit a backlog source: name, kind-specific config, default repo,
// Factory project, sync interval, and the status mapping (section 9 of
// docs/work-intake-backlog.md). Pure form logic lives in backlogForm.ts.

import { useState } from 'react'
import { ErrorBanner, Field, Modal } from '../components/ui'
import { api } from '../lib/api'
import type { BacklogSource, SourceTestResult } from '../lib/types'
import { useOrg } from '../shell/OrgContext'
import { emptySourceForm, fromSource, KIND_INTEGRATION, KIND_LABELS, setStatusRole, statusRole, toPayload, type SourceForm, type StatusRole } from './backlogForm'

const STATE_LABELS: Record<string, string> = { ready: 'Ready', planning: 'Planning', building: 'Building', finishing: 'Finishing', done: 'Done', blocked: 'Blocked', dropped: 'Dropped' }

/** How the Test preview labels what a sync would do with an item in a given status. */
const ROLE_BADGE: Record<StatusRole, { label: string; className: string }> = {
  ready: { label: 'Imports as ready', className: 'badge ok' },
  dropped: { label: 'Counts as dropped', className: 'badge warn' },
  ignored: { label: 'Ignored', className: 'badge' },
}

export function BacklogSourceEditor({ source, onClose, onSaved }: { source: BacklogSource | null; onClose: () => void; onSaved: (source: BacklogSource) => void }) {
  const org = useOrg()
  const [form, setForm] = useState<SourceForm>(() => (source ? fromSource(source) : emptySourceForm()))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<SourceTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const set = (patch: Partial<SourceForm>) => setForm((f) => ({ ...f, ...patch }))
  const setMapping = (state: string, patch: Partial<SourceForm['mapping'][number]>) =>
    setForm((f) => ({ ...f, mapping: f.mapping.map((r) => (r.state === state ? { ...r, ...patch } : r)) }))

  async function save() {
    const result = toPayload(form)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setSaving(true)
    setErrors([])
    try {
      const res = form.id
        ? await api<{ source: BacklogSource }>(org.api(`/backlog/sources/${form.id}`), { method: 'PUT', body: result.payload })
        : await api<{ source: BacklogSource }>(org.api('/backlog/sources'), { body: result.payload })
      onSaved(res.source)
      onClose()
    } catch (err) {
      setErrors([(err as Error).message])
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    if (!form.id) return
    setTesting(true)
    setTestError(null)
    try {
      setTest(await api<SourceTestResult>(org.api(`/backlog/sources/${form.id}/test`), { method: 'POST', body: {} }))
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal title={form.id ? 'Edit source' : 'Add source'} onClose={onClose} wide>
      <div className="stack" style={{ gap: 16 }}>
        <ErrorBanner error={errors[0] ? errors.join(' ') : null} />
        <div className="row">
          <Field label="Name">{(id) => <input id={id} className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />}</Field>
          <Field label="Kind">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.kind}
                disabled={form.id !== null}
                onChange={(e) => setForm((f) => ({ ...emptySourceForm(e.target.value as SourceForm['kind']), id: f.id, name: f.name, enabled: f.enabled }))}
              >
                {(Object.keys(KIND_LABELS) as SourceForm['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Enabled">
            {(id) => (
              <select id={id} className="select" value={form.enabled ? 'yes' : 'no'} onChange={(e) => set({ enabled: e.target.value === 'yes' })}>
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            )}
          </Field>
        </div>

        <p className="meta">{KIND_LABELS[form.kind]} sources need the {KIND_INTEGRATION[form.kind]} integration connected.</p>

        {form.kind === 'monday' && (
          <div className="row">
            <Field label="Board id" hint="Digits only.">{(id) => <input id={id} className="input mono" value={form.mondayBoardId} onChange={(e) => set({ mondayBoardId: e.target.value })} />}</Field>
            <Field label="Group id (optional)">{(id) => <input id={id} className="input mono" value={form.mondayGroupId} onChange={(e) => set({ mondayGroupId: e.target.value })} />}</Field>
            <Field label="Status column id">{(id) => <input id={id} className="input mono" value={form.mondayStatusColumnId} onChange={(e) => set({ mondayStatusColumnId: e.target.value })} />}</Field>
            <Field label="Repository column id (optional)">{(id) => <input id={id} className="input mono" value={form.mondayRepoColumnId} onChange={(e) => set({ mondayRepoColumnId: e.target.value })} />}</Field>
            <Field label="Labels column id (optional)">{(id) => <input id={id} className="input mono" value={form.mondayLabelsColumnId} onChange={(e) => set({ mondayLabelsColumnId: e.target.value })} />}</Field>
          </div>
        )}

        {form.kind === 'repo' && (
          <>
            <div className="row">
              <Field label="Repository URL" hint="https://github.com/<owner>/<repo>">{(id) => <input id={id} className="input" value={form.repoUrl} onChange={(e) => set({ repoUrl: e.target.value })} />}</Field>
              <Field label="Tracking branch">{(id) => <input id={id} className="input mono" value={form.repoBranch} onChange={(e) => set({ repoBranch: e.target.value })} />}</Field>
              <Field label="Glob" hint="Matches spec files, e.g. specs/**/*.md">{(id) => <input id={id} className="input mono" value={form.repoGlob} onChange={(e) => set({ repoGlob: e.target.value })} />}</Field>
            </div>
            <div className="row">
              <Field label="Status is stored as">
                {(id) => (
                  <select id={id} className="select" value={form.repoStatusKind} onChange={(e) => set({ repoStatusKind: e.target.value as SourceForm['repoStatusKind'] })}>
                    <option value="frontmatter">Front matter field</option>
                    <option value="line">A line prefix</option>
                  </select>
                )}
              </Field>
              {form.repoStatusKind === 'frontmatter' ? (
                <Field label="Front matter key">{(id) => <input id={id} className="input mono" value={form.repoStatusKey} onChange={(e) => set({ repoStatusKey: e.target.value })} />}</Field>
              ) : (
                <Field label="Line prefix">{(id) => <input id={id} className="input mono" value={form.repoStatusPrefix} onChange={(e) => set({ repoStatusPrefix: e.target.value })} />}</Field>
              )}
              <Field label="Repository key (optional)" hint="A front matter field naming each item's own repository.">
                {(id) => <input id={id} className="input mono" value={form.repoKey} onChange={(e) => set({ repoKey: e.target.value })} />}
              </Field>
            </div>
          </>
        )}

        {form.kind === 'jira' && (
          <div className="row">
            <Field label="JQL" hint="Any JQL, e.g. project = SHOP AND labels = agent-ok">
              {(id) => <input id={id} className="input mono" value={form.jiraJql} onChange={(e) => set({ jiraJql: e.target.value })} />}
            </Field>
            <Field label="Repository field (optional)" hint="A custom field id holding each item's repository, e.g. customfield_10050">
              {(id) => <input id={id} className="input mono" value={form.jiraRepoField} onChange={(e) => set({ jiraRepoField: e.target.value })} />}
            </Field>
          </div>
        )}

        {form.kind === 'linear' && (
          <div className="row">
            <Field label="Team key" hint="e.g. ENG">{(id) => <input id={id} className="input mono" value={form.linearTeamKey} onChange={(e) => set({ linearTeamKey: e.target.value })} />}</Field>
            <Field label="Labels (optional)" hint="Comma separated; an issue must carry every one to be imported.">
              {(id) => <input id={id} className="input mono" value={form.linearLabels} onChange={(e) => set({ linearLabels: e.target.value })} />}
            </Field>
          </div>
        )}

        {form.kind === 'azure-boards' && (
          <div className="row">
            <Field label="Project">{(id) => <input id={id} className="input" value={form.azureProject} onChange={(e) => set({ azureProject: e.target.value })} />}</Field>
            <Field label="WIQL (optional)" hint="Default: the project's work items not in Closed, Done or Removed.">
              {(id) => <textarea id={id} className="textarea mono" rows={3} value={form.azureWiql} onChange={(e) => set({ azureWiql: e.target.value })} />}
            </Field>
            <Field label="Repository field (optional)" hint="A work item field naming each item's repository, e.g. Custom.Repository">
              {(id) => <input id={id} className="input mono" value={form.azureRepoField} onChange={(e) => set({ azureRepoField: e.target.value })} />}
            </Field>
          </div>
        )}

        {form.kind === 'github-issues' && (
          <div className="row">
            <Field label="Repository URL" hint="https://github.com/<owner>/<repo>">
              {(id) => <input id={id} className="input" value={form.githubIssuesRepoUrl} onChange={(e) => set({ githubIssuesRepoUrl: e.target.value })} />}
            </Field>
            <Field label="Labels (optional)" hint="Comma separated; filters which issues are imported.">
              {(id) => <input id={id} className="input mono" value={form.githubIssuesLabels} onChange={(e) => set({ githubIssuesLabels: e.target.value })} />}
            </Field>
            <Field label="Status label prefix" hint="Status comes from labels like status:Ready">
              {(id) => <input id={id} className="input mono" value={form.githubIssuesStatusPrefix} onChange={(e) => set({ githubIssuesStatusPrefix: e.target.value })} />}
            </Field>
          </div>
        )}

        <div className="row">
          <Field label="Default repository (optional)">{(id) => <input id={id} className="input" value={form.defaultRepoUrl} onChange={(e) => set({ defaultRepoUrl: e.target.value })} />}</Field>
          <Field label="Default base branch">{(id) => <input id={id} className="input mono" value={form.defaultBaseBranch} onChange={(e) => set({ defaultBaseBranch: e.target.value })} />}</Field>
          <Field label="Factory project (optional)">{(id) => <input id={id} className="input mono" value={form.factoryProjectId} onChange={(e) => set({ factoryProjectId: e.target.value })} />}</Field>
          <Field label="Sync every (minutes)">{(id) => <input id={id} className="input" inputMode="numeric" value={form.syncEveryMin} onChange={(e) => set({ syncEveryMin: e.target.value })} />}</Field>
        </div>

        <div className="section">
          <h3 className="section-title">Status mapping</h3>
          <p className="meta">
            Routini reads each item's status from the source to decide what to pick up, and writes a status back as it works on the item. Statuses match by how they start, ignoring case: "Ready" also matches "Ready for Dev".
          </p>
          <div className="row">
            <Field
              label="Counts as ready"
              hint={
                <>
                  Statuses that mean "pick this up". Only items in one of these are imported; everything else is left alone. An imported item that is moved back to one of these becomes Ready again. Example for Azure Boards: <span className="mono">New, Approved</span>.
                </>
              }
            >
              {(id) => <input id={id} className="input" value={form.readyList} onChange={(e) => set({ readyList: e.target.value })} placeholder="New, Approved" />}
            </Field>
            <Field
              label="Counts as dropped (optional)"
              hint={
                <>
                  Statuses that mean "stop". An imported item that moves to one of these becomes Dropped; a run in progress finishes first. Example: <span className="mono">Removed, Won't Do</span>.
                </>
              }
            >
              {(id) => <input id={id} className="input" value={form.droppedList} onChange={(e) => set({ droppedList: e.target.value })} placeholder="Removed" />}
            </Field>
          </div>
          <p className="meta">Comma separated. Not sure what your source calls them? Save, then press Test: it lists every status it finds and lets you pick.</p>
          <h4 className="section-title" style={{ fontSize: 13 }}>Written back as Routini works</h4>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Routini state</th>
                  <th>Value written at the source</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {form.mapping.map((row) => (
                  <tr key={row.state}>
                    <td>{STATE_LABELS[row.state]}</td>
                    <td>
                      <label className="sr-only" htmlFor={`map-${row.state}`}>
                        Value for {STATE_LABELS[row.state]}
                      </label>
                      <input id={`map-${row.state}`} className="input mono" value={row.value} onChange={(e) => setMapping(row.state, { value: e.target.value })} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`Post a comment for ${STATE_LABELS[row.state]}`} checked={row.comment} onChange={(e) => setMapping(row.state, { comment: e.target.checked })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <div className="inline">
            <button type="button" className="btn" disabled={!form.id || testing} onClick={runTest} title={form.id ? undefined : 'Save the source first to test it.'}>
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
          <div className="inline">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add source'}
            </button>
          </div>
        </div>

        <ErrorBanner error={testError} />
        {test && <TestResult test={test} form={form} saved={source} onLists={set} />}
      </div>
    </Modal>
  )
}

/**
 * The Test preview: every status the source returned with what a sync does
 * with it (editable right here: it rewrites "Counts as ready" / "dropped"),
 * then the first items with the same verdict. Uses the form's current lists,
 * so it updates as they change; the next sync uses the saved ones.
 */
function TestResult({
  test,
  form,
  saved,
  onLists,
}: {
  test: SourceTestResult
  form: SourceForm
  saved: BacklogSource | null
  onLists: (patch: Pick<SourceForm, 'readyList' | 'droppedList'>) => void
}) {
  const readyCount = test.states.reduce((n, s) => (statusRole(s.value, form) === 'ready' ? n + s.count : n), 0)
  const unsaved = !!saved && (form.readyList !== saved.mapping.in.ready.join(', ') || form.droppedList !== saved.mapping.in.dropped.join(', '))

  return (
    <div className="stack" style={{ gap: 10 }} aria-label="Test result">
      <span className="meta">
        {test.total} item(s) found. <strong>{readyCount}</strong> {readyCount === 1 ? 'has a status' : 'have a status'} that counts as ready
        {readyCount === 0 && test.total > 0 ? ', so a sync imports nothing yet: set at least one status below to Ready.' : ' and will be imported on the next sync.'}
        {unsaved && ' Save to apply your changes.'}
      </span>

      {test.states.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status in the source</th>
                <th>Items</th>
                <th>Counts as</th>
              </tr>
            </thead>
            <tbody>
              {test.states.map((s) => {
                const role = statusRole(s.value, form)
                return (
                  <tr key={s.value}>
                    <td className="mono">{s.value || <span className="meta">(no status)</span>}</td>
                    <td>{s.count}</td>
                    <td>
                      <select
                        className="select"
                        aria-label={`What "${s.value || 'no status'}" counts as`}
                        value={role}
                        disabled={!s.value}
                        onChange={(e) => onLists(setStatusRole(form, s.value, e.target.value as StatusRole))}
                      >
                        <option value="ready">Ready (import)</option>
                        <option value="dropped">Dropped</option>
                        <option value="ignored">Ignored</option>
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {test.items.length > 0 && (
        <>
          <span className="meta">
            First {test.items.length} of {test.total}:
          </span>
          <div className="list">
            {test.items.map((it) => {
              const badge = ROLE_BADGE[statusRole(it.state, form)]
              return (
                <div key={it.externalId} className="list-row" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{it.title}</span>
                    <span className="sub">{it.state || '(no status)'}</span>
                  </span>
                  <span className={badge.className}>{badge.label}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
