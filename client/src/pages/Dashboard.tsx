import { useState, useEffect, useCallback } from 'react'
import type { Task, TaskType } from '../types'
import { TaskCard } from '../components/TaskCard'
import { CreateTaskModal } from '../components/ConfigModal'
import { apiFetch } from '../api'
import { useTaskEvents } from '../hooks/useTaskEvents'
import './Dashboard.css'

// Maps each bucket's TaskType to the type-specific modifier class defined in
// Dashboard.css (dashboard-bucket--daily / --developmental / --routine).
const BUCKET_PANEL_CLASS: Record<TaskType, string> = {
  daily: 'dashboard-bucket--daily',
  developmental: 'dashboard-bucket--developmental',
  routine: 'dashboard-bucket--routine',
}

// Tasks are grouped into fixed, type-based buckets rather than filtered by a
// single active tab — all three buckets render side by side and search
// narrows each of them simultaneously. Each bucket also owns its own
// type-specific "create" form (see per-bucket create state below) rather
// than a single global "+ New Routine" action, since the fields required to
// create a task differ per type.
const BUCKETS: { type: TaskType; label: string; singular: string }[] = [
  { type: 'daily', label: 'Daily Tasks', singular: 'Daily Task' },
  { type: 'developmental', label: 'Developmental Tasks', singular: 'Developmental Task' },
  { type: 'routine', label: 'Routine Automation', singular: 'Routine' },
]

const BUCKET_TYPES = new Set(BUCKETS.map(b => b.type))

function isBucketType(value: string | null): value is TaskType {
  return value !== null && BUCKET_TYPES.has(value as TaskType)
}

// The drill-in view is reflected in the URL as a `?bucket=<type>` query
// parameter on the dashboard route ("/", see App.tsx) rather than a
// dedicated route. This keeps the route table untouched (the same
// Dashboard component still serves "/") while making the focused view
// bookmarkable and navigable via the browser's back/forward buttons.
// We use the History API directly instead of a router hook so Dashboard
// keeps working when rendered outside a Router (e.g. in unit tests).
function getBucketTypeFromLocation(): TaskType | null {
  const param = new URLSearchParams(window.location.search).get('bucket')
  return isBucketType(param) ? param : null
}

export function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sseConnected, setSseConnected] = useState(false)

  // Drill-in view: when set, the dashboard shows a single bucket full-width
  // (with a back control) instead of the three-column grid. Cleared whenever
  // the user clicks "Back" or the focused bucket's type no longer exists.
  // Initialized from (and kept in sync with) the `?bucket=` URL query
  // parameter so the view survives a refresh and responds to browser
  // back/forward navigation — see navigateToBucket and the popstate
  // listener below.
  const [focusedType, setFocusedType] = useState<TaskType | null>(() => getBucketTypeFromLocation())

  // Keep `focusedType` in sync when the user navigates with the browser's
  // back/forward buttons (popstate is not fired for our own pushState calls,
  // only for actual history navigation).
  useEffect(() => {
    const onPopState = () => setFocusedType(getBucketTypeFromLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Updates both the in-memory focus state and the URL so the two never
  // drift apart. Pushes a new history entry (rather than replacing) so the
  // browser's back button steps out of the drill-in view.
  const navigateToBucket = useCallback((type: TaskType | null) => {
    setFocusedType(type)
    const url = new URL(window.location.href)
    if (type) {
      url.searchParams.set('bucket', type)
    } else {
      url.searchParams.delete('bucket')
    }
    // Preserve the existing history.state (React Router stores its own
    // idx/key bookkeeping there) instead of clobbering it with `{}`, so we
    // don't desync the router's internal navigation index.
    window.history.pushState(
      { ...window.history.state },
      '',
      `${url.pathname}${url.search}${url.hash}`
    )
  }, [])

  // Per-bucket create: which bucket type's create modal (if any) is open.
  // The "+" button on each bucket opens the same centered pop-up used by the
  // ⚙ configuration button, running in create mode — see CreateTaskModal.
  const [openBucket, setOpenBucket] = useState<TaskType | null>(null)

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

  // ── Task creation ─────────────────────────────────────────────────────────
  //
  // Creation happens inside CreateTaskModal (which owns the form, validation,
  // and POST). This callback merges the created task into local state for
  // immediate feedback; the SSE 'task:updated' event also arrives and keeps
  // the list in sync across sessions.

  const handleCreated = useCallback((created: Task) => {
    setTasks(prev => (prev.some(t => t.id === created.id) ? prev : [...prev, created]))
  }, [])

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

  const buckets = BUCKETS.map(({ type, label, singular }) => ({
    type,
    label,
    singular,
    tasks: filteredTasks.filter(task => task.type === type),
  }))

  // The bucket currently drilled into, if any. Falls back to the grid view
  // if the focused type somehow no longer matches a known bucket.
  const focusedBucket = focusedType ? buckets.find(b => b.type === focusedType) ?? null : null

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
        </div>
      </header>

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
          <p className="state-hint">Use the + button on a bucket below to create your first task</p>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="state-placeholder">
          <p>No tasks found</p>
          <p className="state-hint">Try adjusting your search</p>
        </div>
      ) : focusedBucket ? (
        <div className="dashboard-buckets dashboard-buckets--focused">
          <section
            className="dashboard-bucket dashboard-bucket--focused"
            aria-label={`${focusedBucket.label} tasks`}
          >
            <div className="dashboard-bucket-header">
              <button
                type="button"
                className="btn btn-outline dashboard-bucket-back"
                onClick={() => navigateToBucket(null)}
                aria-label="Back to all buckets"
              >
                ← Back
              </button>
              <h2>{focusedBucket.label}</h2>
              <span className="dashboard-bucket-count">{focusedBucket.tasks.length}</span>
            </div>

            {focusedBucket.tasks.length === 0 ? (
              <div className="state-placeholder state-placeholder--bucket">
                <p className="state-hint">No matching tasks</p>
              </div>
            ) : (
              <div className="task-grid">
                {focusedBucket.tasks.map(task => (
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
        </div>
      ) : (
        <div className="dashboard-buckets">
          {buckets.map(bucket => (
            <section
              key={bucket.type}
              className={`dashboard-bucket ${BUCKET_PANEL_CLASS[bucket.type]}`}
              aria-label={`${bucket.label} tasks`}
            >
              <div className="dashboard-bucket-header">
                <h2>
                  <button
                    type="button"
                    className="dashboard-bucket-title-btn"
                    onClick={() => navigateToBucket(bucket.type)}
                    aria-label={`View ${bucket.label} in full width`}
                  >
                    {bucket.label}
                  </button>
                </h2>
                <span className="dashboard-bucket-count">{bucket.tasks.length}</span>
                <button
                  type="button"
                  className="btn btn-primary dashboard-bucket-add"
                  onClick={() => setOpenBucket(bucket.type)}
                  aria-label={`New ${bucket.singular}`}
                  title={`New ${bucket.singular}`}
                >
                  +
                </button>
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

      {/* Per-bucket "+" opens the same centered pop-up as the ⚙ button, in
          create mode. Mounted at the page root so it overlays every view. */}
      {openBucket && (
        <CreateTaskModal
          type={openBucket}
          onCreated={handleCreated}
          onClose={() => setOpenBucket(null)}
        />
      )}
    </div>
  )
}
