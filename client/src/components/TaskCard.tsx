import type { KeyboardEvent } from 'react'
import type { Task, TaskStatus } from '../types'
import { useOpenPanel } from '../hooks/useOpenPanel'
import { TaskConfigPanel } from './TaskConfigPanel'
import './TaskCard.css'

interface TaskCardProps {
  task: Task
  onTrigger: (id: string) => void
  onDelete: (id: string) => void
  /**
   * Every task in the system. Passed through to this card's TaskConfigPanel
   * to populate RoutineBuilder's available-task palette when task.type is
   * 'routine'. Defaults to an empty list — the panel still opens, but a
   * routine's palette will be empty until the caller supplies the full list.
   */
  allTasks?: Task[]
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge status-${status}`} aria-label={`Status: ${status}`}>
      {status}
    </span>
  )
}

function TypeBadge({ type }: { type: Task['type'] }) {
  return (
    <span className={`badge type-${type}`} aria-label={`Type: ${type}`}>
      {type}
    </span>
  )
}

export function TaskCard({ task, onTrigger, onDelete, allTasks = [] }: TaskCardProps) {
  const isBusy = task.status === 'running' || task.status === 'queued'
  const panel = useOpenPanel(task.id)
  const configLabel = task.type === 'routine' ? 'Edit routine steps' : 'View configuration'

  // The whole card (everything except the action buttons, which stop
  // propagation below) opens the same TaskConfigPanel as the ⚙ button —
  // it's just a larger, more discoverable hit target for the same action.
  const handleCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    panel.toggle()
  }

  return (
    <>
      <article
        className={`task-card${panel.isOpen ? ' task-card--config-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={panel.isOpen}
        aria-label={panel.isOpen ? `Close configuration panel for ${task.name}` : `${configLabel}: ${task.name}`}
        onClick={panel.toggle}
        onKeyDown={handleCardKeyDown}
      >
        <div className="task-card-header">
          <div className="task-card-title">
            <h3>{task.name}</h3>
            <div className="task-card-badges">
              <TypeBadge type={task.type} />
              <StatusBadge status={task.status} />
            </div>
          </div>

          {/* Stops the click (and the native click a button emits in response
              to a keyboard Enter/Space) from bubbling up to the card's own
              onClick, so action buttons never also toggle the config panel. */}
          <div className="task-card-actions" onClick={e => e.stopPropagation()}>
            <button
              className={`icon-btn config-btn${panel.isOpen ? ' active' : ''}`}
              onClick={panel.toggle}
              title={panel.isOpen ? 'Close panel' : configLabel}
              aria-label={panel.isOpen ? 'Close configuration panel' : configLabel}
              aria-pressed={panel.isOpen}
            >
              ⚙
            </button>
            <button
              className="icon-btn trigger-btn"
              onClick={() => onTrigger(task.id)}
              disabled={isBusy}
              title={isBusy ? 'Task is already queued or running' : 'Trigger task'}
              aria-label="Trigger task"
            >
              ▶
            </button>
            <button
              className="icon-btn delete-btn"
              onClick={() => onDelete(task.id)}
              title="Delete task"
              aria-label="Delete task"
            >
              ✕
            </button>
          </div>
        </div>

        {task.description && (
          <p className="task-card-description">{task.description}</p>
        )}

        {/* Show step count for routines */}
        {task.type === 'routine' && (
          <p className="task-card-steps">
            {task.steps.length === 0
              ? 'No steps configured'
              : `${task.steps.length} step${task.steps.length === 1 ? '' : 's'}`}
          </p>
        )}

        <footer className="task-card-meta">
          <time dateTime={task.createdAt}>
            Created {new Date(task.createdAt).toLocaleDateString()}
          </time>
        </footer>
      </article>

      {/* Rendered as a fixed overlay by TaskConfigPanel itself — never
          affects this card's or its siblings' layout in the grid. */}
      {panel.isOpen && (
        <TaskConfigPanel task={task} allTasks={allTasks} onClose={panel.close} />
      )}
    </>
  )
}
