import { EventEmitter } from 'node:events'
import type { Task, TaskLog } from '../types.js'

/** Payload shape of a 'task:log' SSE event. */
export interface TaskLogEvent {
  taskId: string
  log: TaskLog
}

/**
 * Application-wide singleton event emitter for task lifecycle changes.
 *
 * Emitted events:
 *  - 'task:updated' → Task          – fired after every task status transition
 *                                     or structural change (create, update).
 *  - 'task:log'     → TaskLogEvent  – fired after every log-line append.
 *
 * Route handlers add one listener per SSE connection and remove it on
 * disconnect via `req.on('close', ...)`, so there is no memory-leak risk
 * from accumulating stale listeners. The maxListeners ceiling is raised to
 * accommodate large numbers of concurrent SSE clients without Node.js
 * printing false-positive leak warnings.
 */
class TaskEventEmitter extends EventEmitter {
  /** Notify all subscribers that a task has been created or updated. */
  emitTaskUpdated(task: Task): void {
    this.emit('task:updated', task)
  }

  /** Notify all subscribers that a new log line was appended to a task. */
  emitTaskLog(taskId: string, log: TaskLog): void {
    const payload: TaskLogEvent = { taskId, log }
    this.emit('task:log', payload)
  }
}

export const taskEvents = new TaskEventEmitter()

// Allow up to 500 concurrent SSE listeners before Node.js prints a
// "MaxListenersExceededWarning". Each SSE connection adds two listeners
// (task:updated and task:log), so this supports ~250 concurrent clients.
taskEvents.setMaxListeners(500)
