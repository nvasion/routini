import type { Task, TaskStatus } from '../types'
import './TaskCard.css'

interface TaskCardProps {
  task: Task
  onTrigger: (id: string) => void
  onDelete: (id: string) => void
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

export function TaskCard({ task, onTrigger, onDelete }: TaskCardProps) {
  const isBusy = task.status === 'running' || task.status === 'queued'

  return (
    <article className="task-card">
      <div className="task-card-header">
        <div className="task-card-title">
          <h3>{task.name}</h3>
          <div className="task-card-badges">
            <TypeBadge type={task.type} />
            <StatusBadge status={task.status} />
          </div>
        </div>

        <div className="task-card-actions">
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

      <footer className="task-card-meta">
        <time dateTime={task.createdAt}>
          Created {new Date(task.createdAt).toLocaleDateString()}
        </time>
      </footer>
    </article>
  )
}
