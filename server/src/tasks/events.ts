/**
 * Task run event bus, transport interface, and payload types.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why an interface and not just a concrete class?
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The bus is a small pub/sub the SSE stream endpoint
 * (`/api/tasks/stream`) uses to forward store + executor state transitions
 * to subscribed clients without polling. The store emits when a task or
 * run changes; the executor emits attempt-level lifecycle events.
 *
 * The default implementation (`InProcessTaskRunEventBus`, exported as
 * `TaskRunEventBus` for backwards compatibility) is an in-memory
 * EventEmitter — perfect for a single-process deployment and for tests.
 *
 * **Horizontal scaling** (PRD NFR "worker nodes can be added
 * horizontally") requires that events cross Node process boundaries: a run
 * executed on pod A must reach a client whose SSE connection is held by
 * pod B. That means the transport itself becomes the plug-in point:
 *
 *   Executor (pod A) → publish(event) ─┐
 *                                       ├─→ [Redis Pub/Sub / NATS / …] ─→
 *   SSE handler (pod B) ← subscribe() ─┘        subscribe()
 *
 * The `TaskEventPublisher` and `TaskEventSubscriber` interfaces are the
 * seam. Any transport that can publish an event and register a callback
 * for events implements these; the SSE handler, the store, and the
 * executor all depend on the interfaces (not on the in-process class), so
 * a Redis- or NATS-backed adapter drops in behind them without touching
 * any consumer. An example adapter skeleton is included below in
 * `createRedisRunBus()`-style documentation.
 *
 * Ownership on the wire
 * ─────────────────────
 * Every payload carries a `taskId` — the SSE handler uses that to look up
 * the owning user in the store and filter cross-user events. There is
 * deliberately no `userId` on the events themselves: the store is the
 * single source of truth for ownership, so trusting the event payload
 * would create a second, drift-prone source. This constraint applies to
 * every transport implementation — a Redis-backed adapter MUST NOT try to
 * shortcut ownership by embedding user ids in the payload.
 */
import { EventEmitter } from 'node:events'
import type {
  LogEntry,
  RunStatus,
  TaskStatus,
  TaskType,
} from './types.js'

// ---------------------------------------------------------------------------
// Event payloads — discriminated union keyed on `type`
// ---------------------------------------------------------------------------

/**
 * A single retry attempt is about to begin. Emitted before the executor is
 * invoked so subscribers see queued → running transitions in order.
 */
export interface AttemptStartEvent {
  type: 'attempt-start'
  taskId: string
  runId: string
  attempt: number
  maxAttempts: number
}

/** Attempt completed without throwing — retry loop stops. */
export interface AttemptSucceededEvent {
  type: 'attempt-succeeded'
  taskId: string
  runId: string
  attempt: number
  maxAttempts: number
}

/**
 * Attempt threw an error. `errorMessage` is the raw string from the executor
 * for logging — the SSE surface downgrades it to a generic message before
 * sending to clients to avoid leaking stack details.
 */
export interface AttemptFailedEvent {
  type: 'attempt-failed'
  taskId: string
  runId: string
  attempt: number
  maxAttempts: number
  errorMessage: string
}

/** All configured attempts failed, or the task was deleted mid-retry. */
export interface RunAbandonedEvent {
  type: 'run-abandoned'
  taskId: string
  runId: string
  attempt: number
  maxAttempts: number
  errorMessage?: string
}

/** A new task was created in the store. */
export interface TaskCreatedEvent {
  type: 'task-created'
  taskId: string
  taskType: TaskType
}

/** A task was deleted from the store. */
export interface TaskDeletedEvent {
  type: 'task-deleted'
  taskId: string
}

/** Aggregate task status changed (idle / queued / running / succeeded / failed). */
export interface TaskStatusEvent {
  type: 'task-status'
  taskId: string
  status: TaskStatus
}

/** A new run was created for a task. */
export interface RunCreatedEvent {
  type: 'run-created'
  taskId: string
  runId: string
}

/** A run's status changed (queued → running → succeeded / failed). */
export interface RunStatusEvent {
  type: 'run-status'
  taskId: string
  runId: string
  status: RunStatus
  completedAt?: string
  /** Present when transitioning to 'failed'. Always the sanitized message. */
  error?: string
}

/** A log entry was appended to a run. */
export interface RunLogEvent {
  type: 'run-log'
  taskId: string
  runId: string
  log: LogEntry
}

/**
 * Union of every event the bus can emit. Consumers should switch on `type`
 * to narrow — TypeScript picks the right variant automatically.
 */
export type TaskRunEvent =
  | AttemptStartEvent
  | AttemptSucceededEvent
  | AttemptFailedEvent
  | RunAbandonedEvent
  | TaskCreatedEvent
  | TaskDeletedEvent
  | TaskStatusEvent
  | RunCreatedEvent
  | RunStatusEvent
  | RunLogEvent

