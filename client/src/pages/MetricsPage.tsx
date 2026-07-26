import { useCallback, useEffect, useState } from 'react'
import type { Task } from '../types'
import { apiFetch } from '../api'
import { useTaskEvents } from '../hooks/useTaskEvents'
import './MetricsPage.css'

/**
 * Read-only metrics view: summary counts across all tasks plus a table of
 * currently failed tasks for quick triage.
 *
 * Data source mirrors the Dashboard's pattern:
 *  - GET /api/tasks provides the initial snapshot (and a fallback if SSE is
 *    unavailable, e.g. in tests).
 *  - The `/api/tasks/events` SSE stream (via useTaskEvents) keeps counts and
 *    the failed-task list live without polling.
 *
 * No new backend endpoints are introduced — this page only reads from the
 * existing task list and the existing GET /api/tasks/:id/logs endpoint
 * (linked, not fetched, to keep this page simple).
 */
export function MetricsPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sseConnected, setSseConnected] = useState(false)

  useTaskEvents({
    onConnected: initialTasks => {
      setTasks(initialTasks)
      setLoading(false)
      setError(null)
      setSseConnected(true)
    },
    onTaskUpdated: updatedTask => {
      // The server broadcasts 'task:updated' for creation, edits, and status
      // transitions alike (see server/src/services/taskEvents.ts) — there is
      // no separate 'task:created' event. So this branch IS reached whenever
      // a task created after the initial snapshot arrives over SSE; it is
      // not dead code. This mirrors Dashboard.tsx's identical handling.
      setTasks(prev => {
        const exists = prev.some(t => t.id === updatedTask.id)
        if (exists) {
          return prev.map(t => (t.id === updatedTask.id ? updatedTask : t))
        }
        // Task was created (by this session or another) — append it.
        return [...prev, updatedTask]
      })
    },
    onError: () => {
      setSseConnected(false)
    },
  })

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

  const total = tasks.length
  const failed = tasks.filter(t => t.status === 'failed')
  const succeeded = tasks.filter(t => t.status === 'succeeded').length
  const running = tasks.filter(t => t.status === 'running').length

  // Most recently updated failures first, so the most actionable items are
  // visible without scrolling.
  const sortedFailed = [...failed].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )

  return (
    <div className="metrics-page">
      <header className="metrics-header">
        <div>
          <h1>Metrics</h1>
          <p className="metrics-subtitle">Task health at a glance</p>
        </div>

        <span
          className={`sse-indicator ${sseConnected ? 'sse-indicator--live' : 'sse-indicator--offline'}`}
          title={sseConnected ? 'Live updates active' : 'Connecting to live updates…'}
          aria-label={sseConnected ? 'Live updates active' : 'Connecting to live updates'}
        >
          <span className="sse-indicator__dot" aria-hidden="true" />
          {sseConnected ? 'Live' : 'Connecting…'}
        </span>
      </header>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state-placeholder">Loading metrics…</div>
      ) : (
        <>
          <div className="metrics-summary" role="list">
            <div className="metrics-card" role="listitem">
              <span className="metrics-card-value">{total}</span>
              <span className="metrics-card-label">Total</span>
            </div>
            <div className="metrics-card metrics-card--success" role="listitem">
              <span className="metrics-card-value">{succeeded}</span>
              <span className="metrics-card-label">Succeeded</span>
            </div>
            <div className="metrics-card metrics-card--running" role="listitem">
              <span className="metrics-card-value">{running}</span>
              <span className="metrics-card-label">Running</span>
            </div>
            <div className="metrics-card metrics-card--failed" role="listitem">
              <span className="metrics-card-value">{failed.length}</span>
              <span className="metrics-card-label">Failed</span>
            </div>
          </div>

          <section className="metrics-failed-section" aria-label="Failed tasks">
            <h2>Failed Tasks</h2>

            {sortedFailed.length === 0 ? (
              <div className="state-placeholder">
                <p>No failed tasks</p>
                <p className="state-hint">Everything is running smoothly</p>
              </div>
            ) : (
              <table className="metrics-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Last Update</th>
                    <th scope="col">Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFailed.map(task => (
                    <tr key={task.id}>
                      <td>{task.name}</td>
                      <td>
                        <span className={`badge type-${task.type}`}>{task.type}</span>
                      </td>
                      <td>
                        <time dateTime={task.updatedAt}>
                          {new Date(task.updatedAt).toLocaleString()}
                        </time>
                      </td>
                      <td>
                        <a
                          href={`/api/tasks/${encodeURIComponent(task.id)}/logs`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="metrics-logs-link"
                        >
                          View logs
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}
