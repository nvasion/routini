import { useEffect, useRef } from 'react'
import type { Task } from '../types'

/** A single timestamped execution log line received over SSE. */
export interface SseTaskLog {
  timestamp: string
  message: string
}

/** Payload of a 'task:log' SSE event. */
export interface SseTaskLogEvent {
  taskId: string
  log: SseTaskLog
}

/**
 * Handlers invoked as SSE events arrive from `/api/tasks/events`.
 *
 * All callbacks are optional except `onTaskUpdated`, which is the primary
 * mechanism for keeping the UI in sync with server-side task state changes.
 */
export interface TaskEventHandlers {
  /**
   * Called when the SSE connection is first established. Receives the full
   * snapshot of all current tasks, allowing the client to initialize state
   * without a separate HTTP request.
   */
  onConnected?: (tasks: Task[]) => void

  /**
   * Called whenever a task is created, updated, or transitions status.
   * Clients should merge the updated task into their local task list.
   */
  onTaskUpdated: (task: Task) => void

  /**
   * Called when a new execution log line is appended to a task.
   * Optional – subscribe only when the UI displays live log output.
   */
  onTaskLog?: (event: SseTaskLogEvent) => void

  /**
   * Called when the SSE connection encounters an error or the server
   * closes the stream unexpectedly. The browser's EventSource will attempt
   * to reconnect automatically; no manual retry logic is needed.
   */
  onError?: (event: Event) => void
}

/**
 * Subscribes to the `/api/tasks/events` Server-Sent Events stream and
 * dispatches incoming events to the provided handlers.
 *
 * Design notes:
 *  - The EventSource connection is opened once on mount and closed on unmount.
 *    It is NOT re-opened when handler callbacks change; handlers are stored in
 *    a ref so the effect closure always invokes the latest version.
 *  - The browser's built-in EventSource provides automatic reconnection after
 *    transient network failures, so no manual retry logic is required here.
 *  - `withCredentials: true` ensures the HTTP-only session cookie is sent,
 *    satisfying the server's `requireAuth` middleware without needing custom
 *    headers (which EventSource does not support in browsers).
 */
export function useTaskEvents(handlers: TaskEventHandlers): void {
  // Ref keeps the latest callbacks without closing and reopening the stream
  // every time a parent component re-renders with new inline function references.
  const handlersRef = useRef<TaskEventHandlers>(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const es = new EventSource('/api/tasks/events', { withCredentials: true })

    es.addEventListener('connected', (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as { tasks: Task[] }
        handlersRef.current.onConnected?.(data.tasks)
      } catch {
        // Silently ignore malformed events — a bad message must not crash the UI.
      }
    })

    es.addEventListener('task:updated', (e: MessageEvent<string>) => {
      try {
        const task = JSON.parse(e.data) as Task
        handlersRef.current.onTaskUpdated(task)
      } catch {
        // Silently ignore malformed events.
      }
    })

    es.addEventListener('task:log', (e: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(e.data) as SseTaskLogEvent
        handlersRef.current.onTaskLog?.(payload)
      } catch {
        // Silently ignore malformed events.
      }
    })

    es.addEventListener('error', (e: Event) => {
      handlersRef.current.onError?.(e)
    })

    return () => {
      es.close()
    }
  }, []) // Empty deps: open once on mount, close on unmount.
}
