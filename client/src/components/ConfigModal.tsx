/**
 * ConfigModal — centered, editable configuration dialog for a single task.
 * Replaces the old side-drawer TaskConfigPanel with a centered modal (dimmed
 * backdrop) that lets the user actually edit and persist fields instead of
 * just viewing them:
 *
 *   daily          — name, description, schedule, actionType, config keys
 *   developmental  — name, description, repoUrl, branch, agentId
 *   routine        — name, description, plus the full RoutineBuilder step editor
 *
 * Rendering model:
 *  - Renders as a fixed-position overlay (backdrop + centered card), never
 *    inline in a TaskCard's normal document flow. This guarantees opening
 *    the modal never resizes the card or reflows sibling cards/buckets.
 *  - Whoever mounts this component is responsible for mounting exactly one
 *    at a time and unmounting it on close — this component itself doesn't
 *    coordinate that.
 *
 * Live updates: each form seeds its local editing state once, from the
 * `task` prop present when the modal is mounted (the same pattern already
 * used by RoutineBuilder for steps). Saves are explicit (Save button) rather
 * than autosaved, and a successful save's `task:updated` SSE broadcast flows
 * back through the parent's task list — so the next time this modal is
 * opened for the task, it reflects the latest server state. The modal does
 * not auto-close on save, so the user can keep editing/saving without
 * losing their place, mirroring RoutineBuilder's "Save Steps" behavior.
 *
 * Close affordances: an explicit ✕ button, clicking the backdrop, and the
 * Escape key all close the modal.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Task, DailyTask, DevTask, Routine, DailyActionType, RoutineStep } from '../types'
import { RoutineBuilder } from './RoutineBuilder'
import { apiFetch } from '../api'
import {
  AGENT_OPTIONS,
  DAILY_ACTION_TYPES,
  buildDailyUpdatePayload,
  buildDevUpdatePayload,
  buildMetaUpdatePayload,
  validateDailyForm,
  validateDevForm,
  validateMetaForm,
} from './configModal.utils'
import type { ConfigRow } from './configModal.utils'
import './ConfigModal.css'

export interface ConfigModalProps {
  task: Task
  /**
   * Every task in the system. Used to populate RoutineBuilder's
   * available-task palette when `task.type === 'routine'`; ignored
   * otherwise. Defaults to an empty list.
   */
  allTasks?: Task[]
  onClose: () => void
}

// ── Shared API helpers ───────────────────────────────────────────────────────

/**
 * Persists a partial task update via PUT /api/tasks/:id and returns the
 * server's updated task. Throws an Error (with server-provided detail when
 * available) on failure so callers can surface it inline instead of it
 * disappearing silently.
 */
async function saveTask(taskId: string, payload: Record<string, unknown>): Promise<Task> {
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await res.json().catch(() => ({}))) as Task & { error?: string }
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Failed to save task (HTTP ${res.status})`)
  }
  return body
}

/**
 * Persists routine steps via PUT /api/tasks/:id/steps (unchanged from the
 * previous TaskConfigPanel). The server broadcasts a 'task:updated' SSE
 * event on success, which is how the rest of the app (Dashboard's task
 * list) learns about the change.
 */
async function saveRoutineSteps(taskId: string, steps: RoutineStep[]): Promise<void> {
  const res = await apiFetch(`/api/tasks/${taskId}/steps`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Failed to save routine steps (HTTP ${res.status})`)
  }
}

// ── Shared form pieces ────────────────────────────────────────────────────────

/**
 * Exported so other modals that reuse ConfigModal's overlay/panel chrome
 * (see client/src/components/IntegrationModal.tsx) can build visually
 * consistent forms without duplicating this markup.
 */
export function FormRow({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="cm-form-row">
      <label htmlFor={id} className="cm-form-label">
        {label}
      </label>
      {children}
      {hint && <p className="cm-form-hint">{hint}</p>}
    </div>
  )
}

/** Exported for reuse by IntegrationModal — see FormRow above. */
export function FormStatus({ error, saved, savedText = 'Saved' }: { error: string | null; saved: boolean; savedText?: string }) {
  if (error) return <p className="cm-error" role="alert">{error}</p>
  if (saved) return <p className="cm-success" role="status">{savedText}</p>
  return null
}

