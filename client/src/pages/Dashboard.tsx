import { useState, useEffect, useCallback } from 'react'
import type { Task, TaskType } from '../types'
import { TaskCard } from '../components/TaskCard'
import './Dashboard.css'

const FILTER_TYPES = ['all', 'daily', 'developmental', 'routine'] as const
type FilterType = typeof FILTER_TYPES[number]

export function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch('/api/tasks')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { tasks: Task[] }
      setTasks(data.tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTasks()
  }, [fetchTasks])

  const handleTrigger = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/trigger`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json()) as { error: string }
        throw new Error(body.error)
      }
      const data = (await res.json()) as { task: Task }
      setTasks(prev => prev.map(t => (t.id === id ? data.task : t)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger task')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task')
    }
  }

  const visible = tasks.filter(task => {
    const typeMatch = filter === 'all' || task.type === (filter as TaskType)
    const searchLower = search.toLowerCase()
    const searchMatch =
      !search ||
      task.name.toLowerCase().includes(searchLower) ||
      task.description.toLowerCase().includes(searchLower)
    return typeMatch && searchMatch
  })

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Task Dashboard</h1>
          <p className="dashboard-subtitle">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} total
          </p>
        </div>
      </header>

      <div className="dashboard-controls">
        <input
          type="search"
          className="search-input"
          placeholder="Search tasks…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search tasks"
        />
        <div className="filter-tabs" role="group" aria-label="Filter by type">
          {FILTER_TYPES.map(type => (
            <button
              key={type}
              className={`filter-tab${filter === type ? ' active' : ''}`}
              onClick={() => setFilter(type)}
              aria-pressed={filter === type}
            >
              {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state-placeholder">Loading tasks…</div>
      ) : visible.length === 0 ? (
        <div className="state-placeholder">
          <p>No tasks found</p>
          <p className="state-hint">
            {search || filter !== 'all'
              ? 'Try adjusting your filters'
              : 'Create your first task to get started'}
          </p>
        </div>
      ) : (
        <div className="task-grid">
          {visible.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onTrigger={handleTrigger}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
