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
  /**
   * @deprecated Legacy hook for a caller-managed routine step editor,
   * preserved only so existing call sites keep compiling. Prefer the
   * self-contained configuration panel (the ⚙ button) below, which handles
   * every task type — including routines, via an embedded RoutineBuilder —
   * without any wiring from the parent. Only provided for routine tasks.
   */
  onEditSteps?: () => void
  /** @deprecated Paired with `onEditSteps`; see its deprecation note. */
  isEditing?: boolean
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

export function TaskCard({
  task,
  onTrigger,
  onDelete,
  allTasks = [],
  onEditSteps,
  isEditing = false,
}: TaskCardProps) {
  const isBusy = task.status === 'running' || task.status === 'queued'
  const panel = useOpenPanel(task.id)
  const configLabel = task.type === 'routine' ? 'Edit routine steps' : 'View configuration'
  const isHighlighted = panel.isOpen || isEditing

  return (
    <>
      <article className={`task-card${isHighlighted ? ' task-card--config-open' : ''}`}>
        <div className="task-card-header">
          <div className="task-card-title">
            <h3>{task.name}</h3>
            <div className="task-card-badges">
              <TypeBadge type={task.type} />
              <StatusBadge status={task.status} />
            </div>
          </div>

          <div className="task-card-actions">
            {onEditSteps && (
              <button
                className={`icon-btn edit-steps-btn${isEditing ? ' active' : ''}`}
                onClick={onEditSteps}
                title={isEditing ? 'Close step editor' : 'Edit steps'}
                aria-label={isEditing ? 'Close step editor' : 'Edit routine steps'}
                aria-pressed={isEditing}
              >
                ≡
              </button>
            )}
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
