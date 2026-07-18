import type { Task, TaskStatus } from '../types'
import './TaskCard.css'

interface TaskCardProps {
  task: Task
  onTrigger: (id: string) => void
  onDelete: (id: string) => void
  /** Only provided for routine tasks — opens the step editor. */
  onEditSteps?: () => void
  /** Whether the routine builder is currently open for this card. */
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
  onEditSteps,
  isEditing = false,
}: TaskCardProps) {
  const isBusy = task.status === 'running' || task.status === 'queued'

  return (
    <article className={`task-card${isEditing ? ' task-card--editing' : ''}`}>
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
  )
}
