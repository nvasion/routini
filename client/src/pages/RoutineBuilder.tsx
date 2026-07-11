/**
 * Routine Builder page.
 *
 * Provides a step-wise editor for composing routine workflows from existing
 * daily and developmental tasks, and a panel for viewing and running existing
 * routines.
 *
 * UI structure
 * ────────────
 *   ┌─────────────────────────────────┐ ┌─────────────────────────────────┐
 *   │  My Routines                    │ │  Build / Edit Routine           │
 *   │  (list with Run / Edit / Delete)│ │  Name, step list, add-step panel│
 *   └─────────────────────────────────┘ └─────────────────────────────────┘
 *
 * Step reordering is accomplished with "Move up / Move down" buttons — a
 * DnD library is not yet available in the project and the step-wise editor
 * satisfies the PRD requirement.
 *
 * Conditions
 * ──────────
 * Each step may optionally carry a condition string that is evaluated at
 * runtime against the previous step's result. The UI exposes a preset
 * dropdown (no free-text entry) to prevent invalid condition strings from
 * reaching the API.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CONDITION_PRESETS,
  TasksApiError,
  createRoutineTask,
  deleteTask,
  executeTask,
  listRuns,
  listTasks,
  updateRoutineTask,
  type RoutineStep,
  type RoutineTask,
  type Task,
  type TaskRun,
} from '../tasks/tasksApi'

// ---------------------------------------------------------------------------
// Types local to this component
// ---------------------------------------------------------------------------

interface DraftStep {
  /** ID of the referenced task */
  taskId: string
  /** Display name (from the resolved task, not stored on the step) */
  taskName: string
  /** Condition value from CONDITION_PRESETS — empty string means no condition */
  condition: string
}

interface RunEntry {
  run: TaskRun
  taskName: string
}

