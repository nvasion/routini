/**
 * TaskConfigPanel — type-specific configuration viewer/editor for a single task.
 *
 *   daily          — read-only: schedule, actionType, config key/value pairs
 *   developmental  — read-only: repoUrl, branch, agentId, lastRunAt
 *   routine        — embeds RoutineBuilder for full step editing
 *
 * Rendering model:
 *  - Renders as a fixed-position overlay (backdrop + drawer), never inline
 *    in a TaskCard's normal document flow. This guarantees opening a panel
 *    never resizes the card or reflows sibling cards/buckets in the grid.
 *  - TaskCard is responsible for mounting exactly one TaskConfigPanel at a
 *    time (see useOpenPanel), so this component doesn't coordinate that
 *    itself — it just renders whatever `task` it's given and calls
 *    `onClose` when the user dismisses it.
 *
 * Close affordances: an explicit ✕ button, clicking the backdrop, and the
 * Escape key all close the panel.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { Task, RoutineStep } from '../types'
import { RoutineBuilder } from './RoutineBuilder'
import { apiFetch } from '../api'
import { formatLastRun, getConfigEntries } from './taskConfigPanel.utils'
import './TaskConfigPanel.css'

export interface TaskConfigPanelProps {
  task: Task
  /**
   * Every task in the system. Used to populate RoutineBuilder's
   * available-task palette when `task.type === 'routine'`; ignored
   * otherwise. Defaults to an empty list.
   */
  allTasks?: Task[]
  onClose: () => void
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="tcp-field">
      <span className="tcp-field-label">{label}</span>
      <span className="tcp-field-value">{value}</span>
    </div>
  )
}

/**
 * Persists routine steps via the same endpoint Dashboard historically used
 * (PUT /api/tasks/:id/steps). The panel doesn't own any task list state —
 * the server broadcasts a 'task:updated' SSE event on success, which is how
 * the rest of the app (Dashboard's task list) learns about the change.
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

export function TaskConfigPanel({ task, allTasks = [], onClose }: TaskConfigPanelProps) {
  // Close on Escape for keyboard/accessibility parity with the close button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Routines get RoutineBuilder's own header/footer/close chrome — render it
  // edge-to-edge inside a wider drawer instead of duplicating that chrome here.
  if (task.type === 'routine') {
    return (
      <div className="tcp-overlay" role="presentation" onClick={onClose}>
        <div className="tcp-panel tcp-panel--routine" onClick={e => e.stopPropagation()}>
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
    <div className="tcp-overlay" role="presentation" onClick={onClose}>
      <div
        className="tcp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Configuration for ${task.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="tcp-header">
          <div>
            <h2 className="tcp-title">Configuration</h2>
            <p className="tcp-subtitle">{task.name}</p>
          </div>
          <button
            className="tcp-close"
            onClick={onClose}
            aria-label="Close configuration panel"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="tcp-body">
          {task.type === 'daily' && (
            <>
              <Field label="Schedule" value={<code>{task.schedule}</code>} />
              <Field label="Action Type" value={task.actionType} />
              <div className="tcp-field">
                <span className="tcp-field-label">Config</span>
                {getConfigEntries(task.config).length > 0 ? (
                  <ul className="tcp-config-list">
                    {getConfigEntries(task.config).map(([key, value]) => (
                      <li key={key}>
                        <code>{key}</code>: <span>{value}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="tcp-field-value tcp-field-empty">
                    Not shown — action config may contain credentials and isn't sent to the browser.
                  </span>
                )}
              </div>
            </>
          )}

          {task.type === 'developmental' && (
            <>
              <Field label="Repository" value={task.repoUrl} />
              <Field label="Branch" value={task.branch} />
              <Field label="Agent" value={task.agentId} />
              <Field label="Last Run" value={formatLastRun(task.lastRunAt)} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
