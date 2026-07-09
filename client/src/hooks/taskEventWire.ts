/**
 * Wire event contract — client-side mirror of the server SoT.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The block between `WIRE-EVENTS:BEGIN` and `WIRE-EVENTS:END` below is
 * required to be byte-for-byte identical to the matching block in
 * `server/src/tasks/wireEvents.ts`. The filesystem contract test
 * (`tests/tasks.wireContract.test.ts`) enforces parity — CI fails until
 * both files agree.
 *
 * Why the copy-and-verify pattern instead of an npm-linked shared package?
 *   - The server (`NodeNext`) and client (`bundler`) resolve TypeScript
 *     modules differently, and setting up project references or a
 *     third workspace package for a single ~40-line file would be
 *     more coupling than value.
 *   - Contract test enforcement gives us drift protection at CI time
 *     without changing the build.
 *
 * If you add / remove / rename any field between the markers below, apply
 * the SAME edit to `server/src/tasks/wireEvents.ts` in the same commit.
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
