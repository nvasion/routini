/**
 * RoutineBuilder — drag-and-drop step editor for Routine tasks.
 *
 * Layout:
 *   Left panel  — available tasks (daily + developmental) that can be added
 *   Right panel — ordered list of steps, each with an optional condition input
 *
 * Interactions:
 *   • Click an available task  → appends it as a new step
 *   • Drag an available task   → drop onto the steps panel to insert at that position
 *   • Drag a step row          → reorder by dropping onto another step
 *   • Remove button (✕)        → removes the step
 *   • Condition input          → free-form; validated by the server on save
 *
 * Native HTML5 Drag-and-Drop is used (no third-party library).
 */

import { useState, useRef, useCallback } from 'react'
import type { Task, Routine, RoutineStep } from '../types'
import './RoutineBuilder.css'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Working representation of a step while the user is editing. */
interface StepDraft {
  /** Client-generated or server-provided ID — preserved on save. */
  id: string
  taskId: string
  /** 1-based, recalculated whenever the list is reordered. */
  order: number
  /** Empty string means "no condition". */
  condition: string
}

type DragPayload =
  | {
      /** 'task' when dragging from the available-tasks panel. */
      source: 'task'
      taskId: string
    }
  | {
      /** 'step' when reordering an existing step. */
      source: 'step'
      index: number
    }

export interface RoutineBuilderProps {
  routine: Routine
  /** All tasks in the system — used to build the available-task palette. */
  allTasks: Task[]
  /** Called with validated steps when the user clicks "Save Steps". */
  onSave: (steps: RoutineStep[]) => Promise<void>
  onClose: () => void
}

// ── Utility ───────────────────────────────────────────────────────────────────