// ── Daily task form ────────────────────────────────────────────────────────────

function DailyForm({ task, onClose }: { task: DailyTask; onClose: () => void }) {
  const [name, setName] = useState(task.name)
  const [description, setDescription] = useState(task.description)
  const [schedule, setSchedule] = useState(task.schedule)
  const [actionType, setActionType] = useState<DailyActionType>(task.actionType)
  const [configRows, setConfigRows] = useState<ConfigRow[]>([{ key: '', value: '' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const markDirty = () => {
    setSaved(false)
    setError(null)
  }

  const updateRow = (index: number, field: 'key' | 'value', rowValue: string) => {
    setConfigRows(prev => prev.map((row, i) => (i === index ? { ...row, [field]: rowValue } : row)))
    markDirty()
  }
  const addRow = () => {
    setConfigRows(prev => [...prev, { key: '', value: '' }])
    markDirty()
  }
  const removeRow = (index: number) => {
    setConfigRows(prev => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
    markDirty()
  }

  const handleSave = async () => {
    const values = { name, description, schedule, actionType, configRows }
    const validationError = validateDailyForm(values)
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await saveTask(task.id, buildDailyUpdatePayload(values))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <FormRow id={`cm-name-${task.id}`} label="Name">
        <input
          id={`cm-name-${task.id}`}
          className="cm-input"
          value={name}
          onChange={e => {
            setName(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-desc-${task.id}`} label="Description">
        <textarea
          id={`cm-desc-${task.id}`}
          className="cm-input cm-textarea"
          rows={2}
          value={description}
          onChange={e => {
            setDescription(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-schedule-${task.id}`} label="Schedule" hint="Cron expression, e.g. 0 9 * * *">
        <input
          id={`cm-schedule-${task.id}`}
          className="cm-input"
          value={schedule}
          onChange={e => {
            setSchedule(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-action-${task.id}`} label="Action Type">
        <select
          id={`cm-action-${task.id}`}
          className="cm-input"
          value={actionType}
          onChange={e => {
            setActionType(e.target.value as DailyActionType)
            markDirty()
          }}
        >
          {DAILY_ACTION_TYPES.map(type => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </FormRow>

      <div className="cm-form-row">
        <span className="cm-form-label">Config</span>
        <p className="cm-form-hint">
          Existing values aren't shown here (they may hold credentials). Fill in rows to set or
          replace individual keys — leave every row blank to keep the stored config unchanged.
        </p>
        <div className="cm-config-rows">
          {configRows.map((row, i) => (
            <div className="cm-config-row" key={i}>
              <input
                className="cm-input cm-config-key"
                placeholder="key"
                value={row.key}
                onChange={e => updateRow(i, 'key', e.target.value)}
                aria-label={`Config key ${i + 1}`}
              />
              <input
                className="cm-input cm-config-value"
                placeholder="value"
                value={row.value}
                onChange={e => updateRow(i, 'value', e.target.value)}
                aria-label={`Config value ${i + 1}`}
              />
              <button
                type="button"
                className="cm-row-remove"
                onClick={() => removeRow(i)}
                disabled={configRows.length === 1}
                aria-label={`Remove config row ${i + 1}`}
                title="Remove row"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="cm-add-row" onClick={addRow}>
          + Add config key
        </button>
      </div>

      <FormStatus error={error} saved={saved} />

      <div className="cm-footer">
        <button type="button" className="cm-btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="cm-btn-save" onClick={handleSave} disabled={saving} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}

// ── Developmental task form ───────────────────────────────────────────────────

function DevForm({ task, onClose }: { task: DevTask; onClose: () => void }) {
  const [name, setName] = useState(task.name)
  const [description, setDescription] = useState(task.description)
  const [repoUrl, setRepoUrl] = useState(task.repoUrl)
  const [branch, setBranch] = useState(task.branch)
  const [agentId, setAgentId] = useState(task.agentId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const markDirty = () => {
    setSaved(false)
    setError(null)
  }

  const handleSave = async () => {
    const values = { name, description, repoUrl, branch, agentId }
    const validationError = validateDevForm(values)
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await saveTask(task.id, buildDevUpdatePayload(values))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <FormRow id={`cm-name-${task.id}`} label="Name">
        <input
          id={`cm-name-${task.id}`}
          className="cm-input"
          value={name}
          onChange={e => {
            setName(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-desc-${task.id}`} label="Description">
        <textarea
          id={`cm-desc-${task.id}`}
          className="cm-input cm-textarea"
          rows={2}
          value={description}
          onChange={e => {
            setDescription(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-repo-${task.id}`} label="Repository">
        <input
          id={`cm-repo-${task.id}`}
          className="cm-input"
          value={repoUrl}
          onChange={e => {
            setRepoUrl(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-branch-${task.id}`} label="Branch">
        <input
          id={`cm-branch-${task.id}`}
          className="cm-input"
          value={branch}
          onChange={e => {
            setBranch(e.target.value)
            markDirty()
          }}
        />
      </FormRow>

      <FormRow id={`cm-agent-${task.id}`} label="Agent">
        <select
          id={`cm-agent-${task.id}`}
          className="cm-input"
          value={agentId}
          onChange={e => {
            setAgentId(e.target.value)
            markDirty()
          }}
        >
          {AGENT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FormRow>

      <FormStatus error={error} saved={saved} />

      <div className="cm-footer">
        <button type="button" className="cm-btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="cm-btn-save" onClick={handleSave} disabled={saving} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}

// ── Routine name/description mini-form ────────────────────────────────────────
//
// Steps are edited via the embedded RoutineBuilder below this, which has its
// own save/cancel/close chrome — this form only covers the two plain fields
// RoutineBuilder doesn't manage.

function RoutineMetaForm({ task }: { task: Routine }) {
  const [name, setName] = useState(task.name)
  const [description, setDescription] = useState(task.description)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const markDirty = () => {
    setSaved(false)
    setError(null)
  }

  const handleSave = async () => {
    const values = { name, description }
    const validationError = validateMetaForm(values)
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await saveTask(task.id, buildMetaUpdatePayload(values))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cm-routine-meta">
      <div className="cm-routine-meta-fields">
        <FormRow id={`cm-rname-${task.id}`} label="Name">
          <input
            id={`cm-rname-${task.id}`}
            className="cm-input"
            value={name}
            onChange={e => {
              setName(e.target.value)
              markDirty()
            }}
          />
        </FormRow>
        <FormRow id={`cm-rdesc-${task.id}`} label="Description">
          <input
            id={`cm-rdesc-${task.id}`}
            className="cm-input"
            value={description}
            onChange={e => {
              setDescription(e.target.value)
              markDirty()
            }}
          />
        </FormRow>
      </div>
      <FormStatus error={error} saved={saved} />
      <div className="cm-routine-meta-actions">
        <button
          type="button"
          className="cm-btn-save cm-btn-sm"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save Name & Description'}
        </button>
      </div>
    </div>
  )
}

// ── Root component ────────────────────────────────────────────────────────────

export function ConfigModal({ task, allTasks = [], onClose }: ConfigModalProps) {
  // Close on Escape for keyboard/accessibility parity with the close button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Routines get RoutineBuilder's own header/footer/close chrome for step
  // editing — only the name/description mini-form is unique to this modal.
  if (task.type === 'routine') {
    return (
      <div className="cm-overlay" role="presentation" onClick={onClose}>
        <div className="cm-panel cm-panel--routine" onClick={e => e.stopPropagation()}>
          <RoutineMetaForm task={task} />
          <RoutineBuilder
            routine={task}
            allTasks={allTasks}
            onSave={steps => saveRoutineSteps(task.id, steps)}
            onClose={onClose}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="cm-overlay" role="presentation" onClick={onClose}>
      <div
        className="cm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Configuration for ${task.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="cm-header">
          <div>
            <h2 className="cm-title">Configuration</h2>
            <p className="cm-subtitle">{task.name}</p>
          </div>
          <button
            className="cm-close"
            onClick={onClose}
            aria-label="Close configuration modal"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="cm-body">
          {task.type === 'daily' ? (
            <DailyForm task={task} onClose={onClose} />
          ) : (
            <DevForm task={task} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  )
}