// ---------------------------------------------------------------------------
// Helper: status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`routine-status-badge routine-status-${status}`}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RoutineBuilderPage() {
  // ── Data ────────────────────────────────────────────────────────────────────
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [routines, setRoutines] = useState<RoutineTask[]>([])
  const [recentRuns, setRecentRuns] = useState<RunEntry[]>([])
  const [loadingTasks, setLoadingTasks] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ── Builder form state ───────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null)
  const [routineName, setRoutineName] = useState('')
  const [draftSteps, setDraftSteps] = useState<DraftStep[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formErrorDetails, setFormErrorDetails] = useState<string[]>([])
  const [formSuccess, setFormSuccess] = useState<string | null>(null)

  // ── Run tracking ─────────────────────────────────────────────────────────
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [runError, setRunError] = useState<string | null>(null)

  // ── Refs ─────────────────────────────────────────────────────────────────
  const nameInputRef = useRef<HTMLInputElement>(null)

  // ── Load data on mount ───────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoadError(null)
    setLoadingTasks(true)
    try {
      const tasks = await listTasks()
      setAllTasks(tasks)
      const myRoutines = tasks.filter((t): t is RoutineTask => t.type === 'routine')
      setRoutines(myRoutines)

      // Load recent runs for each routine
      const entries: RunEntry[] = []
      await Promise.all(
        myRoutines.map(async (r) => {
          try {
            const runs = await listRuns(r.id)
            const latest = runs[runs.length - 1]
            if (latest) entries.push({ run: latest, taskName: r.name })
          } catch {
            // Non-fatal — just skip this routine's runs
          }
        }),
      )
      setRecentRuns(entries)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoadingTasks(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // ── Tasks available as steps (daily + developmental only) ────────────────
  const availableTasks = allTasks.filter((t) => t.type !== 'routine')

  // ── Step mutations ───────────────────────────────────────────────────────

  const addStep = useCallback(
    (task: Task) => {
      // Prevent adding the same task twice in a row (allowed if intentional
      // duplication is desired — don't block it, just no double-click accident)
      setDraftSteps((prev) => [
        ...prev,
        { taskId: task.id, taskName: task.name, condition: '' },
      ])
    },
    [],
  )

  const removeStep = useCallback((index: number) => {
    setDraftSteps((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const moveStep = useCallback((index: number, direction: 'up' | 'down') => {
    setDraftSteps((prev) => {
      const next = [...prev]
      const swap = direction === 'up' ? index - 1 : index + 1
      if (swap < 0 || swap >= next.length) return prev
      ;[next[index], next[swap]] = [next[swap], next[index]]
      return next
    })
  }, [])

  const setStepCondition = useCallback((index: number, value: string) => {
    setDraftSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, condition: value } : s)),
    )
  }, [])

  // ── Edit an existing routine ─────────────────────────────────────────────

  const startEdit = useCallback(
    (routine: RoutineTask) => {
      setEditingId(routine.id)
      setRoutineName(routine.name)
      setDraftSteps(
        routine.steps.map((s) => {
          const task = allTasks.find((t) => t.id === s.taskId)
          return {
            taskId: s.taskId,
            taskName: task?.name ?? `Unknown task (${s.taskId})`,
            condition: s.condition ?? '',
          }
        }),
      )
      setFormError(null)
      setFormErrorDetails([])
      setFormSuccess(null)
      setTimeout(() => nameInputRef.current?.focus(), 0)
    },
    [allTasks],
  )

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setRoutineName('')
    setDraftSteps([])
    setFormError(null)
    setFormErrorDetails([])
    setFormSuccess(null)
  }, [])

  // ── Save routine ─────────────────────────────────────────────────────────

  const saveRoutine = useCallback(async () => {
    const name = routineName.trim()
    if (!name) {
      setFormError('Routine name is required')
      return
    }
    if (draftSteps.length === 0) {
      setFormError('A routine must have at least one step')
      return
    }

    const steps: RoutineStep[] = draftSteps.map((s) => ({
      taskId: s.taskId,
      ...(s.condition ? { condition: s.condition } : {}),
    }))

    setFormError(null)
    setFormErrorDetails([])
    setFormSuccess(null)
    setSaving(true)

    try {
      if (editingId) {
        const updated = await updateRoutineTask(editingId, { name, steps })
        setRoutines((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        setFormSuccess(`Routine "${updated.name}" updated`)
        setEditingId(null)
        setRoutineName('')
        setDraftSteps([])
      } else {
        const created = await createRoutineTask({ name, steps })
        setRoutines((prev) => [...prev, created])
        setAllTasks((prev) => [...prev, created])
        setFormSuccess(`Routine "${created.name}" created`)
        setRoutineName('')
        setDraftSteps([])
      }
    } catch (err) {
      if (err instanceof TasksApiError) {
        setFormError(err.message)
        setFormErrorDetails(err.details)
      } else {
        setFormError(err instanceof Error ? err.message : 'Failed to save routine')
      }
    } finally {
      setSaving(false)
    }
  }, [routineName, draftSteps, editingId])

  // ── Run a routine ────────────────────────────────────────────────────────

  const runRoutine = useCallback(async (routine: RoutineTask) => {
    setRunError(null)
    setRunningIds((prev) => new Set(prev).add(routine.id))
    try {
      await executeTask(routine.id)
      // Refresh run history
      const runs = await listRuns(routine.id)
      const latest = runs[runs.length - 1]
      if (latest) {
        setRecentRuns((prev) => {
          const without = prev.filter((e) => e.taskName !== routine.name)
          return [...without, { run: latest, taskName: routine.name }]
        })
      }
      // Refresh task status
      const updated = await listTasks()
      setAllTasks(updated)
      setRoutines(updated.filter((t): t is RoutineTask => t.type === 'routine'))
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to run routine')
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(routine.id)
        return next
      })
    }
  }, [])

  // ── Delete a routine ─────────────────────────────────────────────────────

  const removeRoutine = useCallback(
    async (routine: RoutineTask) => {
      if (!window.confirm(`Delete routine "${routine.name}"? This cannot be undone.`)) return
      try {
        await deleteTask(routine.id)
        setRoutines((prev) => prev.filter((r) => r.id !== routine.id))
        setAllTasks((prev) => prev.filter((t) => t.id !== routine.id))
        setRecentRuns((prev) => prev.filter((e) => e.taskName !== routine.name))
        if (editingId === routine.id) cancelEdit()
      } catch (err) {
        setRunError(err instanceof Error ? err.message : 'Failed to delete routine')
      }
    },
    [editingId, cancelEdit],
  )

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="main routine-layout">
      {/* ── Left panel: existing routines ───────────────────────────────── */}
      <section className="routine-panel" aria-labelledby="routines-heading">
        <h2 id="routines-heading" className="routine-section-heading">My Routines</h2>

        {loadError && <p className="error">{loadError}</p>}
        {runError && <p className="error">{runError}</p>}

        {loadingTasks ? (
          <p className="loading-splash">Loading…</p>
        ) : routines.length === 0 ? (
          <p className="empty">No routines yet. Build one on the right.</p>
        ) : (
          <ul className="list">
            {routines.map((r) => {
              const lastRun = recentRuns.find((e) => e.taskName === r.name)?.run
              const isRunning = runningIds.has(r.id)
              return (
                <li key={r.id} className="routine-item">
                  <div className="routine-item-header">
                    <span className="routine-item-name">{r.name}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="routine-item-meta">
                    {r.steps.length} step{r.steps.length !== 1 ? 's' : ''}
                    {lastRun && (
                      <span>
                        {' · '}Last run:{' '}
                        <StatusBadge status={lastRun.status} />{' '}
                        <span className="routine-item-time">
                          {new Date(lastRun.startedAt).toLocaleString()}
                        </span>
                      </span>
                    )}
                  </p>
                  <div className="routine-item-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => void runRoutine(r)}
                      disabled={isRunning || r.status === 'running' || r.status === 'queued'}
                      aria-label={`Run routine ${r.name}`}
                    >
                      {isRunning ? 'Running…' : 'Run'}
                    </button>
                    <button
                      type="button"
                      className="settings-secondary-btn"
                      onClick={() => startEdit(r)}
                      disabled={isRunning}
                      aria-label={`Edit routine ${r.name}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="delete-btn"
                      onClick={() => void removeRoutine(r)}
                      disabled={isRunning || r.status === 'running'}
                      aria-label={`Delete routine ${r.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── Right panel: builder ────────────────────────────────────────── */}
      <section className="routine-panel" aria-labelledby="builder-heading">
        <h2 id="builder-heading" className="routine-section-heading">
          {editingId ? 'Edit Routine' : 'Build New Routine'}
        </h2>

        {formError && (
          <div className="error" role="alert">
            <span>{formError}</span>
            {formErrorDetails.length > 0 && (
              <ul className="error-details">
                {formErrorDetails.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {formSuccess && (
          <p className="settings-success" role="status">
            {formSuccess}
          </p>
        )}

        {/* Name */}
        <label className="settings-label">
          Routine name
          <input
            ref={nameInputRef}
            type="text"
            className="settings-input"
            value={routineName}
            onChange={(e) => setRoutineName(e.target.value)}
            placeholder="e.g. Morning health check"
            maxLength={200}
            disabled={saving}
          />
        </label>

        {/* Step list */}
        <div className="routine-steps-section">
          <h3 className="routine-steps-heading">
            Steps{' '}
            <span className="settings-badge">
              {draftSteps.length}
            </span>
          </h3>

          {draftSteps.length === 0 ? (
            <p className="empty routine-steps-empty">
              Add steps from the task list below.
            </p>
          ) : (
            <ol className="routine-steps-list">
              {draftSteps.map((step, i) => (
                <li key={`${step.taskId}-${i}`} className="routine-step-item">
                  <div className="routine-step-header">
                    <span className="routine-step-number">{i + 1}</span>
                    <span className="routine-step-name">{step.taskName}</span>
                    <div className="routine-step-controls">
                      <button
                        type="button"
                        className="routine-move-btn"
                        onClick={() => moveStep(i, 'up')}
                        disabled={i === 0 || saving}
                        aria-label={`Move step ${i + 1} up`}
                        title="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="routine-move-btn"
                        onClick={() => moveStep(i, 'down')}
                        disabled={i === draftSteps.length - 1 || saving}
                        aria-label={`Move step ${i + 1} down`}
                        title="Move down"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className="delete-btn routine-remove-btn"
                        onClick={() => removeStep(i)}
                        disabled={saving}
                        aria-label={`Remove step ${i + 1}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Condition selector */}
                  <label className="routine-condition-label">
                    <span className="routine-condition-label-text">Condition</span>
                    <select
                      className="settings-input routine-condition-select"
                      value={step.condition}
                      onChange={(e) => setStepCondition(i, e.target.value)}
                      disabled={saving}
                      aria-label={`Condition for step ${i + 1}`}
                    >
                      {CONDITION_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Available tasks to add */}
        <div className="routine-available-section">
          <h3 className="routine-steps-heading">Available Tasks</h3>
          {availableTasks.length === 0 ? (
            <p className="empty">
              No daily or developmental tasks found.
              Create some tasks first to use as routine steps.
            </p>
          ) : (
            <ul className="routine-available-list">
              {availableTasks.map((t) => (
                <li key={t.id} className="routine-available-item">
                  <div className="routine-available-info">
                    <span className="routine-available-name">{t.name}</span>
                    <span className="settings-badge">
                      {t.type === 'daily'
                        ? `daily / ${'subtype' in t ? t.subtype : ''}`
                        : t.type}
                    </span>
                    <StatusBadge status={t.status} />
                  </div>
                  <button
                    type="button"
                    className="routine-add-step-btn"
                    onClick={() => addStep(t)}
                    disabled={saving}
                    aria-label={`Add ${t.name} as a step`}
                  >
                    + Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Save actions */}
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            onClick={() => void saveRoutine()}
            disabled={saving || !routineName.trim() || draftSteps.length === 0}
          >
            {saving
              ? 'Saving…'
              : editingId
                ? 'Update Routine'
                : 'Create Routine'}
          </button>
          {editingId && (
            <button
              type="button"
              className="settings-secondary-btn"
              onClick={cancelEdit}
              disabled={saving}
            >
              Cancel
            </button>
          )}
        </div>
      </section>
    </main>
  )
}