function genId(): string {
  // crypto.randomUUID() is available on secure contexts (HTTPS or localhost).
  // Fall back to a timestamp-based ID for completeness.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Reorders `order` fields so they are consecutive, starting at 1. */
function reassignOrders(steps: StepDraft[]): StepDraft[] {
  return steps.map((s, i) => ({ ...s, order: i + 1 }))
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RoutineBuilder({ routine, allTasks, onSave, onClose }: RoutineBuilderProps) {
  // Initialise steps from the routine, sorted by order
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    [...routine.steps]
      .sort((a, b) => a.order - b.order)
      .map(s => ({ ...s, condition: s.condition ?? '' })),
  )

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ── Drag-and-drop state ────────────────────────────────────────────────────
  const dragging = useRef<DragPayload | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

  // ── Available tasks palette ────────────────────────────────────────────────
  // Routines cannot contain other routines (infinite recursion prevention).
  const availableTasks = allTasks.filter(t => t.type !== 'routine')

  // ── Step mutation helpers ──────────────────────────────────────────────────

  const appendStep = useCallback((taskId: string) => {
    setSteps(prev =>
      reassignOrders([...prev, { id: genId(), taskId, order: 0, condition: '' }]),
    )
  }, [])

  const insertStep = useCallback((taskId: string, atIndex: number) => {
    setSteps(prev => {
      const next = [...prev]
      next.splice(atIndex, 0, { id: genId(), taskId, order: 0, condition: '' })
      return reassignOrders(next)
    })
  }, [])

  const moveStep = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    setSteps(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return reassignOrders(next)
    })
  }, [])

  const removeStep = useCallback((index: number) => {
    setSteps(prev => reassignOrders(prev.filter((_, i) => i !== index)))
  }, [])

  const updateCondition = useCallback((index: number, condition: string) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, condition } : s)))
  }, [])

  // ── Drag handlers (available-task cards) ───────────────────────────────────

  const onTaskDragStart = (taskId: string) => {
    dragging.current = { source: 'task', taskId }
  }

  // ── Drag handlers (step rows) ──────────────────────────────────────────────

  const onStepDragStart = (index: number, e: React.DragEvent) => {
    dragging.current = { source: 'step', index }
    e.dataTransfer.effectAllowed = 'move'
  }

  const onStepDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault()
    if (dragging.current) setDropTargetIndex(index)
  }

  const onStepDragLeave = () => {
    setDropTargetIndex(null)
  }

  const onStepDrop = (targetIndex: number, e: React.DragEvent) => {
    e.preventDefault()
    setDropTargetIndex(null)
    const d = dragging.current
    dragging.current = null
    if (!d) return

    if (d.source === 'task') {
      insertStep(d.taskId, targetIndex)
    } else {
      moveStep(d.index, targetIndex)
    }
  }

  // ── Drop on the steps-panel background (append) ────────────────────────────

  const onPanelDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    // Only show the full-panel drop indicator when not hovering a step row
    if (dragging.current?.source === 'task' && dropTargetIndex === null) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const onPanelDrop = (e: React.DragEvent) => {
    // Ignore if the drop was handled by a child step row
    if (dropTargetIndex !== null) return
    e.preventDefault()
    const d = dragging.current
    dragging.current = null
    if (d?.source === 'task') appendStep(d.taskId)
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const stepsToSave: RoutineStep[] = steps.map(s => ({
        id: s.id,
        taskId: s.taskId,
        order: s.order,
        ...(s.condition.trim() ? { condition: s.condition.trim() } : {}),
      }))
      await onSave(stepsToSave)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save steps')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="rb" role="dialog" aria-label={`Edit routine: ${routine.name}`}>
      <div className="rb-header">
        <div>
          <h2 className="rb-title">Routine Builder</h2>
          <p className="rb-subtitle">{routine.name}</p>
        </div>
        <button
          className="rb-close"
          onClick={onClose}
          aria-label="Close routine builder"
        >
          ✕
        </button>
      </div>

      <div className="rb-body">
        {/* ── Available tasks palette ───────────────────────────────────── */}
        <div className="rb-palette">
          <h3 className="rb-panel-title">Available Tasks</h3>
          <p className="rb-panel-hint">Click or drag to add</p>

          {availableTasks.length === 0 ? (
            <p className="rb-empty">
              No tasks available. Create daily or developmental tasks first.
            </p>
          ) : (
            <ul className="rb-task-list" role="list">
              {availableTasks.map(task => (
                <li
                  key={task.id}
                  className={`rb-task-item rb-task-${task.type}`}
                  draggable
                  onDragStart={() => onTaskDragStart(task.id)}
                  onClick={() => appendStep(task.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      appendStep(task.id)
                    }
                  }}
                  title={`Add "${task.name}" as a step`}
                >
                  <span className="rb-type-badge">{task.type}</span>
                  <span className="rb-task-name">{task.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Steps panel ──────────────────────────────────────────────── */}
        <div
          className="rb-steps-panel"
          onDragOver={onPanelDragOver}
          onDrop={onPanelDrop}
        >
          <h3 className="rb-panel-title">
            Steps
            <span className="rb-step-count">{steps.length}</span>
          </h3>
          <p className="rb-panel-hint">Drag to reorder • drop a task here to add it</p>

          {steps.length === 0 ? (
            <div className="rb-drop-zone" aria-label="Drop tasks here">
              <span className="rb-drop-icon">⬇</span>
              <p>Drag tasks here to build your routine</p>
            </div>
          ) : (
            <ol className="rb-step-list" aria-label="Routine steps">
              {steps.map((step, index) => {
                const task = allTasks.find(t => t.id === step.taskId)
                const isDragOver = dropTargetIndex === index

                return (
                  <li
                    key={step.id}
                    className={`rb-step-row${isDragOver ? ' rb-step-row--drop-target' : ''}`}
                    draggable
                    onDragStart={e => onStepDragStart(index, e)}
                    onDragOver={e => onStepDragOver(index, e)}
                    onDragLeave={onStepDragLeave}
                    onDrop={e => onStepDrop(index, e)}
                  >
                    {/* Drag handle */}
                    <span
                      className="rb-drag-handle"
                      aria-hidden="true"
                      title="Drag to reorder"
                    >
                      ⣿
                    </span>

                    {/* Step number */}
                    <span className="rb-step-num" aria-label={`Step ${step.order}`}>
                      {step.order}
                    </span>

                    {/* Task info + condition */}
                    <div className="rb-step-content">
                      <div className="rb-step-task">
                        {task ? (
                          <>
                            <span className={`rb-type-badge rb-type-badge--sm rb-task-${task.type}`}>
                              {task.type}
                            </span>
                            <span className="rb-step-task-name">{task.name}</span>
                          </>
                        ) : (
                          <span className="rb-step-missing">Task not found</span>
                        )}
                      </div>

                      <label className="rb-condition-label">
                        <span className="rb-condition-hint">Condition (optional)</span>
                        <input
                          type="text"
                          className="rb-condition-input"
                          value={step.condition}
                          onChange={e => updateCondition(index, e.target.value)}
                          placeholder="e.g. previous.status === 'succeeded'"
                          aria-label={`Condition for step ${step.order}`}
                        />
                      </label>
                    </div>

                    {/* Remove button */}
                    <button
                      className="rb-remove-btn"
                      onClick={() => removeStep(index)}
                      title={`Remove step ${step.order}`}
                      aria-label={`Remove step ${step.order}`}
                    >
                      ✕
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>

      {saveError && (
        <p className="rb-error" role="alert">
          {saveError}
        </p>
      )}

      <div className="rb-footer">
        <button className="rb-btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="rb-btn-save"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save Steps'}
        </button>
      </div>
    </div>
  )
}
