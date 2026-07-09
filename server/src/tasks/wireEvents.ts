/**
 * Wire event contract — canonical shapes exchanged over `/api/tasks/stream`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This file is the ONE canonical definition of every event shape that
 * crosses the SSE wire. The server's SSE handler consumes these types
 * directly (`sse.ts`), and the client hook mirrors them via a filesystem
 * contract test (`tests/tasks.wireContract.test.ts`) that guarantees the
 * client copy stays byte-for-byte identical to the block delimited by the
 * `WIRE-EVENTS:BEGIN` / `WIRE-EVENTS:END` markers below.
 *
 * Why this pattern instead of a shared `tsconfig` package?
 *   - The server (`NodeNext`) and client (`bundler`) have different
 *     resolution strategies and different rootDirs. A first-class shared
 *     package would require project references or a monorepo build layer.
 *   - The contract test is enforcement enough for our purposes:
 *     - Adding, removing, or renaming a field in either file fails CI
 *       until both are updated.
 *     - There is no runtime coupling — the client remains fully
 *       tree-shakeable and the server's `dist/` layout does not change.
 *
 * If you edit anything between the two markers below, update the
 * matching block in `client/src/hooks/taskEventWire.ts` to match, or the
 * contract test will fail.
 * ─────────────────────────────────────────────────────────────────────────
 */

/* WIRE-EVENTS:BEGIN */
export type WireTaskType = 'daily' | 'developmental' | 'routine'
export type WireTaskStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
export type WireRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type WireLogLevel = 'info' | 'warn' | 'error'

export interface WireLogEntry {
  timestamp: string
  message: string
  level: WireLogLevel
}

export interface WireTaskCreatedEvent {
  type: 'task-created'
  taskId: string
  taskType: WireTaskType
}

export interface WireTaskDeletedEvent {
  type: 'task-deleted'
  taskId: string
}

export interface WireTaskStatusEvent {
  type: 'task-status'
  taskId: string
  status: WireTaskStatus
}

export interface WireRunCreatedEvent {
  type: 'run-created'
  taskId: string
  runId: string
}

export interface WireRunStatusEvent {
  type: 'run-status'
  taskId: string
  runId: string
  status: WireRunStatus
  completedAt?: string
  error?: string
}

export interface WireRunLogEvent {
  type: 'run-log'
  taskId: string
  runId: string
  log: WireLogEntry
}

/** Union of every event that MAY appear on the SSE stream. */
export type WireEvent =
  | WireTaskCreatedEvent
  | WireTaskDeletedEvent
  | WireTaskStatusEvent
  | WireRunCreatedEvent
  | WireRunStatusEvent
  | WireRunLogEvent
/* WIRE-EVENTS:END */
