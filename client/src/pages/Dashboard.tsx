import React, { useState, useEffect, useCallback } from 'react'
import type { Task, TaskType } from '../types'
import { TaskCard } from '../components/TaskCard'
import { apiFetch } from '../api'
import { useTaskEvents } from '../hooks/useTaskEvents'
import './Dashboard.css'

// Tasks are grouped into fixed, type-based buckets rather than filtered by a
// single active tab — all three buckets render side by side and search
// narrows each of them simultaneously.
const BUCKETS: { type: TaskType; label: string }[] = [
  { type: 'daily', label: 'Daily Tasks' },
  { type: 'developmental', label: 'Developmental Tasks' },
  { type: 'routine', label: 'Routine Automation' },
]

export function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sseConnected, setSseConnected] = useState(false)

  // New routine creation form
  const [showNewForm, setShowNewForm] = useState(false)
  const [newRoutineName, setNewRoutineName] = useState('')
  const [creating, setCreating] = useState(false)

  // ── Real-time SSE subscription ────────────────────────────────────────────
  //
  // The 'connected' event provides an authoritative snapshot of all tasks at
  // the moment the SSE connection is established. We use this to initialize
  // state (replacing the loading-spinner phase) and mark the connection live.
  //
  // Subsequent 'task:updated' events keep individual tasks in sync without
  // requiring polling. The Dashboard falls back gracefully to its initial HTTP
  // snapshot when SSE is unavailable (e.g. in test environments).

  useTaskEvents({
    onConnected: (initialTasks) => {
      setTasks(initialTasks)
      setLoading(false)
      setError(null)
      setSseConnected(true)
    },
    onTaskUpdated: (updatedTask) => {
      setTasks(prev => {
        const exists = prev.some(t => t.id === updatedTask.id)
        if (exists) {
          return prev.map(t => (t.id === updatedTask.id ? updatedTask : t))
        }
        // Task was created by another session — append it to the list.
        return [...prev, updatedTask]
      })
    },
    onError: () => {
      setSseConnected(false)
    },
  })

  // ── Initial HTTP fetch (fallback) ─────────────────────────────────────────
  //
  // Issued on mount to provide an immediate task list while the SSE connection
  // is being established, and as a fallback if SSE is unavailable. Once SSE
  // delivers its 'connected' snapshot the HTTP-fetched state is superseded.

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await apiFetch('/api/tasks')
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

  // ── Task actions ──────────────────────────────────────────────────────────

  const handleTrigger = async (id: string) => {
    try {
      setError(null)
      const res = await apiFetch(`/api/tasks/${id}/trigger`, { method: 'POST' })
      const body = await res.json() as { task?: Task; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      // Optimistically apply the trigger response; SSE will deliver subsequent
      // status transitions (running → succeeded/failed) automatically.
      if (body.task) {
        setTasks(prev => prev.map(t => (t.id === id ? body.task! : t)))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger task')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      setError(null)
      const res = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json() as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task')
    }
  }

  // ── Routine creation ──────────────────────────────────────────────────────

  const handleCreateRoutine = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRoutineName.trim()) return

    try {
      setCreating(true)
      setError(null)
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newRoutineName.trim(), type: 'routine' }),
      })
      const body = await res.json() as Task & { error?: string }
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      // The SSE 'task:updated' event will also arrive and keep the list in
      // sync; adding here provides immediate feedback without waiting for SSE.
      setTasks(prev => {
        if (prev.some(t => t.id === body.id)) return prev
        return [...prev, body]
      })
      setNewRoutineName('')
      setShowNewForm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create routine')
    } finally {
  const handleSaveSteps = useCallback(
    async (steps: RoutineStep[]) => {
      if (!editingRoutine) return

      try {
        const res = await apiFetch(`/api/tasks/${editingRoutine.id}/steps`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps }),
        })
        const body = await res.json() as Routine & { error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)

        setTasks(prev => prev.map(t => (t.id === body.id ? body : t)))
        setEditingRoutine(body)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save steps')
      }
    },
    [editingRoutine],
  )
    }
  }

  // ── Filtering ─────────────────────────────────────────────────────────────
  //
  // Search matches by task name/ID (and description, to preserve prior
  // behavior) and applies across all three buckets simultaneously — there is
  // no separate type filter anymore since each bucket is already scoped to
  // its own task type. Because this is derived directly from `tasks` and
  // `search` on every render, results (and bucket membership) update in
  // real-time as SSE events mutate `tasks` or the user types.

  const searchLower = search.trim().toLowerCase()
  const matchesSearch = (task: Task) =>
    !searchLower ||
    task.name.toLowerCase().includes(searchLower) ||
    task.id.toLowerCase().includes(searchLower) ||
    task.description.toLowerCase().includes(searchLower)

  const filteredTasks = tasks.filter(matchesSearch)

  const buckets = BUCKETS.map(({ type, label }) => ({
    type,
    label,
    tasks: filteredTasks.filter(task => task.type === type),
  }))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Task Dashboard</h1>
          <p className="dashboard-subtitle">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} total
          </p>
        </div>

        <div className="dashboard-header-actions">
          <span
            className={`sse-indicator ${sseConnected ? 'sse-indicator--live' : 'sse-indicator--offline'}`}
            title={sseConnected ? 'Live updates active' : 'Connecting to live updates…'}
            aria-label={sseConnected ? 'Live updates active' : 'Connecting to live updates'}
          >
            <span className="sse-indicator__dot" aria-hidden="true" />
            {sseConnected ? 'Live' : 'Connecting…'}
          </span>

          <button
            className="btn btn-primary"
            onClick={() => {
              setShowNewForm(v => !v)
              setNewRoutineName('')
              setError(null)
            }}
          >
            + New Routine
          </button>
        </div>
      </header>

      {/* New routine creation form */}
      {showNewForm && (
        <form className="new-routine-form" onSubmit={handleCreateRoutine}>
          <input
            type="text"
            className="search-input"
            placeholder="Routine name…"
            value={newRoutineName}
            onChange={e => setNewRoutineName(e.target.value)}
            autoFocus
            disabled={creating}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || !newRoutineName.trim()}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setShowNewForm(false)}
            disabled={creating}
          >
            Cancel
          </button>
        </form>
      )}

      <div className="dashboard-controls">
        <input
          type="search"
          className="search-input"
          placeholder="Search tasks by name or ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search tasks"
        />
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state-placeholder">Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="state-placeholder">
          <p>No tasks found</p>
          <p className="state-hint">Create a routine above to get started</p>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="state-placeholder">
          <p>No tasks found</p>
          <p className="state-hint">Try adjusting your search</p>
        </div>
      ) : (
        <div className="dashboard-buckets">
          {buckets.map(bucket => (
            <section
              key={bucket.type}
              className="dashboard-bucket"
              aria-label={`${bucket.label} tasks`}
            >
              <div className="dashboard-bucket-header">
                <h2>{bucket.label}</h2>
                <span className="dashboard-bucket-count">{bucket.tasks.length}</span>
              </div>

              {bucket.tasks.length === 0 ? (
                <div className="state-placeholder state-placeholder--bucket">
                  <p className="state-hint">No matching tasks</p>
                </div>
              ) : (
                <div className="task-grid">
                  {bucket.tasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onTrigger={handleTrigger}
                      onDelete={handleDelete}
                      allTasks={tasks}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
