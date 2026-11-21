// Add or edit a backlog source: name, kind-specific config, default repo,
// Factory project, sync interval, and the status mapping (section 9 of
// docs/work-intake-backlog.md). Pure form logic lives in backlogForm.ts.

import { useState } from 'react'
import { ErrorBanner, Field, Modal } from '../components/ui'
import { api } from '../lib/api'
import type { BacklogSource, SourceItem } from '../lib/types'
import { useOrg } from '../shell/OrgContext'
import { emptySourceForm, fromSource, KIND_INTEGRATION, KIND_LABELS, toPayload, type SourceForm } from './backlogForm'

const STATE_LABELS: Record<string, string> = { ready: 'Ready', planning: 'Planning', building: 'Building', finishing: 'Finishing', done: 'Done', blocked: 'Blocked', dropped: 'Dropped' }

export function BacklogSourceEditor({ source, onClose, onSaved }: { source: BacklogSource | null; onClose: () => void; onSaved: (source: BacklogSource) => void }) {
  const org = useOrg()
  const [form, setForm] = useState<SourceForm>(() => (source ? fromSource(source) : emptySourceForm()))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<{ items: SourceItem[]; total: number } | null>(null)
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
      setTest(await api<{ items: SourceItem[]; total: number }>(org.api(`/backlog/sources/${form.id}/test`), { method: 'POST', body: {} }))
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
          <div className="row">
            <Field label="Counts as ready" hint="Comma separated external values.">{(id) => <input id={id} className="input" value={form.readyList} onChange={(e) => set({ readyList: e.target.value })} />}</Field>
            <Field label="Counts as dropped" hint="Comma separated external values.">{(id) => <input id={id} className="input" value={form.droppedList} onChange={(e) => set({ droppedList: e.target.value })} />}</Field>
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
        {test && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="meta">{test.total} item(s) found; showing {test.items.length}</span>
            <div className="list">
              {test.items.map((it) => (
                <div key={it.externalId} className="list-row" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{it.title}</span>
                    <span className="sub">{it.externalState}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
