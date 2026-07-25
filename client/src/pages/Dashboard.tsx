import React, { useState, useEffect, useCallback } from 'react'
import type { Task, TaskType, Routine, RoutineStep } from '../types'
import { TaskCard } from '../components/TaskCard'
import { RoutineBuilder } from '../components/RoutineBuilder'
import { apiFetch } from '../api'
import { useTaskEvents } from '../hooks/useTaskEvents'
import './Dashboard.css'

// The three fixed buckets tasks are grouped into. Order here determines the
// left-to-right (desktop) / top-to-bottom (mobile) render order.
const BUCKET_TYPES: TaskType[] = ['daily', 'developmental', 'routine']

const BUCKET_LABELS: Record<TaskType, string> = {
  daily: 'Daily Tasks',
  developmental: 'Developmental Tasks',
  routine: 'Routines',
}

const BUCKET_EMPTY_HINTS: Record<TaskType, string> = {
  daily: 'No daily tasks yet. Scheduled tasks will show up here.',
  developmental: 'No developmental tasks yet. Agent-driven dev tasks will show up here.',
  routine: 'No routines yet. Create one above to get started.',
}

export function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sseConnected, setSseConnected] = useState(false)

  // Routine builder: which routine is currently being edited (if any)
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null)

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
      // Keep the routine builder in sync if the open routine was updated.
      setEditingRoutine(prev =>
        prev?.id === updatedTask.id && updatedTask.type === 'routine'
          ? (updatedTask as Routine)
          : prev,
      )
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
      // Close the routine builder if the deleted task was open
      if (editingRoutine?.id === id) setEditingRoutine(null)
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
      setCreating(false)
    }
  }

  // ── Routine step save (called by RoutineBuilder) ───────────────────────────

  const handleSaveSteps = useCallback(
    async (steps: RoutineStep[]) => {
      if (!editingRoutine) return

      const res = await apiFetch(`/api/tasks/${editingRoutine.id}/steps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps }),
      })
      const body = await res.json() as Routine & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)

      // Update both the task list and the active editing state; SSE will also
      // deliver the update but applying it locally here prevents a flicker.
      setTasks(prev => prev.map(t => (t.id === body.id ? body : t)))
      setEditingRoutine(body)
    },
    [editingRoutine],
  )

  // ── Filtering ─────────────────────────────────────────────────────────────
  //
  // The search box applies across all three buckets simultaneously — there is
  // no separate type filter anymore, buckets themselves are the type split.

  const searchLower = search.toLowerCase()
  const matchesSearch = (task: Task) =>
    !search ||
    task.name.toLowerCase().includes(searchLower) ||
    task.description.toLowerCase().includes(searchLower)

  const visible = tasks.filter(matchesSearch)

  const bucketedTasks: Record<TaskType, Task[]> = {
    daily: visible.filter(task => task.type === 'daily'),
    developmental: visible.filter(task => task.type === 'developmental'),
    routine: visible.filter(task => task.type === 'routine'),
  }

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
          placeholder="Search tasks…"
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
      ) : (
        <div className="dashboard-buckets">
          {BUCKET_TYPES.map(type => {
            const bucketTasks = bucketedTasks[type]
            return (
              <section className="bucket" key={type} aria-label={BUCKET_LABELS[type]}>
                <header className="bucket-header">
                  <h2 className="bucket-title">{BUCKET_LABELS[type]}</h2>
                  <span className="bucket-count">{bucketTasks.length}</span>
                </header>

                <div className="bucket-body">
                  {bucketTasks.length === 0 ? (
                    <div className="state-placeholder bucket-empty">
                      <p>No tasks found</p>
                      <p className="state-hint">
                        {search ? 'Try adjusting your search' : BUCKET_EMPTY_HINTS[type]}
                      </p>
                    </div>
                  ) : (
                    bucketTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onTrigger={handleTrigger}
                        onDelete={handleDelete}
                        onEditSteps={
                          task.type === 'routine'
                            ? () => setEditingRoutine(task as Routine)
                            : undefined
                        }
                        isEditing={editingRoutine?.id === task.id}
                      />
                    ))
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* Routine Builder panel — shown below the task grid when editing */}
      {editingRoutine && (
        <RoutineBuilder
          routine={editingRoutine}
          allTasks={tasks}
          onSave={handleSaveSteps}
          onClose={() => setEditingRoutine(null)}
        />
      )}
    </div>
  )
}