// ---------------------------------------------------------------------------
// Transport interfaces — the plug-in seam for a distributed adapter
// ---------------------------------------------------------------------------

/**
 * Publish-side contract. Executors and stores depend on this so the concrete
 * transport (in-process EventEmitter, Redis Pub/Sub, NATS, …) is
 * swappable behind a single method.
 */
export interface TaskEventPublisher {
  emit(event: TaskRunEvent): void
}

/**
 * Subscribe-side contract. The SSE handler depends on this so it can be
 * wired to any transport that can call back on incoming events.
 *
 * Contract:
 * - `on(listener)` returns an unsubscribe function that removes the
 *   listener without affecting sibling subscribers.
 * - Listener errors MUST be caught inside the transport so a misbehaving
 *   subscriber cannot break delivery for others (this is critical for
 *   the SSE endpoint, where a dead socket must not cascade).
 */
export interface TaskEventSubscriber {
  on(listener: (event: TaskRunEvent) => void): () => void
  /** Current subscriber count — useful in tests to assert cleanup. */
  listenerCount(): number
}

/**
 * Combined publisher + subscriber. Consumers that need both (e.g. the SSE
 * router, which subscribes; the store, which publishes) accept this union.
 */
export type TaskRunEventTransport = TaskEventPublisher & TaskEventSubscriber

// ---------------------------------------------------------------------------
// Default in-process implementation
// ---------------------------------------------------------------------------

/**
 * In-process pub/sub backed by Node's EventEmitter. Suitable for a
 * single-process deployment and every test in this repo.
 *
 * For horizontal deployments, replace with a distributed adapter that
 * implements the same `TaskRunEventTransport` shape. A minimal Redis
 * adapter is roughly:
 *
 * ```ts
 * class RedisTaskRunEventBus implements TaskRunEventTransport {
 *   constructor(private pub: RedisClient, private sub: RedisClient,
 *               private channel = 'routini:task-events') {
 *     this.sub.subscribe(channel, (_ch, msg) => this.fanout(JSON.parse(msg)))
 *   }
 *   emit(event: TaskRunEvent) { this.pub.publish(this.channel, JSON.stringify(event)) }
 *   on(l: (e: TaskRunEvent) => void) { this.local.on('event', l); return () => this.local.off('event', l) }
 *   private fanout(e: TaskRunEvent) { for (const l of this.local.listeners('event')) l(e) }
 *   listenerCount() { return this.local.listenerCount('event') }
 * }
 * ```
 *
 * `InProcessTaskRunEventBus` is aliased as `TaskRunEventBus` at the bottom
 * of this file to keep existing imports (`new TaskRunEventBus()`) working
 * without touching call sites.
 */
export class InProcessTaskRunEventBus implements TaskRunEventTransport {
  private readonly emitter = new EventEmitter()

  constructor(maxListeners = 100) {
    // Every SSE client registers exactly one listener. The default of 10
    // would emit a warning long before any realistic saturation, so raise
    // it explicitly. Callers can override for tests.
    this.emitter.setMaxListeners(maxListeners)
  }

  /**
   * Subscribe to events. Returns an unsubscribe function so callers can
   * clean up without needing to keep a reference to the wrapped listener.
   */
  on(listener: (event: TaskRunEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  /**
   * Publish an event. Listener errors are caught and logged so a single
   * misbehaving subscriber cannot break the bus for others — this is
   * critical for the SSE endpoint where a dead socket could otherwise
   * cascade through the whole subscriber set.
   */
  emit(event: TaskRunEvent): void {
    // Snapshot listeners so a listener that unsubscribes during dispatch
    // does not skip a sibling in the same tick.
    const listeners = this.emitter.listeners('event') as Array<
      (event: TaskRunEvent) => void
    >
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[task-events] listener threw', {
          type: event.type,
          taskId: event.taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** Current subscriber count — useful in tests to assert cleanup. */
  listenerCount(): number {
    return this.emitter.listenerCount('event')
  }
}

/**
 * Back-compat alias. Existing callers construct `new TaskRunEventBus()`;
 * that continues to work and gives them the in-process transport. New
 * code that only needs one side of the contract can type against
 * `TaskEventPublisher` / `TaskEventSubscriber` instead so a distributed
 * adapter is a drop-in replacement.
 */
export const TaskRunEventBus = InProcessTaskRunEventBus
export type TaskRunEventBus = InProcessTaskRunEventBus

/**
 * Process-wide default bus.
 *
 * The store, executor, and SSE router all default to this instance so a
 * caller who does not care about wiring gets working end-to-end behavior.
 * Tests and multi-tenant setups can construct isolated buses to avoid
 * cross-suite bleed. Production deployments running more than one Node
 * process MUST swap this for a distributed transport (see class docstring).
 */
export const defaultRunBus: TaskRunEventTransport = new InProcessTaskRunEventBus()
